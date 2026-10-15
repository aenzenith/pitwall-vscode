import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { processAlive } from './registry';
import { writeAtomic } from './storage';

/**
 * Claude oturumunun dikkat isteyen son hâli.
 *
 * - `finished`: tur bitti, cevap bekliyor
 * - `asking`: Claude soru sordu (AskUserQuestion / plan onayı)
 * - `permission`: Claude Code bir izin istemi açtı, cevabını bekliyor
 */
export type ClaudeTurn = {
    kind: 'finished' | 'asking' | 'permission';
    at: number;
};

/** Oturumun o anki hâli: çalışıyor, seni bekliyor ya da ikisi de değil. */
export type SessionPhase = 'working' | 'waiting' | 'idle';

/**
 * Claude Code'un çalışan bir oturum için kendi yazdığı durum (`~/.claude/sessions/<pid>.json`):
 * `busy` (işte, arka planda bıraktığı alt ajanlar dahil), `waiting` (izin istemi ya da soru
 * açık), `idle`, `shell` (boşta, arka planda bir komutu sürüyor). `since`: durumun değiştiği an.
 */
export type LiveStatus = {
    status: string;
    since?: number;
};

/** Turu bitmemiş oturum bu kadar yakında yazıldıysa çalışıyor sayılır. */
export const WORKING_WINDOW_MS = 5 * 60 * 1000;

/** Kuyruktan çıkan karar: dikkat isteyen tur yoksa `turn` boştur (Claude çalışıyor ya da sıra kullanıcıda değil). */
export type TailVerdict = {
    turn?: ClaudeTurn;
    cwd?: string;
    /** Karar veren satırın zamanı. Tur sürüyorsa tur en geç o an başlamıştır (`sessionPhase`). */
    at?: number;
};

export type SeenBook = {
    /** Özelliğin ilk açıldığı an; daha eski işler bakılmış sayılır. */
    since: number;
    paths: Record<string, number>;
};

type CachedFile = {
    mtimeMs: number;
    size: number;
    verdict?: TailVerdict;
};

const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Windows'ta yollar büyük/küçük harf duyarsızdır ve VS Code sürücü harfini
 * küçük verir (`c:\…`), Claude ise büyük yazar (`C:\…`). Karşılaştırma bu
 * biçimde yapılır.
 */
const foldCase = process.platform === 'win32' ? (value: string): string => value.toLowerCase() : (value: string): string => value;
const TAIL_START = 64 * 1024;
const TAIL_MAX = 4 * 1024 * 1024;

/**
 * Oturum kaydının son satırlarından turun durumunu çıkarır.
 * Yan dal (alt ajan) ve meta kayıtları atlanır. Karar veren satır yoksa `undefined`.
 */
export function readTail(lines: string[]): TailVerdict | undefined {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();

        if (!line) {
            continue;
        }

        let entry: Record<string, any>;

        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }

        if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain || entry.isMeta) {
            continue;
        }

        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        const at = Date.parse(entry.timestamp) || undefined;

        if (entry.type === 'user') {
            return { cwd, at };
        }

        const message = entry.message ?? {};
        const content: Array<Record<string, any>> = Array.isArray(message.content) ? message.content : [];

        if (content.some((block) => block.type === 'tool_use' && ASKING_TOOLS.has(block.name))) {
            return { turn: { kind: 'asking', at: at ?? 0 }, cwd, at };
        }

        if (message.stop_reason && message.stop_reason !== 'tool_use') {
            return { turn: { kind: 'finished', at: at ?? 0 }, cwd, at };
        }

        return { cwd, at };
    }

    return undefined;
}

/**
 * Bir oturumun hâli; Pitwall uygulamasının kararıyla aynı (`claude.rs`: `log_state`, hook'un
 * izin ve soru beklemesi). `modified`: kaydın son yazıldığı an; `baseline`: projeye son
 * bakılan an; `recent`: şimdiden `WORKING_WINDOW_MS` öncesi; `live`: Claude Code'un kendi sözü,
 * süreci çalışıyorsa.
 *
 * - Açık istem (`waiting`): bakıldıktan sonra açıldıysa bekliyor. Uygulama bunu hook
 *   olaylarından öğrenir; eklenti onları göremez, aynı anı Claude Code'un kendi sözünden alır.
 * - Bitmiş tur, Claude Code oturumu meşgul (`busy`) derken bitmemiştir: arka planda bıraktığı
 *   alt ajanlar çalışıyordur, sonuçlarını kendisi alıp devam eder.
 * - Bakıldıktan sonra biten ya da soru soran tur bekliyor.
 * - Süren tur, Claude Code oturuma o turun başından (kayıttaki son satırının zamanından)
 *   itibaren boşta (`idle`, `shell`) dediyse bitmiştir: kullanıcı kesti (Esc), `Stop` gelmez.
 *   Sessizce biter: bekleyen tur da turuncu nokta da yok. Turun başından önce yazılmış söz (yeni
 *   istem için dosya henüz yazılmamış) bir şey değiştirmez.
 * - Turu sürerken meşgulse ya da son 5 dakikada yazıldıysa çalışıyor: tek bir araç çağrısı,
 *   kayda satır düşmeden bundan uzun sürebilir.
 */
export function sessionPhase(
    verdict: TailVerdict,
    modified: number,
    baseline: number,
    recent: number,
    live?: LiveStatus,
): { phase: SessionPhase; turn?: ClaudeTurn } {
    const turn = verdict.turn;

    if (live?.status === 'waiting') {
        const since = live.since ?? modified;

        if (since > baseline) {
            return { phase: 'waiting', turn: { kind: turn?.kind === 'asking' ? 'asking' : 'permission', at: since } };
        }

        return { phase: Math.max(since, modified) > recent ? 'working' : 'idle' };
    }

    const busy = live?.status === 'busy';

    if (turn && busy && turn.kind === 'finished') {
        return { phase: 'working' };
    }

    if (turn && turn.at > baseline) {
        return { phase: 'waiting', turn };
    }

    const interrupted = resting(live) && live?.since !== undefined && verdict.at !== undefined && live.since >= verdict.at;

    if (!turn && (busy || (modified > recent && !interrupted))) {
        return { phase: 'working' };
    }

    return { phase: 'idle' };
}

/** Claude Code bu uzunluğu geçen klasör adını keser ve sonuna yolun özetini ekler. */
const MAX_PROJECT_NAME = 200;

/**
 * Claude Code'un proje klasörü adı: harf ve rakam dışı her UTF-16 birimi `-` olur. 200'ü geçen
 * ad orada kesilir, arkasına `-` ve yolun özeti (36 tabanında) gelir; uygulamadaki
 * `encode_project_path` ile aynı. Yanlış ad o projenin bütün oturumlarını sessizce kaybeder.
 */
export function encodeProjectPath(folderPath: string): string {
    const name = folderPath.replace(/[^a-zA-Z0-9]/g, '-');

    if (name.length <= MAX_PROJECT_NAME) {
        return name;
    }

    return `${name.slice(0, MAX_PROJECT_NAME)}-${Math.abs(pathHash(folderPath)).toString(36)}`;
}

/** Claude Code'un yol özeti: UTF-16 birimleri üzerinde 32 bitte `hash * 31 + birim`. */
function pathHash(folderPath: string): number {
    let hash = 0;

    for (let index = 0; index < folderPath.length; index += 1) {
        hash = (Math.imul(hash, 31) + folderPath.charCodeAt(index)) | 0;
    }

    return hash;
}

/** Bir oturum kaydı: kimliği, son yazıldığı an ve son satırlarından çıkan karar. */
type SessionLog = {
    id: string;
    modified: number;
    verdict?: TailVerdict;
};

/** Bir projedeki oturumun hâli ve beklediği tur; `fromLog`: bekleyişi kaydın son satırı söyledi. */
type SessionState = {
    phase: SessionPhase;
    turn?: ClaudeTurn;
    fromLog: boolean;
};

/**
 * `~/.claude/projects` altındaki oturum kayıtlarını ve Claude Code'un çalışan oturumlarının
 * durumunu izler; proje başına Claude'un seni beklediği son işi ve çalışıp çalışmadığını tutar.
 * "Bakıldı" bilgisi pencereler arası ortak `claude-seen.json` dosyasındadır.
 */
export class ClaudeWatch extends EventEmitter {
    private readonly root = path.join(os.homedir(), '.claude', 'projects');

    /** Claude Code'un çalışan oturum kayıtları: `<pid>.json`. */
    private readonly sessionsDir = path.join(os.homedir(), '.claude', 'sessions');

    private readonly seenFile: string;

    private readonly files = new Map<string, CachedFile>();

    private pendingByPath = new Map<string, ClaudeTurn>();

    private working = new Set<string>();

    public constructor(storageDir: string) {
        super();

        this.seenFile = path.join(storageDir, 'claude-seen.json');
    }

    /** Projenin bakılmamış son işi. */
    public pendingFor(folderPath: string): ClaudeTurn | undefined {
        return this.pendingByPath.get(folderPath);
    }

    public pendingPaths(): string[] {
        return [...this.pendingByPath.keys()];
    }

    /** Projede Claude çalışıyor, seni beklemiyor. */
    public isWorking(folderPath: string): boolean {
        return this.working.has(folderPath);
    }

    /**
     * Verilen projeleri tarar. Bir projede seni bekleyen iş varsa o (en yenisi), yoksa çalışan
     * bir oturum varsa "çalışıyor" tutulur. `lookingAt` odaktaki pencerenin kökleridir: orada
     * biten ya da soru soran tur görülmüş sayılır, seni bekleyen hiçbir şeye işaret konmaz.
     */
    public scan(folderPaths: string[], lookingAt: string[]): void {
        const book = this.readSeen();
        const looking = new Set(lookingAt);
        const dirs = this.listDirs();
        const live = this.liveSessions();
        const now = Date.now();
        const recent = now - WORKING_WINDOW_MS;
        const next = new Map<string, ClaudeTurn>();
        const working = new Set<string>();
        let touched = false;

        for (const folderPath of new Set(folderPaths)) {
            const baseline = book.paths[folderPath] ?? book.since;
            let states = this.statesFor(folderPath, dirs, baseline, recent, live);

            if (looking.has(folderPath)) {
                if (states.some((state) => state.phase === 'waiting' && state.fromLog)) {
                    book.paths[folderPath] = now;
                    touched = true;
                    states = this.statesFor(folderPath, dirs, now, recent, live);
                }

                // Açık istem görülmüş yazılmaz (uygulama onu yine haber verir), yalnız burada işaret konmaz.
                states = states.filter((state) => state.phase !== 'waiting');
            }

            const turn = newestWaiting(states);

            if (turn) {
                next.set(folderPath, turn);
            } else if (states.some((state) => state.phase === 'working')) {
                working.add(folderPath);
            }
        }

        if (touched) {
            this.writeSeen(book);
        }

        if (!sameTurns(this.pendingByPath, next) || !sameSet(this.working, working)) {
            this.pendingByPath = next;
            this.working = working;
            this.emit('changed');
        }
    }

    /** Projedeki işi bakılmış sayar. */
    public markSeen(folderPath: string): void {
        const book = this.readSeen();

        book.paths[folderPath] = Date.now();
        this.writeSeen(book);

        if (this.pendingByPath.delete(folderPath)) {
            this.emit('changed');
        }
    }

    /**
     * Projenin oturumlarının hâli. Bakıldıktan ve son 5 dakikadan önce yazılmış kayıt atlanır;
     * Claude Code'un meşgul ya da istem açık dediği oturum ne zaman yazılmış olursa olsun
     * sayılır: alt ajanları kendi kayıtlarına yazar.
     */
    private statesFor(folderPath: string, dirs: string[], baseline: number, recent: number, live: Map<string, LiveStatus>): SessionState[] {
        const encoded = foldCase(encodeProjectPath(folderPath));
        const inside = foldCase(folderPath + path.sep);
        const since = Math.min(baseline, recent);
        const states: SessionState[] = [];

        for (const dir of dirs) {
            const name = foldCase(dir);
            const exact = name === encoded;

            // Alt klasörde açılan oturumlar `<proje>-alt` adını alır; `pitwall-docs`
            // gibi komşu projeyle karışmasın diye kayıttaki cwd ile doğrulanır.
            if (!exact && !name.startsWith(`${encoded}-`)) {
                continue;
            }

            for (const log of this.logsIn(path.join(this.root, dir), since, live)) {
                const status = live.get(log.id);
                // Kararı olmayan kayıt (yalnız meta satırlar) Claude Code'un sözüyle değerlendirilir.
                const verdict = log.verdict ?? (exact && followed(status) ? {} : undefined);

                if (!verdict || (!exact && !(verdict.cwd && foldCase(verdict.cwd).startsWith(inside)))) {
                    continue;
                }

                const { phase, turn } = sessionPhase(verdict, log.modified, baseline, recent, status);

                states.push({ phase, turn, fromLog: status?.status !== 'waiting' });
            }
        }

        return states;
    }

    /**
     * Klasördeki, `since` sonrası yazılmış ya da Claude Code'un meşgul veya istem açık dediği
     * oturumların kayıtları.
     */
    private logsIn(dir: string, since: number, live: Map<string, LiveStatus>): SessionLog[] {
        const logs: SessionLog[] = [];
        let names: string[];

        try {
            names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
        } catch {
            return logs;
        }

        for (const name of names) {
            const id = name.slice(0, -'.jsonl'.length);
            const file = path.join(dir, name);
            let stat: fs.Stats;

            try {
                stat = fs.statSync(file);
            } catch {
                continue;
            }

            if (stat.mtimeMs <= since && !followed(live.get(id))) {
                continue;
            }

            const cached = this.files.get(file);
            let verdict = cached?.verdict;

            if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
                verdict = readFileTail(file, stat.size);

                this.files.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, verdict });
            }

            logs.push({ id, modified: stat.mtimeMs, verdict });
        }

        return logs;
    }

    /**
     * Süreci yaşayan oturumların Claude Code'daki durumu (`busy`, `waiting`, `idle`, `shell`),
     * kimlikleriyle. Kayıttan yalnız `pid`, `sessionId`, `status` ve `statusUpdatedAt` alınır;
     * başka hiçbir alan tutulmaz.
     */
    private liveSessions(): Map<string, LiveStatus> {
        const live = new Map<string, LiveStatus>();
        let names: string[];

        try {
            names = fs.readdirSync(this.sessionsDir).filter((name) => name.endsWith('.json'));
        } catch {
            return live;
        }

        for (const name of names) {
            try {
                const { pid, sessionId, status, statusUpdatedAt } = JSON.parse(
                    fs.readFileSync(path.join(this.sessionsDir, name), 'utf8'),
                );

                if (
                    (status === 'busy' || status === 'waiting' || status === 'idle' || status === 'shell') &&
                    typeof sessionId === 'string' &&
                    Number.isSafeInteger(pid) &&
                    pid > 0 &&
                    processAlive(pid)
                ) {
                    live.set(sessionId, {
                        status,
                        since: Number.isFinite(statusUpdatedAt) ? statusUpdatedAt : undefined,
                    });
                }
            } catch {
            }
        }

        return live;
    }

    private listDirs(): string[] {
        try {
            return fs.readdirSync(this.root);
        } catch {
            return [];
        }
    }

    private readSeen(): SeenBook {
        const book = readSeenFile(this.seenFile);

        if (book) {
            return book;
        }

        const fresh: SeenBook = { since: Date.now(), paths: {} };

        this.writeSeen(fresh);

        return fresh;
    }

    /**
     * Kaydı başka pencereler ve Pitwall uygulaması da yazar. Okuduğumuzdan beri yazılmış
     * olanı ezmemek için diskteki kayıtla birleştirilip yazılır.
     */
    private writeSeen(book: SeenBook): void {
        try {
            writeAtomic(this.seenFile, JSON.stringify(mergeSeen(readSeenFile(this.seenFile), book)));
        } catch {
        }
    }
}

/**
 * Dosyanın sonundan okur; karar veren satır yoksa pencereyi büyütür.
 * Araç çıktıları tek satırda yüzlerce KB olabildiği için sabit kuyruk yetmez.
 */
function readFileTail(file: string, size: number): TailVerdict | undefined {
    let fd: number;

    try {
        fd = fs.openSync(file, 'r');
    } catch {
        return undefined;
    }

    try {
        for (let span = TAIL_START; ; span *= 4) {
            const length = Math.min(span, size);
            const buffer = Buffer.alloc(length);

            fs.readSync(fd, buffer, 0, length, size - length);

            const lines = buffer.toString('utf8').split('\n');

            if (length < size) {
                lines.shift();
            }

            const verdict = readTail(lines);

            if (verdict || length >= size || span >= TAIL_MAX) {
                return verdict;
            }
        }
    } catch {
        return undefined;
    } finally {
        fs.closeSync(fd);
    }
}

function readSeenFile(file: string): SeenBook | undefined {
    try {
        const book = JSON.parse(fs.readFileSync(file, 'utf8')) as SeenBook;

        if (typeof book.since === 'number' && book.paths && typeof book.paths === 'object') {
            return book;
        }
    } catch {
    }

    return undefined;
}

/**
 * İki "görüldü" kaydını birleştirir: proje başına büyük zaman, başlangıç olarak küçük olan.
 * Bir taraf geride kalsa bile kimsenin "baktım" bilgisi kaybolmaz.
 */
export function mergeSeen(disk: SeenBook | undefined, mine: SeenBook): SeenBook {
    if (!disk) {
        return mine;
    }

    const paths: Record<string, number> = { ...disk.paths };

    for (const [folderPath, at] of Object.entries(mine.paths)) {
        paths[folderPath] = Math.max(paths[folderPath] ?? 0, at);
    }

    // Başka katılımcının eklediği alanlar olduğu gibi kalır (PROTOCOL.md, kural 4).
    return { ...disk, since: Math.min(disk.since, mine.since), paths };
}

/** Claude Code oturumu işte ya da istem açık diyor: kaydı ne zaman yazılmış olursa olsun izlenir. */
function followed(live: LiveStatus | undefined): boolean {
    return live?.status === 'busy' || live?.status === 'waiting';
}

/** Claude Code oturumu boşta diyor (`shell`: arka planda bir komutu sürüyor). */
function resting(live: LiveStatus | undefined): boolean {
    return live?.status === 'idle' || live?.status === 'shell';
}

/** Bekleyen turların en yenisi. */
function newestWaiting(states: SessionState[]): ClaudeTurn | undefined {
    let newest: ClaudeTurn | undefined;

    for (const { phase, turn } of states) {
        if (phase === 'waiting' && turn && (!newest || turn.at > newest.at)) {
            newest = turn;
        }
    }

    return newest;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
    return a.size === b.size && [...a].every((item) => b.has(item));
}

function sameTurns(a: Map<string, ClaudeTurn>, b: Map<string, ClaudeTurn>): boolean {
    if (a.size !== b.size) {
        return false;
    }

    for (const [key, turn] of a) {
        const other = b.get(key);

        if (!other || other.kind !== turn.kind || other.at !== turn.at) {
            return false;
        }
    }

    return true;
}
