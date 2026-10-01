import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

import { OutputMirror, outputPath } from './output';
import { findFreePort, isPortServed, portFromUrl } from './ports';
import { killTree, spawnShell } from './process';
import type { ProjectIssue, ProjectState } from './registry';
import {
    buildCommand,
    detectErrorLine,
    detectPackageManager,
    detectPortConflict,
    extractLocalUrl,
    hasScript,
    herdFallbackUrl,
    isForbiddenScript,
    parseAppUrl,
    parseVitePort,
    type PackageManager,
} from './resolve';

/** Dev çalıştırılabilecek bir klasör. Workspace kökü ya da favori olabilir. */
export type Target = {
    path: string;
    name: string;
    uri: vscode.Uri;
};

/** Arka planda koşan bir dev sunucusu. */
type Run = {
    child: ChildProcess;
    /** Koşu boyunca yazılanlar Output kanalına ve paylaşılan dosyaya birlikte gider. */
    channel: Pick<vscode.OutputChannel, 'append' | 'appendLine'>;
    mirror?: OutputMirror;
    /** Paylaşılan çıktı dosyası, kayıt klasörüne göre (bkz. `outputPath`). */
    output?: string;
    startedAt: number;
    /** Çıktının son parçası: URL ve port çakışması burada aranır. */
    buffer: string;
    /** Adres bulunduğunda tarayıcıda açılacak mı. */
    openUrl: boolean;
    settled: boolean;
    timer?: ReturnType<typeof setTimeout>;
    url?: string;
    port?: number;
};

/** Az önce dağıtılan port yeniden dağıtılmasın: sunucu henüz dinlemeye başlamamış olabilir. */
const RESERVATION_MS = 60000;

/** Sağlık yoklaması aralığı. */
const HEALTH_MS = 30000;

/** Çöken ya da yanıt vermeyen sunucu bu kadar bekleyip geri kaldırılır. */
const RESTART_DELAY_MS = 3000;

/** Art arda bu kadar yeniden başlatma başarısız olursa vazgeçilir; elle başlatmak sayacı sıfırlar. */
const MAX_RESTARTS = 3;

/** Süreç bu kadar ayakta kalırsa başlatma başarılı sayılır ve başarısızlık sayacı sıfırlanır. */
const STABLE_MS = 60000;

export function targetFromFolder(folder: vscode.WorkspaceFolder): Target {
    return { path: folder.uri.fsPath, name: folder.name, uri: folder.uri };
}

export function targetFromPath(folderPath: string, name?: string): Target {
    return {
        path: folderPath,
        name: name ?? path.basename(folderPath),
        uri: vscode.Uri.file(folderPath),
    };
}

/**
 * Dev sunucularını arka plan süreci olarak koşturur — terminal sekmesi açmaz.
 * Çıktı proje başına bir Output kanalına yazılır.
 *
 * Süreç ağacı birlikte kapatılır (bkz. `process.ts`), böylece durdururken
 * `npm` değil altındaki `vite` de kapanır. Pencere kapanınca hepsi öldürülür.
 */
export class DevRunner {
    private readonly runs = new Map<string, Run>();

    private readonly channels = new Map<string, vscode.OutputChannel>();

    private readonly busy = new Set<string>();

    /** Dolu porttan kurtarma denemesi yapılmış projeler. */
    private readonly retried = new Set<string>();

    /** Bu oturumda dağıtılmış portlar: port -> dağıtım anı. */
    private readonly reserved = new Map<number, number>();

    /** Bilerek durdurulanlar: çıkış olayı çökme sayılmasın. */
    private readonly stopping = new Set<string>();

    /** Art arda başarısız otomatik yeniden başlatma sayısı: proje -> deneme. */
    private readonly attempts = new Map<string, number>();

    private disposed = false;

    /** Satırda gösterilecek sorun notu: çökme, hata satırı ya da yanıtsızlık. */
    private readonly issues = new Map<string, ProjectIssue>();

    /** Son başlatma hedefleri: kurtarma sırasında yeniden kurmak için. */
    private readonly lastTargets = new Map<string, Target>();

    private healthTimer?: ReturnType<typeof setInterval>;

    /**
     * @param shared Çıktının paylaşılacağı kayıt klasörü ve bu pencerenin kimliği. Verilmezse
     *   çıktı yalnız Output kanalına yazılır.
     */
    public constructor(
        private readonly onChange: () => void,
        private readonly shared?: { dir: string; windowId: string },
    ) {
        this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_MS);
    }

    /** Çalışan süreçlerin pid listesi — öksüz temizliği için dışarı verilir. */
    public pids(): Array<{ path: string; pid: number }> {
        return Array.from(this.runs.entries())
            .map(([folderPath, run]) => ({ path: folderPath, pid: run.child.pid ?? 0 }))
            .filter((entry) => entry.pid > 0);
    }

    public isRunning(folderPath: string): boolean {
        return this.runs.has(folderPath);
    }

    public isBusy(folderPath: string): boolean {
        return this.busy.has(folderPath);
    }

    public runningPaths(): string[] {
        return Array.from(this.runs.keys());
    }

    /** Projenin çıktı kanalını öne getirir. */
    public reveal(folderPath: string): void {
        this.channels.get(folderPath)?.show(true);
    }

    public stateOf(target: Target): ProjectState {
        const run = this.runs.get(target.path);

        return {
            folderPath: target.path,
            name: target.name,
            running: run !== undefined,
            port: run?.port,
            url: run?.url,
            startedAt: run?.startedAt,
            issue: this.issues.get(target.path),
            output: run?.output,
        };
    }

    /**
     * @param openUrl Sunucu hazır olunca tarayıcıda adres açılsın mı. Reload'da açılmaz.
     * @param extraArgs Script'e geçirilecek ek argüman, ör. `['--port', '5176']`.
     */
    public async start(target: Target, openUrl = true, extraArgs: readonly string[] = []): Promise<void> {
        this.attempts.delete(target.path);
        await this.launch(target, openUrl, extraArgs);
    }

    /** Elle başlatmadan farkı: başarısızlık sayacına dokunmaz. Otomatik kurtarma buradan geçer. */
    private async launch(target: Target, openUrl: boolean, extraArgs: readonly string[] = []): Promise<void> {
        if (this.runs.has(target.path)) {
            this.reveal(target.path);

            return;
        }

        const config = vscode.workspace.getConfiguration('pitwall', target.uri);
        const script = config.get<string>('script', 'dev');

        if (isForbiddenScript(script)) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Pitwall will not run this script: "{0}"', script));

            return;
        }

        if (!(await this.scriptExists(target, script))) {
            void vscode.window.showErrorMessage(
                vscode.l10n.t('{0}: package.json has no "{1}" script.', target.name, script),
            );

            return;
        }

        const manager = await this.resolvePackageManager(target, config);
        const args = extraArgs.length > 0 ? extraArgs : await this.freePortArgs(target, config);
        const command = buildCommand(manager, script, args);
        const channel = this.channelFor(target);

        channel.clear();
        channel.appendLine(`$ ${command}`);
        channel.appendLine(`  ${target.path}`);
        channel.appendLine('');

        const child = spawnShell(command, target.path);
        const startedAt = Date.now();
        const output = this.shared ? outputPath(this.shared.windowId, target.path, startedAt) : undefined;
        const mirror = this.shared && output ? new OutputMirror(path.join(this.shared.dir, output)) : undefined;

        mirror?.append(`$ ${command}\n  ${target.path}\n\n`);

        const run: Run = {
            child,
            channel: {
                append: (text) => {
                    channel.append(text);
                    mirror?.append(text);
                },
                appendLine: (text) => {
                    channel.appendLine(text);
                    mirror?.append(`${text}\n`);
                },
            },
            mirror,
            output,
            startedAt,
            buffer: '',
            openUrl: openUrl && config.get<boolean>('openUrlOnStart', false),
            settled: false,
        };

        this.runs.set(target.path, run);
        this.issues.delete(target.path);
        this.lastTargets.set(target.path, target);

        if (config.get<boolean>('revealTerminal', false)) {
            channel.show(true);
        }

        child.stdout?.on('data', (chunk: Buffer) => void this.consume(target, run, chunk.toString()));
        child.stderr?.on('data', (chunk: Buffer) => void this.consume(target, run, chunk.toString()));

        child.once('error', (error: Error) => {
            channel.appendLine(`\n[pitwall] ${vscode.l10n.t('could not start: {0}', error.message)}`);
            this.forget(target.path);
        });

        child.once('exit', (code, signal) => {
            channel.appendLine(
                `\n[pitwall] ${vscode.l10n.t('process ended (code {0}, signal {1})', String(code ?? '-'), String(signal ?? '-'))}`,
            );

            const planned = this.stopping.has(target.path);

            this.forget(target.path);

            if (!planned && !this.disposed) {
                void this.handleCrash(target, run, code, signal);
            }
        });

        run.timer = setTimeout(
            () => void this.settleUrl(target, undefined),
            Math.max(1000, config.get<number>('openUrlTimeoutMs', 15000)),
        );

        this.onChange();
    }

    public async stop(folderPath: string): Promise<void> {
        const run = this.runs.get(folderPath);

        if (!run) {
            return;
        }

        this.stopping.add(folderPath);
        this.busy.add(folderPath);
        this.issues.delete(folderPath);
        this.onChange();

        try {
            await this.kill(run, folderPath);
        } finally {
            this.forget(folderPath);
            this.busy.delete(folderPath);
            this.stopping.delete(folderPath);
            this.onChange();
        }
    }

    public async restart(target: Target): Promise<void> {
        await this.stop(target.path);
        await this.start(target, false);
    }

    public async toggle(target: Target): Promise<void> {
        if (this.isRunning(target.path)) {
            await this.stop(target.path);

            return;
        }

        await this.start(target);
    }

    public async stopAll(): Promise<void> {
        await Promise.all(this.runningPaths().map((folderPath) => this.stop(folderPath)));
    }

    /** Pencere kapanırken: bütün süreçler kapatılır, öksüz sunucu bırakılmaz. */
    public dispose(): void {
        this.disposed = true;

        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = undefined;
        }

        for (const [folderPath, run] of this.runs) {
            this.signal(run, 'SIGTERM');
            this.clearTimer(run);
            run.mirror?.remove();
            void folderPath;
        }

        this.runs.clear();

        for (const channel of this.channels.values()) {
            channel.dispose();
        }

        this.channels.clear();
    }

    /* ---------- çıktı ---------- */

    private async consume(target: Target, run: Run, text: string): Promise<void> {
        run.channel.append(text);
        run.buffer = `${run.buffer}${text}`.slice(-4096);

        const conflict = detectPortConflict(run.buffer);

        if (conflict) {
            run.buffer = '';
            await this.recoverFromConflict(target, conflict);

            return;
        }

        const errorLine = detectErrorLine(text);

        if (errorLine) {
            this.issues.set(target.path, { kind: 'error', text: errorLine });
            this.onChange();
        }

        const localUrl = extractLocalUrl(run.buffer);

        if (localUrl) {
            run.buffer = '';
            await this.settleUrl(target, localUrl);
        }
    }

    /**
     * Süreç kendi kendine düştü (bilerek durdurulmadı): satır "çöktü" olarak işaretlenir ve
     * RESTART_DELAY_MS sonra geri kaldırılır. Art arda MAX_RESTARTS deneme STABLE_MS içinde
     * ölürse vazgeçilir; elle başlatmak hakkı geri verir.
     */
    private async handleCrash(target: Target, run: Run, code: number | null, signal: string | null): Promise<void> {
        const previous = this.issues.get(target.path);
        const detail = previous?.kind === 'error' ? previous.text : `code ${code ?? signal ?? '-'}`;
        const attempt = this.claimRestart(target.path, run);

        if (attempt === undefined) {
            this.issues.set(target.path, {
                kind: 'crashed',
                text: vscode.l10n.t(
                    'crashed — {0} · gave up after {1} restarts',
                    detail,
                    String(MAX_RESTARTS),
                ),
            });
            this.onChange();
            this.channelFor(target).appendLine(
                `[pitwall] ${vscode.l10n.t(
                    'gave up: {0} restarts in a row failed. Start it by hand.',
                    String(MAX_RESTARTS),
                )}`,
            );

            return;
        }

        this.issues.set(target.path, {
            kind: 'crashed',
            text: vscode.l10n.t(
                'crashed — {0} · restarting ({1}/{2})',
                detail,
                String(attempt),
                String(MAX_RESTARTS),
            ),
        });
        this.onChange();
        this.channelFor(target).appendLine(
            `[pitwall] ${vscode.l10n.t(
                'crashed, restarting in {0} s (attempt {1}/{2})…',
                String(RESTART_DELAY_MS / 1000),
                String(attempt),
                String(MAX_RESTARTS),
            )}`,
        );

        await wait(RESTART_DELAY_MS);

        if (this.disposed || this.runs.has(target.path) || this.busy.has(target.path)) {
            return;
        }

        await this.launch(target, false);
    }

    /**
     * Süreç ayakta ama port cevap vermiyorsa satır uyarıya döner ve kurtarma planlanır.
     * Port bilinmiyorsa (adres henüz basılmadıysa) dokunulmaz.
     */
    private async checkHealth(): Promise<void> {
        let changed = false;

        for (const [folderPath, run] of this.runs) {
            if (!run.port || this.busy.has(folderPath)) {
                continue;
            }

            const alive = await isPortServed(run.port);
            const current = this.issues.get(folderPath);

            if (!alive && current?.kind !== 'unresponsive') {
                this.issues.set(folderPath, {
                    kind: 'unresponsive',
                    text: vscode.l10n.t(':{0} not responding', String(run.port)),
                });
                changed = true;
                void this.recoverUnresponsive(folderPath, run);
            } else if (alive && current?.kind === 'unresponsive') {
                this.issues.delete(folderPath);
                changed = true;
            }
        }

        if (changed) {
            this.onChange();
        }
    }

    /**
     * Yanıtsız port: RESTART_DELAY_MS bekleyip bir daha yoklanır (anlık takılma olabilir),
     * hâlâ sessizse süreç öldürülüp yeniden başlatılır. Sayaç çökmeyle ortak.
     */
    private async recoverUnresponsive(folderPath: string, run: Run): Promise<void> {
        await wait(RESTART_DELAY_MS);

        if (this.disposed || this.runs.get(folderPath) !== run || this.busy.has(folderPath) || !run.port) {
            return;
        }

        if (await isPortServed(run.port)) {
            if (this.issues.get(folderPath)?.kind === 'unresponsive') {
                this.issues.delete(folderPath);
                this.onChange();
            }

            return;
        }

        const target = this.lastTargets.get(folderPath);

        if (!target) {
            return;
        }

        const port = String(run.port);
        const attempt = this.claimRestart(folderPath, run);

        if (attempt === undefined) {
            this.issues.set(folderPath, {
                kind: 'unresponsive',
                text: vscode.l10n.t(
                    ':{0} not responding · gave up after {1} restarts',
                    port,
                    String(MAX_RESTARTS),
                ),
            });
            this.onChange();
            run.channel.appendLine(
                `\n[pitwall] ${vscode.l10n.t(
                    'gave up: {0} restarts in a row failed. Start it by hand.',
                    String(MAX_RESTARTS),
                )}`,
            );

            return;
        }

        run.channel.appendLine(
            `\n[pitwall] ${vscode.l10n.t(
                ':{0} not responding, restarting (attempt {1}/{2})…',
                port,
                String(attempt),
                String(MAX_RESTARTS),
            )}`,
        );

        await this.stop(folderPath);

        if (this.disposed || this.runs.has(folderPath)) {
            return;
        }

        await this.launch(target, false);
    }

    /**
     * Yeniden başlatma hakkı ister. STABLE_MS ayakta kalmış bir koşu sayacı sıfırlar: bu
     * yeni bir seri. Hak kalmadıysa undefined, yoksa bu denemenin sırası (1..MAX_RESTARTS).
     */
    private claimRestart(folderPath: string, run: Run): number | undefined {
        if (Date.now() - run.startedAt >= STABLE_MS) {
            this.attempts.delete(folderPath);
        }

        const used = this.attempts.get(folderPath) ?? 0;

        if (used >= MAX_RESTARTS) {
            return undefined;
        }

        this.attempts.set(folderPath, used + 1);

        return used + 1;
    }

    /** Sunucunun adresi belli oldu: durumu işaretle, gerekiyorsa tarayıcıda aç. */
    private async settleUrl(target: Target, localUrl: string | undefined): Promise<void> {
        const run = this.runs.get(target.path);

        if (!run || run.settled) {
            return;
        }

        run.settled = true;
        this.clearTimer(run);

        if (localUrl) {
            run.url = localUrl;
            run.port = portFromUrl(localUrl);
            this.onChange();
        }

        if (!run.openUrl) {
            return;
        }

        const address = await this.resolveUrl(target, localUrl);

        if (address) {
            await vscode.env.openExternal(vscode.Uri.parse(address));
        }
    }

    /**
     * Sunucu dolu porta düşerse sessizce boş porta taşınır.
     * Proje başına bir kez denenir, döngüye girmesin.
     */
    private async recoverFromConflict(target: Target, conflict: { port: number; fatal: boolean }): Promise<void> {
        if (!conflict.fatal || conflict.port <= 0 || this.retried.has(target.path)) {
            return;
        }

        const free = await this.reserveFreePort(conflict.port + 1);

        if (!free) {
            return;
        }

        this.retried.add(target.path);

        await this.stop(target.path);
        await this.launch(target, false, ['--port', String(free)]);
    }

    /* ---------- süreç ---------- */

    /** Süreç grubuna TERM yollar, ölmezse KILL. */
    private async kill(run: Run, folderPath: string): Promise<void> {
        this.clearTimer(run);
        this.signal(run, 'SIGTERM');

        const delay = vscode.workspace
            .getConfiguration('pitwall', vscode.Uri.file(folderPath))
            .get<number>('restartDelayMs', 600);

        await wait(Math.max(0, delay));

        if (run.child.exitCode === null && run.child.signalCode === null) {
            this.signal(run, 'SIGKILL');
        }
    }

    private signal(run: Run, signal: NodeJS.Signals): void {
        const pid = run.child.pid;

        if (!pid) {
            return;
        }

        if (killTree(pid, signal)) {
            return;
        }

        try {
            run.child.kill(signal);
        } catch {
        }
    }

    private forget(folderPath: string): void {
        const run = this.runs.get(folderPath);

        if (!run) {
            return;
        }

        this.clearTimer(run);
        run.mirror?.remove();
        this.runs.delete(folderPath);
        this.onChange();
    }

    private clearTimer(run: Run): void {
        if (run.timer) {
            clearTimeout(run.timer);
            run.timer = undefined;
        }
    }

    private channelFor(target: Target): vscode.OutputChannel {
        const existing = this.channels.get(target.path);

        if (existing) {
            return existing;
        }

        const channel = vscode.window.createOutputChannel(`Dev: ${target.name}`);

        this.channels.set(target.path, channel);

        return channel;
    }

    /* ---------- port ---------- */

    /**
     * Başlamadan önce boş port ayırır: hedef port doluysa üstündeki ilk boş porta geçer.
     * Sessiz çalışır — kullanıcıya sorulmaz, söylenmez.
     */
    private async freePortArgs(target: Target, config: vscode.WorkspaceConfiguration): Promise<string[]> {
        const base = await this.basePort(target, config);
        const free = await this.reserveFreePort(base);

        if (!free || free === base) {
            return [];
        }

        return ['--port', String(free)];
    }

    /**
     * Dinlenmeyen ve bu oturumda az önce dağıtılmamış ilk portu bulur.
     * Toplu başlatmada sunucular henüz dinlemeye başlamadığı için yalnız sokete bakmak yetmez.
     */
    private async reserveFreePort(from: number): Promise<number | undefined> {
        const now = Date.now();

        for (const [port, at] of this.reserved) {
            if (now - at > RESERVATION_MS) {
                this.reserved.delete(port);
            }
        }

        let candidate = from;

        for (let step = 0; step < 40; step += 1) {
            const free = await findFreePort(candidate, 40 - step);

            if (!free) {
                return undefined;
            }

            if (!this.reserved.has(free)) {
                this.reserved.set(free, Date.now());

                return free;
            }

            candidate = free + 1;
        }

        return undefined;
    }

    /** Projenin istediği port: ayar > vite.config > 5173. */
    private async basePort(target: Target, config: vscode.WorkspaceConfiguration): Promise<number> {
        const configured = config.get<number>('port', 0);

        if (Number.isInteger(configured) && configured > 0) {
            return configured;
        }

        for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']) {
            try {
                const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(target.uri, name));
                const port = parseVitePort(Buffer.from(raw).toString('utf8'));

                if (port) {
                    return port;
                }
            } catch {
                continue;
            }
        }

        return 5173;
    }

    /* ---------- adres ---------- */

    /**
     * Açılacak adres. Sıra kesin: ayar > `.env` içindeki APP_URL > Herd varsayılanı
     * (Laravel projesiyse) > sunucunun kendi adresi.
     */
    public async resolveUrl(target: Target, localUrl?: string): Promise<string | undefined> {
        const configured = vscode.workspace
            .getConfiguration('pitwall', target.uri)
            .get<string>('url', '')
            .trim();

        if (configured) {
            return configured;
        }

        const appUrl = await this.readAppUrl(target);

        if (appUrl) {
            return appUrl;
        }

        if (await this.fileExists(vscode.Uri.joinPath(target.uri, 'artisan'))) {
            return herdFallbackUrl(path.basename(target.path));
        }

        return localUrl;
    }

    private async readAppUrl(target: Target): Promise<string | undefined> {
        try {
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(target.uri, '.env'));

            return parseAppUrl(Buffer.from(raw).toString('utf8'));
        } catch {
            return undefined;
        }
    }

    private async fileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);

            return true;
        } catch {
            return false;
        }
    }

    private async resolvePackageManager(
        target: Target,
        config: vscode.WorkspaceConfiguration,
    ): Promise<PackageManager> {
        const configured = config.get<string>('packageManager', 'auto');

        if (configured !== 'auto') {
            return configured as PackageManager;
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(target.uri);

            return detectPackageManager(entries.map(([name]) => name));
        } catch {
            return 'npm';
        }
    }

    private async scriptExists(target: Target, script: string): Promise<boolean> {
        try {
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(target.uri, 'package.json'));

            return hasScript(Buffer.from(raw).toString('utf8'), script);
        } catch {
            return false;
        }
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
