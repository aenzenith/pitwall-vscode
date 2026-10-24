import { describe, expect, it } from 'vitest';

import { parseLsof, portFromUrl } from '../ports';
import { buildCommand, detectPortConflict, diedOnBusyPort } from '../resolve';

describe('parseLsof', () => {
    it('süreç adı ve pid çıkarır', () => {
        const output = ['p48213', 'cnode', 'n127.0.0.1:5173'].join('\n');

        expect(parseLsof(output)).toBe('node · pid 48213');
    });

    it('yalnız pid varsa onu döner', () => {
        expect(parseLsof('p91\n')).toBe('pid 91');
    });

    it('boş çıktıda undefined', () => {
        expect(parseLsof('')).toBeUndefined();
    });
});

describe('portFromUrl', () => {
    it('porta bakar', () => {
        expect(portFromUrl('http://localhost:5173/')).toBe(5173);
    });

    it('port yoksa şemadan türetir', () => {
        expect(portFromUrl('https://gridwall.test')).toBe(443);
        expect(portFromUrl('http://garage-admin.test')).toBe(80);
    });

    it('bozuk adres undefined', () => {
        expect(portFromUrl('gridwall.test')).toBeUndefined();
    });
});

describe('detectPortConflict', () => {
    it('vite "Port X is in use" satırını yakalar', () => {
        const output = 'Port 5173 is in use, trying another one...';

        expect(detectPortConflict(output)).toEqual({ port: 5173, fatal: false });
    });

    it('EADDRINUSE ölümcül sayılır', () => {
        const output = 'Error: listen EADDRINUSE: address already in use 127.0.0.1:5173';

        expect(detectPortConflict(output)).toEqual({ port: 5173, fatal: true });
    });

    it('normal çıktıda çakışma yok', () => {
        expect(detectPortConflict('  ➜  Local:   http://localhost:5173/')).toBeUndefined();
    });
});

describe('diedOnBusyPort', () => {
    const address = { url: 'http://localhost:5173/', port: 5173, sureness: 2, ambiguous: false };
    const busy = (port: number) => ({ port, fatal: true });

    // Taşımak sunucuyu durdurur, çıktısını siler ve başka porta açar: yalnız gerçekten kendi
    // portunda düşen sunucu için.
    it('sunucu ayaktayken basılan EADDRINUSE onu taşımaz', () => {
        expect(diedOnBusyPort(busy(5173), address, 5173)).toBe(false);
        expect(diedOnBusyPort(busy(4000), address, undefined)).toBe(false);
    });

    it('yanında koşan başka bir sürecin dolu portu onu taşımaz', () => {
        expect(diedOnBusyPort(busy(4000), undefined, 5173)).toBe(false);
    });

    it('kendi portunda düşen sunucu taşınır; port bilinmiyorsa her EADDRINUSE sayılır', () => {
        expect(diedOnBusyPort(busy(5173), undefined, 5173)).toBe(true);
        expect(diedOnBusyPort(busy(3000), undefined, undefined)).toBe(true);
        expect(diedOnBusyPort({ port: 5173, fatal: false }, undefined, 5173)).toBe(false);
        expect(diedOnBusyPort(busy(0), undefined, undefined)).toBe(false);
    });
});

describe('buildCommand ek argümanlar', () => {
    it('argümanları -- ile geçirir', () => {
        expect(buildCommand('npm', 'dev', ['--port', '5176'])).toBe('npm run dev -- --port 5176');
    });

    it('güvensiz argümanı atar', () => {
        expect(buildCommand('npm', 'dev', ['--port', '5176; rm -rf /'])).toBe('npm run dev -- --port');
    });

    it('argüman yoksa komut değişmez', () => {
        expect(buildCommand('pnpm', 'dev')).toBe('pnpm run dev');
    });
});
