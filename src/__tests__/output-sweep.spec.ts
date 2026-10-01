import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { Registry } from '../registry';

let root: string;
let registry: Registry | undefined;

afterEach(() => {
    registry?.dispose();
    registry = undefined;
    fs.rmSync(root, { recursive: true, force: true });
});

function writeLog(owner: string): string {
    const dir = path.join(root, 'output', owner);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.log'), 'x\n');

    return dir;
}

describe('çıktı süpürmesi', () => {
    it('yalnız kaydı kalmamış katılımcının çıktısını siler, kendi çıktısını kapanışta kaldırır', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-output-'));
        fs.mkdirSync(path.join(root, 'windows'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'windows', 'live.json'),
            JSON.stringify({ windowId: 'live', title: 'live', updatedAt: Date.now(), projects: [] }),
        );

        const live = writeLog('live');
        const dead = writeLog('dead');

        registry = new Registry(root, 'test');
        const own = writeLog(registry.windowId);

        expect(fs.existsSync(live)).toBe(true);
        expect(fs.existsSync(dead)).toBe(false);

        registry.dispose();
        registry = undefined;

        expect(fs.existsSync(own)).toBe(false);
        expect(fs.existsSync(live)).toBe(true);
    });
});
