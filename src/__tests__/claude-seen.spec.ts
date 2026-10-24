import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeWatch, encodeProjectPath } from '../claude';

// Hiçbir sistemin vermediği pid: macOS 99999'a, Linux 4194304'e kadar verir.
const DEAD = 0x7ffffffe;
const PROJECT = '/Users/me/projects/paddock';

let home: string;
let storage: string;
// `os.homedir()` Windows'ta USERPROFILE'ı, ötekilerde HOME'u okur.
const HOME_VARS = ['HOME', 'USERPROFILE'] as const;
let realHome: Partial<Record<(typeof HOME_VARS)[number], string>>;

beforeEach(() => {
    realHome = Object.fromEntries(HOME_VARS.map((name) => [name, process.env[name]]));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-seen-'));
    storage = path.join(home, 'storage');
    fs.mkdirSync(storage);
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'projects', encodeProjectPath(PROJECT)), { recursive: true });
    fs.writeFileSync(path.join(storage, 'claude-seen.json'), JSON.stringify({ since: 0, paths: {} }));
    // ClaudeWatch `~/.claude` yolunu kurulurken alır.
    for (const name of HOME_VARS) {
        process.env[name] = home;
    }
});

afterEach(() => {
    for (const name of HOME_VARS) {
        if (realHome[name] === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = realHome[name];
        }
    }

    fs.rmSync(home, { recursive: true, force: true });
});

/** Oturum kaydına tek satır yazar, dosyanın zamanı satırınki olur. */
function log(id: string, at: number, entry: Record<string, unknown>): void {
    const file = path.join(home, '.claude', 'projects', encodeProjectPath(PROJECT), `${id}.jsonl`);

    fs.writeFileSync(file, `${JSON.stringify({ ...entry, timestamp: new Date(at).toISOString() })}\n`);
    fs.utimesSync(file, new Date(at), new Date(at + 50));
}

const finished = { type: 'assistant', message: { stop_reason: 'end_turn' } };
const planShown = { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] } };

/** Claude Code'un çalışan oturum kaydı (`~/.claude/sessions/<pid>.json`). */
function running(id: string, pid: number, status: string, since: number): void {
    fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: id, status, statusUpdatedAt: since }));
}

function seenAt(): number | undefined {
    return JSON.parse(fs.readFileSync(path.join(storage, 'claude-seen.json'), 'utf8')).paths[PROJECT];
}

describe('markSeen', () => {
    // Bir oturuma bakmak, Claude'u hâlâ izin bekleyen başka oturumun istemini gizlememeli:
    // ortak kayıt en büyük zamanla birleşir, uygulama da istemi artık haber vermez.
    it('çalışan oturumun açık istemini geçmez: yazılan an istemin öncesidir', () => {
        const prompt = Date.now() - 60_000;

        log('istemde', prompt - 60_000, { type: 'user' });
        running('istemde', process.pid, 'waiting', prompt);
        log('eski', prompt - 60_000, finished);
        log('biten', prompt + 30_000, finished);

        const watch = new ClaudeWatch(storage);

        watch.scan([PROJECT], []);
        expect(watch.pendingFor(PROJECT)?.kind).toBe('finished');

        watch.markSeen(PROJECT);

        // İstemden önce biten tur görülür.
        expect(seenAt()).toBeLessThan(prompt);
        expect(seenAt()).toBeGreaterThan(prompt - 60_000);
        // İstem ve ondan sonra biten tur bakılmamış kalır.
        watch.scan([PROJECT], []);
        expect(watch.pendingFor(PROJECT)).toEqual({ kind: 'finished', at: prompt + 30_000 });
    });

    // Süreci gitmiş Claude'un sorusunu cevaplayacak kimse yok: sonsuza dek beklememeli.
    it('süreci gitmiş oturumun sorusu bakılınca görülür', () => {
        const asked = Date.now() - 60_000;

        log('giden', asked, planShown);
        running('giden', DEAD, 'waiting', asked);

        const watch = new ClaudeWatch(storage);

        watch.scan([PROJECT], []);
        expect(watch.pendingFor(PROJECT)?.kind).toBe('asking');

        watch.markSeen(PROJECT);

        expect(seenAt()).toBeGreaterThan(asked);
        watch.scan([PROJECT], []);
        expect(watch.pendingFor(PROJECT)).toBeUndefined();
    });
});

describe('scan', () => {
    it('odaktaki pencere biten turu görülmüş yazarken çalışan oturumun açık istemini geçmez', () => {
        const prompt = Date.now() - 60_000;

        log('istemde', prompt - 60_000, { type: 'user' });
        running('istemde', process.pid, 'waiting', prompt);
        log('biten', prompt + 30_000, finished);

        const watch = new ClaudeWatch(storage);

        watch.scan([PROJECT], [PROJECT]);
        const at = seenAt();

        expect(at).toBeLessThan(prompt);

        // Yeniden yazmaz: kayıt dosyası her taramada değişmez.
        const written = fs.statSync(path.join(storage, 'claude-seen.json')).mtimeMs;

        watch.scan([PROJECT], [PROJECT]);
        expect(seenAt()).toBe(at);
        expect(fs.statSync(path.join(storage, 'claude-seen.json')).mtimeMs).toBe(written);
    });
});
