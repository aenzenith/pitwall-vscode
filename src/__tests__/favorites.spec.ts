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

function setAside(): string[] {
    return fs
        .readdirSync(root)
        .filter((name) => name.startsWith('favorites.json.broken-'))
        .map((name) => fs.readFileSync(path.join(root, name), 'utf8'));
}

describe('favoriler', () => {
    // Elle düzenlemede kalan bir virgül listeyi okunmaz yapar ama içindekiler hâlâ orada: yeni
    // bir yıldız onu kenara alır, üstüne yazmaz. Editörün başa koyduğu BOM ise bozukluk değildir.
    it('çözülemeyen favorites.json kenara alınmadan üstüne yazılmaz', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-favorites-'));
        const file = path.join(root, 'favorites.json');
        const damaged = '[{"path":"/p/b","name":"b"},]';

        fs.writeFileSync(file, damaged);
        registry = new Registry(root, 'test');

        expect(registry.toggleFavorite({ path: '/p/a', name: 'a' })).toBe(true);
        expect(setAside()).toEqual([damaged]);
        expect(registry.readFavorites()).toEqual([{ path: '/p/a', name: 'a' }]);

        fs.writeFileSync(file, '﻿[{"path":"/p/b","name":"b"}]');

        expect(registry.readFavorites()).toEqual([{ path: '/p/b', name: 'b' }]);
        expect(registry.toggleFavorite({ path: '/p/c', name: 'c' })).toBe(true);
        expect(setAside()).toHaveLength(1);
        expect(registry.readFavorites()).toEqual([
            { path: '/p/b', name: 'b' },
            { path: '/p/c', name: 'c' },
        ]);
    });
});
