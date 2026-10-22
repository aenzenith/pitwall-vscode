import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildCommand,
    detectPackageManager,
    hasScript,
    isUnsafeScript,
    pickFolder,
    resolveWorkingFolder,
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

describe('resolveWorkingFolder', () => {
    let base: string;
    let project: string;
    let outside: string;

    beforeEach(() => {
        // macOS'ta tmpdir kendisi de bir bağlantının altında: projenin yazılışı korunmalı.
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-workdir-'));
        project = path.join(base, 'hotelslov.com');
        outside = path.join(base, 'outside');
        fs.mkdirSync(path.join(project, 'project'), { recursive: true });
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(project, 'package.json'), '{}');
        // `junction`: Windows'ta yönetici izni istemez, başka yerde yok sayılır.
        fs.symlinkSync(outside, path.join(project, 'escape'), 'junction');
    });

    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('boş ayar projenin kendi klasörüdür', () => {
        expect(resolveWorkingFolder(project, '')).toBe(project);
        expect(resolveWorkingFolder(project, '   ')).toBe(project);
        expect(resolveWorkingFolder(project, undefined)).toBe(project);
    });

    it('projenin içindeki klasörü göreli ya da mutlak yolla kabul eder', () => {
        const inner = path.join(project, 'project');

        expect(resolveWorkingFolder(project, 'project')).toBe(inner);
        expect(resolveWorkingFolder(project, ' project ')).toBe(inner);
        expect(resolveWorkingFolder(project, inner)).toBe(inner);
    });

    it('`..` ile proje dışına çıkanı reddeder', () => {
        expect(resolveWorkingFolder(project, '../outside')).toBeUndefined();
        expect(resolveWorkingFolder(project, 'project/../../outside')).toBeUndefined();
        expect(resolveWorkingFolder(project, outside)).toBeUndefined();
        // Adı projeninkiyle başlayan komşu klasör içeride sayılmaz.
        fs.mkdirSync(`${project}-eski`);
        expect(resolveWorkingFolder(project, `${project}-eski`)).toBeUndefined();
    });

    it('projenin içinden dışarıyı gösteren bağlantıyı reddeder', () => {
        expect(resolveWorkingFolder(project, 'escape')).toBeUndefined();
        expect(resolveWorkingFolder(project, path.join(project, 'escape'))).toBeUndefined();
    });

    it('olmayan ya da klasör olmayan yolu reddeder', () => {
        expect(resolveWorkingFolder(project, 'nope')).toBeUndefined();
        expect(resolveWorkingFolder(project, 'package.json')).toBeUndefined();
    });
});
