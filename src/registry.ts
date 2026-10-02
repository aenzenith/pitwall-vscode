import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import { writeAtomic } from './storage';

/**
 * Satırda gösterilecek sorun notu.
 *
 * - `crashed`: süreç kendi kendine düştü
 * - `error`: çıktıda hata satırı görüldü, sunucu ayakta olabilir
 * - `unresponsive`: süreç var ama port cevap vermiyor
 */
export type ProjectIssue = {
    kind: 'crashed' | 'error' | 'unresponsive';
    text: string;
};

/** Bir projenin o andaki durumu. */
export type ProjectState = {
    folderPath: string;
    name: string;
    running: boolean;
    port?: number;
    url?: string;
    startedAt?: number;
    issue?: ProjectIssue;
    /** Çalışırken: çıktının yansıdığı dosya, kayıt klasörüne göre (`output/<windowId>/….log`). */
    output?: string;
};

/** Bir VSCode penceresinin paylaştığı kayıt. */
export type WindowRecord = {
    windowId: string;
    title: string;
    updatedAt: number;
    projects: ProjectState[];
    /** Bu pencerede gerçekten açık olan kök klasörler. Eski sürümlerde yok. */
    roots?: string[];
    /**
     * start/stop/restart dışında anladığı emirler. Eski sürümler bilmediği emri `start` sayar;
     * o yüzden yeni bir emir yalnız onu burada ilan eden katılımcıya gönderilir.
     */
    features?: string[];
    /** Terminallerinin kabuk pid'leri: terminalde çalışan bir Claude oturumunun yerini bulmak için. */
    terminals?: number[];
};

/**
 * Kaydın sahiplendiği projeler. `roots` yoksa (eski sürüm) kayıt favorileri de
 * kendi projesi gibi yayınlamış olabilir; o yüzden yalnız gerçekten çalışanlar sayılır.
 */
export function ownedProjects(record: WindowRecord): ProjectState[] {
    if (Array.isArray(record.roots)) {
        return record.projects.filter(
            (project) => record.roots?.includes(project.folderPath) || project.running,
        );
    }

    return record.projects.filter((project) => project.running);
}

/** Başka pencereye gönderilen komut. */
export type RemoteCommand = {
    target: string;
    action: 'start' | 'stop' | 'restart' | 'reveal-claude';
    folderPath: string;
    issuedBy: string;
    issuedAt: number;
    /** `reveal-claude`: öne getirilecek Claude oturumu. */
    sessionId?: string;
    /** `reveal-claude`: oturum bir terminalde çalışıyorsa o terminalin kabuk pid'i. */
    terminalPid?: number;
};

/** Bu sürümün start/stop/restart dışında anladığı emirler (bkz. `WindowRecord.features`). */
export const FEATURES = ['reveal-claude'];

export type Favorite = {
    path: string;
    name: string;
};

const HEARTBEAT_MS = 5000;
const STALE_MS = 20000;
const COMMAND_TTL_MS = 30000;

/**
 * Pencereler arası ortak defter, `~/.pitwall/` (bkz. `sharedDir`): aynı makinedeki her
 * VS Code, Cursor ve Insiders penceresi ile Pitwall uygulaması aynı dizini görür.
 *
 * - `windows/<id>.json` — her pencerenin kendi durumu (kalp atışıyla tazelenir)
 * - `commands/<hedef>__<ts>.json` — başka pencereye iş emri
 * - `favorites.json` — penceresi kapalı olsa da listede duran projeler
 */
export class Registry extends EventEmitter {
    public readonly windowId: string;

    private readonly windowsDir: string;

    private readonly commandsDir: string;

    private readonly favoritesFile: string;

    private readonly pidsDir: string;

    private readonly outputDir: string;

    private readonly watchers: fs.FSWatcher[] = [];

    private heartbeat?: ReturnType<typeof setInterval>;

    private own: WindowRecord;

    private notifyTimer?: ReturnType<typeof setTimeout>;

    public constructor(storageDir: string, title: string) {
        super();

        this.windowId = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
        this.windowsDir = path.join(storageDir, 'windows');
        this.commandsDir = path.join(storageDir, 'commands');
        this.favoritesFile = path.join(storageDir, 'favorites.json');
        this.pidsDir = path.join(storageDir, 'pids');
        this.outputDir = path.join(storageDir, 'output');
        this.own = {
            windowId: this.windowId,
            title,
            updatedAt: Date.now(),
            projects: [],
            roots: [],
            features: FEATURES,
            terminals: [],
        };

        fs.mkdirSync(this.windowsDir, { recursive: true });
        fs.mkdirSync(this.commandsDir, { recursive: true });
        fs.mkdirSync(this.pidsDir, { recursive: true });

        this.writeOwn();
        this.sweep();

        this.heartbeat = setInterval(() => this.writeOwn(), HEARTBEAT_MS);
        this.watch(this.windowsDir, () => this.scheduleNotify());
        this.watch(this.commandsDir, () => this.drainCommands());
        this.watch(storageDir, (file) => {
            if (file === 'favorites.json') {
                this.scheduleNotify();
            }
        });
    }

    /** Bu pencerenin projelerini günceller ve diğer pencerelere duyurur. */
    public publish(projects: ProjectState[], roots: string[]): void {
        this.own = { ...this.own, projects, roots, updatedAt: Date.now() };
        this.writeOwn();
        this.scheduleNotify();
    }

    /** Terminallerin kabuk pid'lerini duyurur. */
    public publishTerminals(pids: number[]): void {
        this.own = { ...this.own, terminals: pids, updatedAt: Date.now() };
        this.writeOwn();
    }

    /** Bu pencere dahil, canlı bütün pencerelerin kayıtları. */
    public readWindows(): WindowRecord[] {
        const now = Date.now();
        const records: WindowRecord[] = [];

        for (const file of this.listJson(this.windowsDir)) {
            const record = readJson<WindowRecord>(path.join(this.windowsDir, file));

            if (!record || !record.windowId) {
                continue;
            }

            if (record.windowId === this.windowId) {
                records.push(this.own);

                continue;
            }

            if (now - record.updatedAt <= STALE_MS) {
                records.push(record);
            }
        }

        if (!records.some((record) => record.windowId === this.windowId)) {
            records.push(this.own);
        }

        return records;
    }

    /** Başka pencerelerin (bu hariç) kayıtları. */
    public readPeers(): WindowRecord[] {
        return this.readWindows().filter((record) => record.windowId !== this.windowId);
    }

    /** Verilen klasörü açık tutan pencereyi bulur. */
    public findWindowFor(folderPath: string): WindowRecord | undefined {
        return this.readPeers().find((record) =>
            ownedProjects(record).some((project) => project.folderPath === folderPath),
        );
    }

    /**
     * Klasörü şu an çalıştıran başka katılımcı (VS Code penceresi ya da Pitwall uygulaması).
     * Bu penceredeki bir kök orada çalışıyorsa satır onun durumunu gösterir, düğmeler ona gider.
     */
    public findRunnerFor(folderPath: string): { record: WindowRecord; project: ProjectState } | undefined {
        for (const record of this.readPeers()) {
            const project = record.projects.find((item) => item.folderPath === folderPath && item.running);

            if (project) {
                return { record, project };
            }
        }

        return undefined;
    }

    /** Başka pencereye iş emri bırakır. */
    public send(command: Omit<RemoteCommand, 'issuedBy' | 'issuedAt'>): void {
        const payload: RemoteCommand = { ...command, issuedBy: this.windowId, issuedAt: Date.now() };
        const file = path.join(this.commandsDir, `${command.target}__${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);

        try {
            writeAtomic(file, JSON.stringify(payload));
        } catch {
        }
    }

    /**
     * Bu pencerenin çalıştırdığı süreçlerin pid'lerini yazar.
     * Eklenti çökerse `deactivate` koşmaz; bu dosya sayesinde bir sonraki
     * oturum öksüz kalan sunucuları bulup kapatabilir.
     */
    public recordPids(entries: Array<{ path: string; pid: number }>): void {
        const file = path.join(this.pidsDir, `${this.windowId}.json`);

        try {
            if (entries.length === 0) {
                safeUnlink(file);

                return;
            }

            writeAtomic(file, JSON.stringify({ windowId: this.windowId, entries }));
        } catch {
        }
    }

    /**
     * Ölü pencerelerin bıraktığı süreçleri döner ve kayıtlarını siler.
     * Canlı pencerelerin kayıtlarına dokunulmaz.
     */
    public takeOrphans(): Array<{ path: string; pid: number }> {
        const live = new Set(this.readWindows().map((record) => record.windowId));
        const orphans: Array<{ path: string; pid: number }> = [];

        for (const file of this.listJson(this.pidsDir)) {
            const full = path.join(this.pidsDir, file);
            const record = readJson<{ windowId: string; entries: Array<{ path: string; pid: number }> }>(full);

            if (!record) {
                safeUnlink(full);

                continue;
            }

            if (live.has(record.windowId)) {
                continue;
            }

            orphans.push(...(record.entries ?? []));
            safeUnlink(full);
        }

        return orphans;
    }

    public readFavorites(): Favorite[] {
        return readJson<Favorite[]>(this.favoritesFile) ?? [];
    }

    public toggleFavorite(favorite: Favorite): boolean {
        const current = this.readFavorites();
        const exists = current.some((item) => item.path === favorite.path);
        const next = exists
            ? current.filter((item) => item.path !== favorite.path)
            : [...current, favorite].sort((a, b) => a.name.localeCompare(b.name, 'tr'));

        try {
            writeAtomic(this.favoritesFile, JSON.stringify(next, null, 2));
        } catch {
            return exists;
        }

        this.scheduleNotify();

        return !exists;
    }

    public dispose(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
        }

        for (const watcher of this.watchers) {
            watcher.close();
        }

        safeUnlink(this.ownFile());
        safeUnlink(path.join(this.pidsDir, `${this.windowId}.json`));
        safeRemoveDir(path.join(this.outputDir, this.windowId));
    }

    private ownFile(): string {
        return path.join(this.windowsDir, `${this.windowId}.json`);
    }

    private writeOwn(): void {
        this.own.updatedAt = Date.now();

        try {
            writeAtomic(this.ownFile(), JSON.stringify(this.own));
        } catch {
        }
    }

    /** Ölü pencere kayıtlarını, bayatlamış emirleri ve kaydı kalmamış katılımcıların çıktılarını siler. */
    private sweep(): void {
        const now = Date.now();

        for (const file of this.listJson(this.windowsDir)) {
            const full = path.join(this.windowsDir, file);
            const record = readJson<WindowRecord>(full);

            if (!record || now - record.updatedAt > STALE_MS * 3) {
                safeUnlink(full);
            }
        }

        for (const file of this.listJson(this.commandsDir)) {
            const full = path.join(this.commandsDir, file);
            const command = readJson<RemoteCommand>(full);

            if (!command || now - command.issuedAt > COMMAND_TTL_MS) {
                safeUnlink(full);
            }
        }

        let owners: string[] = [];

        try {
            owners = fs.readdirSync(this.outputDir);
        } catch {
        }

        for (const owner of owners) {
            if (!fs.existsSync(path.join(this.windowsDir, `${owner}.json`))) {
                safeRemoveDir(path.join(this.outputDir, owner));
            }
        }
    }

    /** Bize gelen emirleri okur, dosyayı siler ve `command` olayını yayar. */
    private drainCommands(): void {
        const now = Date.now();

        for (const file of this.listJson(this.commandsDir)) {
            if (!file.startsWith(`${this.windowId}__`)) {
                continue;
            }

            const full = path.join(this.commandsDir, file);
            const command = readJson<RemoteCommand>(full);

            safeUnlink(full);

            if (command && now - command.issuedAt <= COMMAND_TTL_MS) {
                this.emit('command', command);
            }
        }
    }

    private listJson(dir: string): string[] {
        try {
            return fs.readdirSync(dir).filter((file) => file.endsWith('.json'));
        } catch {
            return [];
        }
    }

    private watch(dir: string, onEvent: (file: string) => void): void {
        try {
            const watcher = fs.watch(dir, (_event, filename) => onEvent(String(filename ?? '')));

            this.watchers.push(watcher);
        } catch {
        }
    }

    /** Dosya olayları salkım hâlinde gelir; tek tazelemeye indirir. */
    private scheduleNotify(): void {
        if (this.notifyTimer) {
            clearTimeout(this.notifyTimer);
        }

        this.notifyTimer = setTimeout(() => {
            this.notifyTimer = undefined;
            this.emit('changed');
        }, 150);
    }
}

function readJson<T>(file: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

function safeRemoveDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
}

function safeUnlink(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch {
    }
}
