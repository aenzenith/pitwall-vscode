import { describe, expect, it } from 'vitest';

import {
    buildCommand,
    detectPackageManager,
    hasScript,
    isUnsafeScript,
    pickFolder,
} from '../resolve';

describe('detectPackageManager', () => {
    it('lock dosyasından paket yöneticisini bulur', () => {
        expect(detectPackageManager(['pnpm-lock.yaml', 'package.json'])).toBe('pnpm');
        expect(detectPackageManager(['yarn.lock'])).toBe('yarn');
        expect(detectPackageManager(['bun.lockb'])).toBe('bun');
        expect(detectPackageManager(['package-lock.json'])).toBe('npm');
    });

    it('lock yoksa npm döner', () => {
        expect(detectPackageManager(['package.json'])).toBe('npm');
        expect(detectPackageManager([])).toBe('npm');
    });

    it('pnpm yarn ile birlikteyken pnpm kazanır', () => {
        expect(detectPackageManager(['yarn.lock', 'pnpm-lock.yaml'])).toBe('pnpm');
    });
});

describe('isUnsafeScript', () => {
    it('kabuk için güvensiz adları reddeder', () => {
        expect(isUnsafeScript('dev && rm -rf /')).toBe(true);
        expect(isUnsafeScript('dev; npm run build')).toBe(true);
        expect(isUnsafeScript('')).toBe(true);
    });

    it('normal script adlarına izin verir', () => {
        expect(isUnsafeScript('dev')).toBe(false);
        expect(isUnsafeScript('dev:ssr')).toBe(false);
        expect(isUnsafeScript('start-server')).toBe(false);
    });
});

describe('buildCommand', () => {
    it('komutu paket yöneticisiyle kurar', () => {
        expect(buildCommand('npm', 'dev')).toBe('npm run dev');
        expect(buildCommand('pnpm', 'dev')).toBe('pnpm run dev');
        expect(buildCommand('bun', ' dev ')).toBe('bun run dev');
    });

    it('güvensiz script için hata atar', () => {
        expect(() => buildCommand('npm', 'dev && rm -rf /')).toThrow(/will not run/);
    });
});

describe('hasScript', () => {
    it('scripts içindeki adı görür', () => {
        expect(hasScript('{"scripts":{"dev":"vite"}}', 'dev')).toBe(true);
        expect(hasScript('{"scripts":{"dev":"vite"}}', 'watch')).toBe(false);
    });

    it('bozuk ya da scriptsiz package.json için false döner', () => {
        expect(hasScript('{ bozuk', 'dev')).toBe(false);
        expect(hasScript('{"name":"x"}', 'dev')).toBe(false);
        expect(hasScript('{"scripts":null}', 'dev')).toBe(false);
    });
});

describe('pickFolder', () => {
    const folders = [
        { path: '/projects/apex-paddock', name: 'paddock' },
        { path: '/projects/apex-telemetry', name: 'telemetry-api' },
    ];

    it('aktif dosyanın kök klasörünü seçer', () => {
        expect(pickFolder('/projects/apex-telemetry/app/User.php', folders)?.name).toBe('telemetry-api');
    });

    it('iç içe köklerde en uzun eşleşmeyi seçer', () => {
        const nested = [
            { path: '/projects', name: 'root' },
            { path: '/projects/apex-paddock', name: 'paddock' },
        ];

        expect(pickFolder('/projects/apex-paddock/vite.config.ts', nested)?.name).toBe('paddock');
    });

    it('benzer adlı komşu klasörü içeride saymaz', () => {
        const siblings = [
            { path: '/projects/app', name: 'app' },
            { path: '/projects/other', name: 'other' },
        ];

        // /projects/app-legacy, /projects/app'in içinde DEĞİL; tek kök de olmadığı için seçim yok.
        expect(pickFolder('/projects/app-legacy/index.ts', siblings)).toBeUndefined();
    });

    it('dosya yoksa son kullanılana düşer', () => {
        expect(pickFolder(undefined, folders, '/projects/apex-telemetry')?.name).toBe('telemetry-api');
    });

    it('son kullanılan artık yoksa ve tek kök varsa onu seçer', () => {
        const single = [folders[0]];

        expect(pickFolder(undefined, single, '/silinmis')?.name).toBe('paddock');
    });

    it('çok köklü workspace ve ipucu yoksa seçim yapmaz', () => {
        expect(pickFolder(undefined, folders)).toBeUndefined();
        expect(pickFolder('/baska/yer/x.ts', [])).toBeUndefined();
    });
});
