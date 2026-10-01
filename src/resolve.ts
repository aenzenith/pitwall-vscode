/**
 * Saf karar mantığı. Burada `vscode` import EDİLMEZ; test edilebilir kalsın.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type FolderLike = {
    /** Klasörün diskteki yolu. */
    path: string;
    /** Durum çubuğunda gösterilecek ad. */
    name: string;
};

const LOCK_FILES: ReadonlyArray<readonly [string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
];

/** Script adı sadece bu karakterlerden oluşabilir; kabuk enjeksiyonunu keser. */
const SAFE_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/** Script'e geçirilen ek argüman: `--port`, `--port=5176`, `5176`. */
const SAFE_ARG = /^(--?[A-Za-z0-9][A-Za-z0-9-]*(=[A-Za-z0-9._:/-]+)?|[0-9]{1,5})$/;

/**
 * Klasördeki dosya adlarına bakarak paket yöneticisini bulur.
 *
 * @param files Klasörün kökündeki dosya adları.
 */
export function detectPackageManager(files: readonly string[]): PackageManager {
    for (const [lockFile, manager] of LOCK_FILES) {
        if (files.includes(lockFile)) {
            return manager;
        }
    }

    return 'npm';
}

/**
 * `build` ile başlayan ya da kabuk için güvensiz script adlarını reddeder.
 * Production build çalıştırmak bilerek engellenmiştir: açık dev sunucusunu bozuyor.
 */
export function isForbiddenScript(script: string): boolean {
    const name = script.trim();

    if (!SAFE_SCRIPT.test(name)) {
        return true;
    }

    return name.toLowerCase().startsWith('build');
}

/**
 * Terminale yazılacak komutu üretir.
 *
 * @throws Error Script adı yasaklıysa.
 */
export function buildCommand(manager: PackageManager, script: string, args: readonly string[] = []): string {
    const name = script.trim();

    if (isForbiddenScript(name)) {
        throw new Error(`Pitwall will not run this script: "${script}"`);
    }

    const safeArgs = args.filter((arg) => SAFE_ARG.test(arg));
    const tail = safeArgs.length > 0 ? ` -- ${safeArgs.join(' ')}` : '';

    return `${manager} run ${name}${tail}`;
}

/**
 * package.json içeriğinden script'in var olup olmadığına bakar.
 *
 * @param raw Ham package.json metni.
 */
export function hasScript(raw: string, script: string): boolean {
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return false;
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return false;
    }

    const scripts = (parsed as { scripts?: unknown }).scripts;

    if (typeof scripts !== 'object' || scripts === null) {
        return false;
    }

    return typeof (scripts as Record<string, unknown>)[script.trim()] === 'string';
}

/**
 * Aktif dosyanın yolundan hedef kök klasörü seçer.
 *
 * Sıra: aktif dosyanın klasörü → son kullanılan klasör → tek kök klasör → yok.
 *
 * @param activePath Editörde açık dosyanın yolu, yoksa undefined.
 * @param folders Workspace kök klasörleri.
 * @param lastUsedPath Daha önce seçilmiş klasör yolu.
 */
export function pickFolder<T extends FolderLike>(
    activePath: string | undefined,
    folders: readonly T[],
    lastUsedPath?: string,
): T | undefined {
    if (folders.length === 0) {
        return undefined;
    }

    if (activePath) {
        const matches = folders
            .filter((folder) => isInside(activePath, folder.path))
            .sort((a, b) => b.path.length - a.path.length);

        if (matches.length > 0) {
            return matches[0];
        }
    }

    if (lastUsedPath) {
        const remembered = folders.find((folder) => folder.path === lastUsedPath);

        if (remembered) {
            return remembered;
        }
    }

    if (folders.length === 1) {
        return folders[0];
    }

    return undefined;
}

/** Ayırıcı her iki biçimde de kabul edilir: Windows yolları `\` kullanır. */
function isInside(filePath: string, folderPath: string): boolean {
    if (filePath === folderPath) {
        return true;
    }

    if (!filePath.startsWith(folderPath)) {
        return false;
    }

    return /[\\/]$/.test(folderPath) || /[\\/]/.test(filePath[folderPath.length]);
}

/** ANSI renk kodları — vite çıktısı bunlarla dolu. ESC baytı kaynakta görünmez,
 * o yüzden koddan üretiliyor. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

const VITE_LOCAL = /Local:\s*(https?:\/\/[^\s]+)/i;
const ANY_LOCAL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s]*/i;

/**
 * Dev sunucusu çıktısından yerel URL'i çeker.
 *
 * @param output Terminal çıktısı (ANSI kodlu olabilir).
 */
export function extractLocalUrl(output: string): string | undefined {
    const clean = output.replace(ANSI, '');
    const labelled = clean.match(VITE_LOCAL);

    if (labelled) {
        return trimUrl(labelled[1]);
    }

    const bare = clean.match(ANY_LOCAL);

    return bare ? trimUrl(bare[0]) : undefined;
}

/**
 * .env içeriğinden APP_URL değerini okur. Tırnak ve satır sonu yorumu temizlenir.
 */
export function parseAppUrl(envRaw: string): string | undefined {
    for (const line of envRaw.split(/\r?\n/)) {
        const match = line.match(/^\s*APP_URL\s*=\s*(.*)$/);

        if (!match) {
            continue;
        }

        let value = match[1].trim();

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        } else {
            value = value.split('#')[0].trim();
        }

        if (/^https?:\/\/\S+$/.test(value)) {
            return trimUrl(value);
        }
    }

    return undefined;
}

/**
 * Herd varsayılanı: klasör adının kebab hâli + `.test`.
 * .env okunamadığında ya da APP_URL boşken kullanılır.
 */
export function herdFallbackUrl(folderDirName: string): string {
    const host = folderDirName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return `https://${host}.test`;
}

function trimUrl(url: string): string {
    return url.replace(/[.,;)\]]+$/, '');
}

/**
 * vite.config içindeki `server: { port: 5180 }` değerini bulur.
 * Yorum satırındaki ya da başka bloktaki `port` değerini almamak için
 * yalnız `server` bloğunun ilk portuna bakar.
 */
export function parseVitePort(source: string): number | undefined {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
    const server = withoutComments.match(/server\s*:\s*\{/);

    if (!server || server.index === undefined) {
        return undefined;
    }

    const tail = withoutComments.slice(server.index, server.index + 600);
    const port = tail.match(/\bport\s*:\s*(\d{2,5})\b/);

    return port ? Number(port[1]) : undefined;
}

const PORT_TAKEN = /Port\s+(\d{2,5})\s+is\s+in\s+use/i;
const ADDR_IN_USE = /EADDRINUSE[^\n]*/i;

/**
 * Çıktıda port çakışması var mı. Vite dolu portu haber verip bir üstüne geçer;
 * strictPort açıksa süreç EADDRINUSE ile düşer.
 *
 * @returns Çakışan port ve sunucunun ayakta kalıp kalmadığı.
 */
export function detectPortConflict(output: string): { port: number; fatal: boolean } | undefined {
    const clean = output.replace(ANSI, '');
    const taken = clean.match(PORT_TAKEN);

    if (taken) {
        return { port: Number(taken[1]), fatal: false };
    }

    const fatal = clean.match(ADDR_IN_USE);

    if (fatal) {
        return { port: portFromAddress(fatal[0]), fatal: true };
    }

    return undefined;
}

/**
 * `... in use 127.0.0.1:5173` gibi bir satırdan portu alır.
 * Adresin kendi sayıları porta karışmasın diye son iki nokta üstünden okunur.
 */
function portFromAddress(line: string): number {
    const afterColon = line.match(/:(\d{2,5})\b/g);

    if (afterColon && afterColon.length > 0) {
        return Number(afterColon[afterColon.length - 1].slice(1));
    }

    const bare = line.match(/\b(\d{4,5})\b/);

    return bare ? Number(bare[1]) : 0;
}

/** Çıktıda hata sayılan desenler. Vite/node/npm'in gerçekten bastığı satırlar. */
const ERROR_PATTERNS = [
    /^.*\b(?:Failed to resolve|Cannot find module|Module not found)\b.*$/im,
    /^.*\b(?:SyntaxError|TypeError|ReferenceError)\b.*$/im,
    /^.*\[vite\][^\n]*\berror\b[^\n]*$/im,
    /^.*\bELIFECYCLE\b.*$/im,
    /^.*\bnpm ERR!.*$/im,
];

/**
 * Çıktıdaki ilk anlamlı hata satırını döner; satırda hata yoksa undefined.
 * Panelde satırın yanına yazılacağı için kısaltılır.
 *
 * @param output Terminal/süreç çıktısı.
 * @param max Döndürülecek en uzun metin.
 */
export function detectErrorLine(output: string, max = 90): string | undefined {
    const clean = output.replace(ANSI, '');

    for (const pattern of ERROR_PATTERNS) {
        const match = clean.match(pattern);

        if (!match) {
            continue;
        }

        const line = match[0].trim().replace(/\s+/g, ' ');

        if (line.length === 0) {
            continue;
        }

        return line.length > max ? `${line.slice(0, max - 1)}…` : line;
    }

    return undefined;
}
