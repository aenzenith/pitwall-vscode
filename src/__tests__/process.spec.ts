import { describe, expect, it } from 'vitest';

import { findFreePort, isPortInUse } from '../ports';
import { killTree, spawnShell } from '../process';

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await check()) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
}

describe('killTree', () => {
    // Kabuğun altındaki torun süreç (npm altındaki vite gibi) de ölmeli;
    // yoksa durdurulan sunucu portu tutmaya devam eder.
    it('kabuğu alt süreciyle birlikte kapatır, port boşalır', async () => {
        const port = await findFreePort(41000 + Math.floor(Math.random() * 2000));

        expect(port).toBeDefined();

        const child = spawnShell(
            `node -e "require('net').createServer().listen(${port}, '127.0.0.1')"`,
            process.cwd(),
        );
        const exited = new Promise((resolve) => child.once('exit', resolve));

        expect(await until(() => isPortInUse(port as number), 15000)).toBe(true);

        expect(killTree(child.pid as number, 'SIGTERM')).toBe(true);

        expect(await until(async () => !(await isPortInUse(port as number)), 10000)).toBe(true);
        await exited;
    }, 30000);
});
