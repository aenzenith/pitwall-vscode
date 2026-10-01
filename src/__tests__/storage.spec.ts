import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptOldStorage } from '../storage';

let root: string;
let oldDir: string;
let newDir: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-storage-'));
    oldDir = path.join(root, 'aenzenith.pitwall');
    newDir = path.join(root, 'aenzenith.pitwall-vscode');
    fs.mkdirSync(oldDir);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('adoptOldStorage', () => {
    it('favorileri ve görüldü kaydını eski kimliğin klasöründen taşır', () => {
        fs.writeFileSync(path.join(oldDir, 'favorites.json'), '[{"path":"/p/a","name":"a"}]');
        fs.writeFileSync(path.join(oldDir, 'claude-seen.json'), '{"since":1,"paths":{}}');

        adoptOldStorage(newDir);

        expect(fs.readFileSync(path.join(newDir, 'favorites.json'), 'utf8')).toBe('[{"path":"/p/a","name":"a"}]');
        expect(fs.readFileSync(path.join(newDir, 'claude-seen.json'), 'utf8')).toBe('{"since":1,"paths":{}}');
        expect(fs.existsSync(path.join(oldDir, 'favorites.json'))).toBe(true);
    });

    it('yeni klasördeki kaydın üstüne yazmaz', () => {
        fs.writeFileSync(path.join(oldDir, 'favorites.json'), '[{"path":"/old","name":"old"}]');
        fs.mkdirSync(newDir);
        fs.writeFileSync(path.join(newDir, 'favorites.json'), '[]');

        adoptOldStorage(newDir);

        expect(fs.readFileSync(path.join(newDir, 'favorites.json'), 'utf8')).toBe('[]');
    });

    it('geçici pencere ve pid kayıtlarını taşımaz', () => {
        fs.mkdirSync(path.join(oldDir, 'pids'));
        fs.writeFileSync(path.join(oldDir, 'pids', 'w1.json'), '{}');

        adoptOldStorage(newDir);

        expect(fs.existsSync(path.join(newDir, 'pids'))).toBe(false);
    });
});
