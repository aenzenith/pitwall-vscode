import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Registry } from '../registry';

// Hiçbir sistemin vermediği pid: macOS 99999'a, Linux 4194304'e kadar verir.
const DEAD = (0x7ffffffe).toString(36);
const ALIVE = process.pid.toString(36);

let root: string;
let registry: Registry;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-orphans-'));
    registry = new Registry(root, 'test');
});

afterEach(() => {
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
});

/** Katılımcının pid dosyasını, yaşı verilmişse kaydını da yazar. */
function participant(windowId: string, pids: number[], ageMs?: number): string {
    if (ageMs !== undefined) {
        fs.writeFileSync(
            path.join(root, 'windows', `${windowId}.json`),
            JSON.stringify({ windowId, title: windowId, updatedAt: Date.now() - ageMs, projects: [] }),
        );
    }

    const file = path.join(root, 'pids', `${windowId}.json`);

    fs.writeFileSync(file, JSON.stringify({ windowId, entries: pids.map((pid) => ({ path: `/p/${pid}`, pid })) }));

    return file;
}

function takenPids(): number[] {
    return registry.takeOrphans().map((entry) => entry.pid).sort((a, b) => a - b);
}

describe('takeOrphans', () => {
    // Uyuyup uyanan ya da tıkanan pencere bayat görünür; canlı sunucularına SIGTERM gitmemeli.
    it('canlı katılımcının sunucularını vermez: süreci yaşıyor ya da kaydı 60 sn dolmadı', () => {
        const asleep = participant(`${ALIVE}-asleep`, [11], 5 * 60_000);
        const noRecord = participant(`${ALIVE}-norecord`, [12]);
        const blocked = participant(`${DEAD}-blocked`, [13], 30_000);

        registry.recordPids([{ path: '/own', pid: 14 }]);

        expect(takenPids()).toEqual([]);
        expect([asleep, noRecord, blocked].every((file) => fs.existsSync(file))).toBe(true);
    });

    it('ölü katılımcının (eski kayıt + ölü süreç) grup liderlerini verir, 0/1/eksi pid vermez', () => {
        const crashed = participant(`${DEAD}-crashed`, [21, 0, 1, -7], 5 * 60_000);
        const swept = participant(`${DEAD}-swept`, [22]);

        expect(takenPids()).toEqual([21, 22]);
        expect(fs.existsSync(crashed) || fs.existsSync(swept)).toBe(false);
        expect(takenPids()).toEqual([]);
    });

    it('kimliğinde pid olmayan katılımcıda yalnız kaydın yaşına bakar', () => {
        const old = participant('legacy', [31], 5 * 60_000);
        const fresh = participant('fresh', [32], 30_000);

        expect(takenPids()).toEqual([31]);
        expect(fs.existsSync(old)).toBe(false);
        expect(fs.existsSync(fresh)).toBe(true);
    });
});
