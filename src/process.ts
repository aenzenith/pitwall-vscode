import { type ChildProcess, execFile, spawn } from 'child_process';

const isWindows = process.platform === 'win32';

/**
 * Komutu arka planda koşturur.
 *
 * - macOS/Linux: giriş kabuğu (`-lc`) PATH'i profilden alır; süreç kendi grubunda
 *   başlar (`detached`), böylece durdururken `npm` altındaki `vite` de kapanır.
 * - Windows: `cmd.exe` üzerinden, konsol penceresi açmadan. Süreç grubu yok;
 *   ağaç `taskkill /T` ile kapatılır.
 */
export function spawnShell(command: string, cwd: string): ChildProcess {
    const env = { ...process.env, FORCE_COLOR: '0' };

    if (isWindows) {
        return spawn(command, {
            cwd,
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
        });
    }

    return spawn(process.env.SHELL ?? '/bin/zsh', ['-lc', command], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
    });
}

/**
 * Süreci alt süreçleriyle birlikte kapatır. Windows'ta konsol süreçleri
 * nazik kapatmayı dinlemediği için her zaman zorla (`/F`) kapatılır.
 *
 * @returns Sinyal gönderilebildiyse true.
 */
export function killTree(pid: number, signal: NodeJS.Signals): boolean {
    if (isWindows) {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);

        return true;
    }

    try {
        process.kill(-pid, signal);

        return true;
    } catch {
        return false;
    }
}

/**
 * Ölü pencereden kalan süreci kapatır. Windows pid'leri çabuk yeniden kullanır;
 * eski pid artık başka bir programa ait olabilir. O yüzden yalnız hâlâ bizim
 * başlattığımız türden bir süreçse (`cmd.exe`) ağaç kapatılır.
 */
export async function killOrphan(pid: number): Promise<boolean> {
    if (!isWindows) {
        return killTree(pid, 'SIGTERM');
    }

    const image = await imageName(pid);

    if (image?.toLowerCase() !== 'cmd.exe') {
        return false;
    }

    return killTree(pid, 'SIGKILL');
}

/** `tasklist` ile pid'in program adı. Süreç yoksa undefined. */
function imageName(pid: number): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile(
            'tasklist',
            ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
            { windowsHide: true, timeout: 3000 },
            (error, stdout) => {
                const match = !error && /^"([^"]+)","(\d+)"/m.exec(stdout);

                resolve(match && match[2] === String(pid) ? match[1] : undefined);
            },
        );
    });
}
