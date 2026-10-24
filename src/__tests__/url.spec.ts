import { describe, expect, it } from 'vitest';

import { extractLocalUrl, herdFallbackUrl, isProbed, nextAddress, parseAppUrl, type ServerAddress } from '../resolve';

describe('extractLocalUrl', () => {
    it('vite çıktısındaki Local satırını yakalar', () => {
        const output = [
            '  VITE v7.1.5  ready in 412 ms',
            '',
            '  ➜  Local:   http://localhost:5173/',
            '  ➜  Network: use --host to expose',
        ].join('\n');

        expect(extractLocalUrl(output)).toEqual({ url: 'http://localhost:5173/', labelled: true });
    });

    it('ANSI renk kodlarını temizler', () => {
        const output = '[32m  ➜[39m  [1mLocal[22m:   [36mhttp://localhost:5174/[39m';

        expect(extractLocalUrl(output)?.url).toBe('http://localhost:5174/');
    });

    it('Local etiketi yoksa çıplak yerel adresi bulur', () => {
        expect(extractLocalUrl('Server running at http://127.0.0.1:3000 now.')).toEqual({
            url: 'http://127.0.0.1:3000',
            labelled: false,
        });
    });

    it('yerel olmayan adresi almaz', () => {
        expect(extractLocalUrl('see https://vitejs.dev/config/ for help')).toBeUndefined();
        expect(extractLocalUrl('derleniyor…')).toBeUndefined();
    });
});

describe('nextAddress', () => {
    /** Satırları sırayla okur; her satırdan sonra sunucunun adresi. */
    function read(lines: string[], asked?: number): Array<ServerAddress | undefined> {
        let address: ServerAddress | undefined;

        return lines.map((line) => {
            address = nextAddress(line, address, asked) ?? address;

            return address;
        });
    }

    it("proxy'nin hedefi sunucunun kendi Local satırına yerini bırakır", () => {
        const [proxied, own, later] = read([
            '[HPM] Proxy created: /api  -> http://localhost:4000',
            '  ➜  Local:   http://localhost:3000/',
            'see http://localhost:4000/docs',
        ]);

        expect(proxied?.url).toBe('http://localhost:4000');
        expect(own).toMatchObject({ url: 'http://localhost:3000/', port: 3000 });
        expect(isProbed(own)).toBe(true);
        expect(later).toBe(own);
    });

    // Proxy hedefi ve sunucunun çıplak adresi: hangisi sunucunun bilinmez. Arkadaki backend
    // kapalıyken yoklama o portu sunucunun sanıp sağlıklı sunucuyu yeniden başlatırdı.
    it('iki portta çıplak URL varsa adres yoklanmaz; tek çıplak URL yoklanır', () => {
        const [proxied, server] = read([
            '[HPM] Proxy created: /api  -> http://localhost:4000',
            'Server listening on http://localhost:3000',
        ]);
        const [django, docs] = read([
            'Starting development server at http://127.0.0.1:8000/',
            'Docs at http://127.0.0.1:8000/docs',
        ]);

        expect(isProbed(proxied)).toBe(true);
        expect(server).toMatchObject({ url: 'http://localhost:4000', ambiguous: true });
        expect(isProbed(server)).toBe(false);
        expect(isProbed(django)).toBe(true);
        expect(isProbed(docs)).toBe(true);
    });

    it('Pitwall\'ın istediği porttaki adres başka bir Local satırına yerini bırakmaz', () => {
        const [, asked, other] = read(
            [
                '[api] listening on http://localhost:4000',
                '[web] ready at http://localhost:5173/',
                '[docs] ➜  Local:   http://localhost:6006/',
            ],
            5173,
        );

        expect(asked?.url).toBe('http://localhost:5173/');
        expect(isProbed(asked)).toBe(true);
        expect(other).toBe(asked);
    });
});

describe('parseAppUrl', () => {
    it('APP_URL değerini okur', () => {
        expect(parseAppUrl('APP_NAME=x\nAPP_URL=https://gridwall.test\nAPP_ENV=local')).toBe(
            'https://gridwall.test',
        );
    });

    it('satır sonu yorumunu değere katmaz', () => {
        const raw = 'APP_URL=https://apex-telemetry.test                # imzalı bağlantı tabanı';

        expect(parseAppUrl(raw)).toBe('https://apex-telemetry.test');
    });

    it('tırnaklı değeri açar', () => {
        expect(parseAppUrl('APP_URL="http://garage-admin.test"')).toBe('http://garage-admin.test');
    });

    it('boş ya da http olmayan değeri yok sayar', () => {
        expect(parseAppUrl('APP_URL=\nOTHER=1')).toBeUndefined();
        expect(parseAppUrl('APP_URL=gridwall.test')).toBeUndefined();
        expect(parseAppUrl('DB_HOST=127.0.0.1')).toBeUndefined();
    });
});

describe('herdFallbackUrl', () => {
    it('klasör adını kebab host yapar', () => {
        expect(herdFallbackUrl('apex-paddock')).toBe('https://apex-paddock.test');
        expect(herdFallbackUrl('Apex CMS')).toBe('https://apex-cms.test');
        expect(herdFallbackUrl('telemetry-v2')).toBe('https://telemetry-v2.test');
    });
});
