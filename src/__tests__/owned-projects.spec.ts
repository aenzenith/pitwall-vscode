import { describe, expect, it } from 'vitest';

import { locate, ownedProjects, samePath, type ProjectState, type WindowRecord } from '../registry';

function project(folderPath: string, running = false): ProjectState {
    return { folderPath, name: folderPath.split('/').pop() ?? folderPath, running };
}

function record(partial: Partial<WindowRecord>): WindowRecord {
    return {
        windowId: 'w1',
        title: 'pitlane-docs',
        updatedAt: Date.now(),
        projects: [],
        ...partial,
    };
}

describe('ownedProjects', () => {
    it('yalnız kendi köklerini sahiplenir', () => {
        const peer = record({
            roots: ['/projects/pitlane-docs'],
            projects: [project('/projects/pitlane-docs'), project('/projects/garage-admin')],
        });

        expect(ownedProjects(peer).map((item) => item.folderPath)).toEqual(['/projects/pitlane-docs']);
    });

    it('kökü olmayan ama orada çalışan projeyi sahiplenir', () => {
        const peer = record({
            roots: ['/projects/pitlane-docs'],
            projects: [project('/projects/pitlane-docs'), project('/projects/apex-cms', true)],
        });

        expect(ownedProjects(peer).map((item) => item.folderPath)).toEqual([
            '/projects/pitlane-docs',
            '/projects/apex-cms',
        ]);
    });

    it('eski sürüm kaydında (roots yok) yalnız çalışanlar sayılır', () => {
        const peer = record({
            projects: [project('/projects/pitlane-docs'), project('/projects/garage-admin')],
        });

        expect(ownedProjects(peer)).toEqual([]);
    });

    it('eski sürüm kaydında çalışan proje yine görünür', () => {
        const peer = record({
            projects: [project('/projects/pitlane-docs', true), project('/projects/garage-admin')],
        });

        expect(ownedProjects(peer).map((item) => item.folderPath)).toEqual(['/projects/pitlane-docs']);
    });
});

describe('samePath', () => {
    // Windows'ta VS Code kökü `c:\…`, uygulama aynı klasörü `C:\…` yazar: aynı proje sayılmazsa
    // uygulamada çalışan sunucu burada durmuş görünür ve başlat ikinci sunucu açar.
    it('Windows\'ta harf ve ayraç farkını saymaz, başka yerde yolu olduğu gibi karşılaştırır', () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
        // Testin koştuğu makineden bağımsız: CI'ın Windows'unda da macOS'unda da her iki durum denenir.
        const on = (value: NodeJS.Platform, check: () => void) => {
            Object.defineProperty(process, 'platform', { value });

            try {
                check();
            } finally {
                Object.defineProperty(process, 'platform', platform);
            }
        };

        on('win32', () => {
            const app = record({ windowId: 'app', roots: [], projects: [project('C:\\work\\paddock', true)] });

            expect(locate([app], 'c:\\work\\paddock')?.record.windowId).toBe('app');
            expect(samePath('c:/work/paddock/', 'C:\\Work\\Paddock')).toBe(true);
            expect(samePath('C:\\work\\paddock', 'C:\\work\\paddock-docs')).toBe(false);
        });

        on('darwin', () => {
            expect(samePath('/Users/me/paddock', '/users/me/paddock')).toBe(false);
        });
    });
});
