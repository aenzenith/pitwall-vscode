import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeSeen } from '../claude';
import { adoptOldStorage } from '../storage';

let root: string;
let shared: string;
let current: string;
let deleted: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-storage-'));
    shared = path.join(root, '.pitwall');
    current = path.join(root, 'aenzenith.pitwall-vscode');
    deleted = path.join(root, 'aenzenith.pitwall');
    fs.mkdirSync(current);
    fs.mkdirSync(deleted);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('adoptOldStorage', () => {
    it('favorileri ve görüldü kaydını eski depodan ortak klasöre taşır', () => {
        fs.writeFileSync(path.join(current, 'favorites.json'), '[{"path":"/p/a","name":"a"}]');
        fs.writeFileSync(path.join(current, 'claude-seen.json'), '{"since":1,"paths":{}}');

        adoptOldStorage(shared, [current, deleted]);

        expect(fs.readFileSync(path.join(shared, 'favorites.json'), 'utf8')).toBe('[{"path":"/p/a","name":"a"}]');
        expect(fs.readFileSync(path.join(shared, 'claude-seen.json'), 'utf8')).toBe('{"since":1,"paths":{}}');
        expect(fs.existsSync(path.join(current, 'favorites.json'))).toBe(true);
    });

    it('kaynaklardan listedeki ilk bulunanı alır', () => {
        fs.writeFileSync(path.join(current, 'favorites.json'), '[{"path":"/new","name":"new"}]');
        fs.writeFileSync(path.join(deleted, 'favorites.json'), '[{"path":"/old","name":"old"}]');
        fs.writeFileSync(path.join(deleted, 'claude-seen.json'), '{"since":7,"paths":{}}');

        adoptOldStorage(shared, [current, deleted]);

        expect(fs.readFileSync(path.join(shared, 'favorites.json'), 'utf8')).toBe('[{"path":"/new","name":"new"}]');
        expect(fs.readFileSync(path.join(shared, 'claude-seen.json'), 'utf8')).toBe('{"since":7,"paths":{}}');
    });

    it('ortak klasördeki kaydın üstüne yazmaz', () => {
        fs.writeFileSync(path.join(current, 'favorites.json'), '[{"path":"/old","name":"old"}]');
        fs.mkdirSync(shared);
        fs.writeFileSync(path.join(shared, 'favorites.json'), '[]');

        adoptOldStorage(shared, [current, deleted]);

        expect(fs.readFileSync(path.join(shared, 'favorites.json'), 'utf8')).toBe('[]');
    });

    it('geçici pencere ve pid kayıtlarını taşımaz', () => {
        fs.mkdirSync(path.join(current, 'pids'));
        fs.writeFileSync(path.join(current, 'pids', 'w1.json'), '{}');

        adoptOldStorage(shared, [current, deleted]);

        expect(fs.existsSync(path.join(shared, 'pids'))).toBe(false);
    });
});

describe('mergeSeen', () => {
    // Kaydı uygulama ve diğer pencereler de yazar; okuduktan sonra yazılanı ezmemeli.
    it('başka yazarın sonradan eklediği "baktım" bilgisini korur', () => {
        const disk = { since: 100, paths: { '/p/a': 500, '/p/b': 300 } };
        const mine = { since: 200, paths: { '/p/a': 400, '/p/c': 600 } };

        expect(mergeSeen(disk, mine)).toEqual({
            since: 100,
            paths: { '/p/a': 500, '/p/b': 300, '/p/c': 600 },
        });
    });
});
