import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Claude oturumunun dikkat isteyen son hâli.
 *
 * - `finished`: tur bitti, cevap bekliyor
 * - `asking`: Claude soru sordu (AskUserQuestion / plan onayı)
 */
export type ClaudeTurn = {
    kind: 'finished' | 'asking';
    at: number;
};

/** Kuyruktan çıkan karar: dikkat isteyen tur yoksa `turn` boştur (Claude çalışıyor ya da sıra kullanıcıda değil). */
export type TailVerdict = {
    turn?: ClaudeTurn;
    cwd?: string;
};

type SeenBook = {
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

        if (entry.type === 'user') {
            return { cwd };
        }

        const message = entry.message ?? {};
        const at = Date.parse(entry.timestamp) || 0;
        const content: Array<Record<string, any>> = Array.isArray(message.content) ? message.content : [];

        if (content.some((block) => block.type === 'tool_use' && ASKING_TOOLS.has(block.name))) {
            return { turn: { kind: 'asking', at }, cwd };
        }

        if (message.stop_reason && message.stop_reason !== 'tool_use') {
            return { turn: { kind: 'finished', at }, cwd };
        }

        return { cwd };
    }

    return undefined;
}

/** Claude Code'un proje klasörü adı: harf ve rakam dışı her karakter `-` olur. */
export function encodeProjectPath(folderPath: string): string {
    return folderPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * `~/.claude/projects` altındaki oturum kayıtlarını izler; bitmiş ama
 * bakılmamış Claude işlerini proje bazında tutar. "Bakıldı" bilgisi
 * pencereler arası ortak `claude-seen.json` dosyasındadır.
 */
export class ClaudeWatch extends EventEmitter {
    private readonly root = path.join(os.homedir(), '.claude', 'projects');

    private readonly seenFile: string;

    private readonly files = new Map<string, CachedFile>();

    private pendingByPath = new Map<string, ClaudeTurn>();

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

    /**
     * Verilen projeleri tarar. `lookingAt` odaktaki pencerenin kökleridir:
     * orada biten iş görülmüş sayılır ve işaret konmaz.
     */
    public scan(folderPaths: string[], lookingAt: string[]): void {
        const book = this.readSeen();
        const looking = new Set(lookingAt);
        const dirs = this.listDirs();
        const next = new Map<string, ClaudeTurn>();
        let touched = false;

        for (const folderPath of new Set(folderPaths)) {
            const baseline = book.paths[folderPath] ?? book.since;
            const turn = this.newestTurn(folderPath, dirs, baseline);

            if (!turn) {
                continue;
            }

            if (looking.has(folderPath)) {
                book.paths[folderPath] = Date.now();
                touched = true;

                continue;
            }

            next.set(folderPath, turn);
        }

        if (touched) {
            this.writeSeen(book);
        }

        if (!sameTurns(this.pendingByPath, next)) {
            this.pendingByPath = next;
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

    private newestTurn(folderPath: string, dirs: string[], baseline: number): ClaudeTurn | undefined {
        const encoded = encodeProjectPath(folderPath);
        let newest: ClaudeTurn | undefined;

        for (const dir of dirs) {
            const exact = dir === encoded;

            // Alt klasörde açılan oturumlar `<proje>-alt` adını alır; `pitwall-docs`
            // gibi komşu projeyle karışmasın diye kayıttaki cwd ile doğrulanır.
            if (!exact && !dir.startsWith(`${encoded}-`)) {
                continue;
            }

            for (const verdict of this.verdictsIn(path.join(this.root, dir), baseline)) {
                if (!exact && !verdict.cwd?.startsWith(`${folderPath}/`)) {
                    continue;
                }

                const turn = verdict.turn;

                if (turn && turn.at > baseline && (!newest || turn.at > newest.at)) {
                    newest = turn;
                }
            }
        }

        return newest;
    }

    /** Klasördeki, `baseline` sonrası değişmiş oturumların kararları. */
    private verdictsIn(dir: string, baseline: number): TailVerdict[] {
        const verdicts: TailVerdict[] = [];
        let names: string[];

        try {
            names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
        } catch {
            return verdicts;
        }

        for (const name of names) {
            const file = path.join(dir, name);
            let stat: fs.Stats;

            try {
                stat = fs.statSync(file);
            } catch {
                continue;
            }

            if (stat.mtimeMs <= baseline) {
                continue;
            }

            const cached = this.files.get(file);

            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                if (cached.verdict) {
                    verdicts.push(cached.verdict);
                }

                continue;
            }

            const verdict = readFileTail(file, stat.size);

            this.files.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, verdict });

            if (verdict) {
                verdicts.push(verdict);
            }
        }

        return verdicts;
    }

    private listDirs(): string[] {
        try {
            return fs.readdirSync(this.root);
        } catch {
            return [];
        }
    }

    private readSeen(): SeenBook {
        try {
            const book = JSON.parse(fs.readFileSync(this.seenFile, 'utf8')) as SeenBook;

            if (typeof book.since === 'number' && book.paths && typeof book.paths === 'object') {
                return book;
            }
        } catch {
        }

        const fresh: SeenBook = { since: Date.now(), paths: {} };

        this.writeSeen(fresh);

        return fresh;
    }

    private writeSeen(book: SeenBook): void {
        try {
            fs.writeFileSync(this.seenFile, JSON.stringify(book), 'utf8');
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
