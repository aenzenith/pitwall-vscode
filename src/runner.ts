import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

import { OutputMirror, outputPath } from './output';
import { findFreePort, isPortServed } from './ports';
import { killTree, spawnShell } from './process';
import type { ProjectIssue, ProjectState } from './registry';
import {
    buildCommand,
    detectErrorLine,
    detectPackageManager,
    detectPortConflict,
    diedOnBusyPort,
    hasScript,
    herdFallbackUrl,
    isProbed,
    isUnsafeScript,
    isUpdateLine,
    nextAddress,
    parseAppUrl,
    parseVitePort,
    resolveWorkingFolder,
    type PackageManager,
    type ServerAddress,
} from './resolve';

/** Dev çalıştırılabilecek bir klasör. Workspace kökü ya da favori olabilir. */
export type Target = {
    path: string;
    name: string;
    uri: vscode.Uri;
};

/** Sürecin çıktı akışlarından biri. */
type Stream = 'stdout' | 'stderr';

/** Arka planda koşan bir dev sunucusu. */
type Run = {
    child: ChildProcess;
    /** Koşu boyunca yazılanlar Output kanalına ve paylaşılan dosyaya birlikte gider. */
    channel: Pick<vscode.OutputChannel, 'append' | 'appendLine'>;
    mirror?: OutputMirror;
    /** Paylaşılan çıktı dosyası, kayıt klasörüne göre (bkz. `outputPath`). */
    output?: string;
    startedAt: number;
    /**
     * Her akışın henüz bitmemiş son satırı: bir sonraki parçayla birlikte, akış kapanınca da tek
     * başına okunur.
     */
    partial: Record<Stream, string>;
    /** Adres bulunduğunda tarayıcıda açılacak mı. */
    openUrl: boolean;
    settled: boolean;
    timer?: ReturnType<typeof setTimeout>;
    url?: string;
    port?: number;
    /**
     * Pitwall'ın sunucuyu başlattığı port (ayardaki, vite.config'teki ya da yerine verilen boş
     * port); script portunu kendi seçiyorsa undefined.
     */
    asked?: number;
    /** Çıktıdan okunan adres ve ne kadar kesin olduğu (`url` ve `port` ondan gelir). */
    address?: ServerAddress;
    /**
     * Bilerek durduruldu: çıkışı çökme sayılmaz. Çıkış olayı `stop` bittikten sonra da gelebilir
     * (TERM'den sonra KILL giden grup); o yüzden proje değil koşu işaretlenir.
     */
    stopped?: boolean;
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
 * Dev sunucusunun çalıştığı klasör: `pitwall.workingFolder`, boşsa projenin kendisi; proje dışına
 * çıkan ya da olmayan klasörde undefined (bkz. `resolveWorkingFolder`). Yalnız okunan ve
 * çalıştırılan buradandır; anahtar, kayıt, favori ve Claude eşleşmesi projenin kendi yolunda kalır.
 * Yol projenin yazılışıyla başlar; adres projeninkinden türer, uzak bağlantıda da aynı yere gider.
 *
 * @param setting Ayarın değeri; verilmezse projenin ayarından okunur.
 */
export function workingFolderOf(target: Target, setting?: string): Pick<Target, 'path' | 'uri'> | undefined {
    const wanted = setting ?? vscode.workspace.getConfiguration('pitwall', target.uri).get<string>('workingFolder', '');
    const dir = resolveWorkingFolder(target.path, wanted);

    if (dir === undefined) {
        return undefined;
    }

    const inner = path.relative(target.path, dir);

    if (inner === '') {
        return { path: target.path, uri: target.uri };
    }

    return { path: dir, uri: vscode.Uri.joinPath(target.uri, ...inner.split(path.sep)) };
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

    /**
     * Son elle başlatmadan beri dolu porttan taşınmış projeler: başlatma başına bir kez, port dolu
     * kaldıkça sunucu durmadan taşınmasın.
     */
    private readonly retried = new Set<string>();

    /** Bu oturumda dağıtılmış portlar: port -> dağıtım anı ve alan proje. */
    private readonly reserved = new Map<number, { at: number; folderPath: string }>();

    /**
     * Başlatılmakta olanlar. Kontrol ile `runs`a yazılma arasında birkaç await var; bu arada gelen
     * ikinci başlatma (iki tık, art arda iki reload) ikinci bir sunucu açar, biri sahipsiz kalırdı.
     */
    private readonly starting = new Set<string>();

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
     * Elle başlatma: yeniden başlatma sayacı ve dolu porttan bir kez taşınma hakkı sıfırlanır.
     *
     * @param openUrl Sunucu hazır olunca tarayıcıda adres açılsın mı. Reload'da açılmaz.
     * @param extraArgs Script'e geçirilecek ek argüman, ör. `['--port', '5176']`.
     */
    public async start(target: Target, openUrl = true, extraArgs: readonly string[] = []): Promise<void> {
        this.attempts.delete(target.path);
        this.retried.delete(target.path);
        await this.launch(target, openUrl, extraArgs);
    }

    /** Elle başlatmadan farkı: başarısızlık sayacına dokunmaz. Otomatik kurtarma buradan geçer. */
    private async launch(target: Target, openUrl: boolean, extraArgs: readonly string[] = []): Promise<void> {
        if (this.starting.has(target.path)) {
            return;
        }

        this.starting.add(target.path);

        try {
            await this.spawnRun(target, openUrl, extraArgs);
        } finally {
            this.starting.delete(target.path);
        }
    }

    private async spawnRun(target: Target, openUrl: boolean, extraArgs: readonly string[]): Promise<void> {
        if (this.runs.has(target.path)) {
            this.reveal(target.path);

            return;
        }

        const config = vscode.workspace.getConfiguration('pitwall', target.uri);
        const script = config.get<string>('script', 'dev');

        if (isUnsafeScript(script)) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Pitwall will not run this script: "{0}"', script));

            return;
        }

        const setting = config.get<string>('workingFolder', '');
        const work = workingFolderOf(target, setting);

        if (!work) {
            void vscode.window.showErrorMessage(
                vscode.l10n.t(
                    '{0}: the working folder "{1}" is not a folder inside the project.',
                    target.name,
                    setting.trim(),
                ),
            );

            return;
        }

        if (!(await this.scriptExists(work.uri, script))) {
            void vscode.window.showErrorMessage(
                vscode.l10n.t('{0}: package.json has no "{1}" script.', target.name, script),
            );

            return;
        }

        const manager = await this.resolvePackageManager(work.uri, config);
        const { args, port: asked } =
            extraArgs.length > 0
                ? { args: extraArgs, port: portArg(extraArgs) }
                : await this.freePortArgs(target, work.uri, config);
        const command = buildCommand(manager, script, args);
        const channel = this.channelFor(target);

        channel.clear();
        channel.appendLine(`$ ${command}`);
        channel.appendLine(`  ${work.path}`);
        channel.appendLine('');

        const child = spawnShell(command, work.path);
        const startedAt = Date.now();
        const output = this.shared ? outputPath(this.shared.windowId, target.path, startedAt) : undefined;
        const mirror = this.shared && output ? new OutputMirror(path.join(this.shared.dir, output)) : undefined;

        mirror?.append(`$ ${command}\n  ${work.path}\n\n`);

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
            partial: { stdout: '', stderr: '' },
            openUrl: openUrl && config.get<boolean>('openUrlOnStart', false),
            settled: false,
            asked,
        };

        this.runs.set(target.path, run);
        this.issues.delete(target.path);
        this.lastTargets.set(target.path, target);

        if (config.get<boolean>('revealTerminal', false)) {
            channel.show(true);
        }

        child.stdout?.on('data', (chunk: Buffer) => void this.consume(target, run, 'stdout', chunk.toString()));
        child.stderr?.on('data', (chunk: Buffer) => void this.consume(target, run, 'stderr', chunk.toString()));
        child.stdout?.on('end', () => void this.consumeRest(target, run, 'stdout'));
        child.stderr?.on('end', () => void this.consumeRest(target, run, 'stderr'));

        child.once('error', (error: Error) => {
            channel.appendLine(`\n[pitwall] ${vscode.l10n.t('could not start: {0}', error.message)}`);
            this.forget(target.path, run);
        });

        child.once('exit', (code, signal) => {
            channel.appendLine(
                `\n[pitwall] ${vscode.l10n.t('process ended (code {0}, signal {1})', String(code ?? '-'), String(signal ?? '-'))}`,
            );

            const planned = run.stopped === true;

            this.forget(target.path, run);

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

        run.stopped = true;
        this.busy.add(folderPath);
        this.issues.delete(folderPath);
        this.onChange();

        try {
            await this.kill(run, folderPath);
        } finally {
            this.forget(folderPath, run);
            this.busy.delete(folderPath);
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

    private async consume(target: Target, run: Run, stream: Stream, text: string): Promise<void> {
        run.channel.append(text);

        // Satır iki parça arasında bölünebilir: yarım kalan sonu bir sonraki parçayla birlikte
        // okunur. Her satır bir kez ve tek başına okunur; çıktının sonu her parçada baştan taranmaz.
        const lines = `${run.partial[stream]}${text}`.split('\n');

        run.partial[stream] = (lines.pop() ?? '').slice(-4096);
        await this.readLines(target, run, lines);
    }

    /** Akış kapandı: satır sonu gelmeden kalan son satır da okunur (en son basılan hata ya da adres). */
    private async consumeRest(target: Target, run: Run, stream: Stream): Promise<void> {
        const rest = run.partial[stream];

        run.partial[stream] = '';

        if (rest !== '') {
            await this.readLines(target, run, [rest]);
        }
    }

    /**
     * Satırları sırayla okur. Süreç çıktıktan sonra gelenler de okunur (çökmenin hatası), ama
     * bilerek durdurulan ya da yerine yenisi başlatılan koşunun kalan satırları okunmaz.
     */
    private async readLines(target: Target, run: Run, lines: readonly string[]): Promise<void> {
        for (const line of lines) {
            const current = this.runs.get(target.path);

            if (run.stopped || (current !== undefined && current !== run)) {
                return;
            }

            await this.readLine(target, run, line);
        }
    }

    /** Çıktının bir satırı: sunucunun adresi, dolu bir port, bir hata ya da Vite'ın aldığı değişiklik. */
    private async readLine(target: Target, run: Run, line: string): Promise<void> {
        const conflict = detectPortConflict(line);

        if (conflict) {
            await this.recoverFromConflict(target, run, conflict);

            return;
        }

        const errorLine = detectErrorLine(line);

        if (errorLine && this.issues.get(target.path)?.kind !== 'crashed') {
            // Bir çökmeden sonra geç gelen son satır, çökme notunun yerine geçmez.
            this.issues.set(target.path, { kind: 'error', text: errorLine });
            this.onChange();
        } else if (isUpdateLine(line) && this.issues.get(target.path)?.kind === 'error') {
            // Sunucu hatadan sonra bir değişiklik aldı: hata giderildi (giderilmediyse hemen
            // ardından yeniden basılır).
            this.issues.delete(target.path);
            this.onChange();
        }

        const address = nextAddress(line, run.address, run.asked);

        if (address) {
            run.address = address;
            run.url = address.url;
            run.port = address.port;
            this.onChange();
            await this.settleUrl(target, address.url);
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
     * Port bilinmiyorsa (adres henüz basılmadıysa) ya da kesin sunucunun değilse (bkz. `isProbed`)
     * dokunulmaz.
     */
    private async checkHealth(): Promise<void> {
        let changed = false;

        for (const [folderPath, run] of this.runs) {
            if (!run.port || !isProbed(run.address) || this.busy.has(folderPath)) {
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

        // Bu arada başka bir portta bir URL daha basıldı, adres belirsizleşti: sessiz port artık
        // sunucunun sayılmaz.
        if (!isProbed(run.address) || (await isPortServed(run.port))) {
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

    /**
     * Sunucunun ilk adresi okundu ya da bekleme süresi doldu: durumu işaretle, gerekiyorsa
     * tarayıcıda aç. Adresin kendisini `readLine` yazar; sonra okunan daha kesin bir adres de.
     */
    private async settleUrl(target: Target, localUrl: string | undefined): Promise<void> {
        const run = this.runs.get(target.path);

        if (!run || run.settled) {
            return;
        }

        run.settled = true;
        this.clearTimer(run);

        if (!run.openUrl) {
            return;
        }

        const address = await this.resolveUrl(target, localUrl);

        if (address) {
            await vscode.env.openExternal(vscode.Uri.parse(address));
        }
    }

    /**
     * Sunucu kendi dolu portu yüzünden düştüyse (bkz. `diedOnBusyPort`) sessizce boş porta taşınır.
     * Elle başlatma başına bir kez denenir, döngüye girmesin.
     */
    private async recoverFromConflict(
        target: Target,
        run: Run,
        conflict: { port: number; fatal: boolean },
    ): Promise<void> {
        if (!diedOnBusyPort(conflict, run.address, run.asked) || this.retried.has(target.path)) {
            return;
        }

        const free = await this.reserveFreePort(conflict.port + 1, target.path);

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

    /**
     * Koşuyu bırakır. Yalnız o koşu: durdurma beklerken aynı projenin yeni koşusu başlamış
     * olabilir, o yerinde kalır (yoksa sunucusu sahipsiz kalırdı).
     */
    private forget(folderPath: string, run: Run): void {
        this.clearTimer(run);
        run.mirror?.remove();

        if (this.runs.get(folderPath) !== run) {
            return;
        }

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
     * Sessiz çalışır — kullanıcıya sorulmaz, söylenmez. Port istemeyen projeye (ayarda port yok,
     * vite.config yok) `--port` verilmez: script kendi portunu seçer (Next, Nuxt, Astro dolu
     * porttan kendisi geçer), bazısı bu bayrağı reddeder.
     *
     * @returns Script'e geçirilecek argümanlar ve sunucunun açılması beklenen port (port istemeyen
     *   projede undefined).
     */
    private async freePortArgs(
        target: Target,
        work: vscode.Uri,
        config: vscode.WorkspaceConfiguration,
    ): Promise<{ args: string[]; port?: number }> {
        const base = await this.basePort(work, config);

        if (base === undefined) {
            return { args: [] };
        }

        const free = await this.reserveFreePort(base, target.path);

        if (!free || free === base) {
            return { args: [], port: base };
        }

        return { args: ['--port', String(free)], port: free };
    }

    /**
     * Dinlenmeyen ve bu oturumda az önce dağıtılmamış ilk portu bulur.
     * Toplu başlatmada sunucular henüz dinlemeye başlamadığı için yalnız sokete bakmak yetmez.
     * Projenin kendi ayırdığı port ona yine verilir: yeniden başlatılan sunucu aynı adreste kalır.
     */
    private async reserveFreePort(from: number, folderPath: string): Promise<number | undefined> {
        const now = Date.now();

        for (const [port, { at }] of this.reserved) {
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

            const holder = this.reserved.get(free)?.folderPath;

            if (holder === undefined || holder === folderPath) {
                this.reserved.set(free, { at: Date.now(), folderPath });

                return free;
            }

            candidate = free + 1;
        }

        return undefined;
    }

    /**
     * Projenin istediği port: ayar > vite.config'teki `server.port` > Vite'ın kendi 5173'ü.
     * Ayarda portu ve vite.config'i olmayan proje port istemez: undefined.
     *
     * @param work Çalışma klasörü: vite.config orada aranır.
     */
    private async basePort(work: vscode.Uri, config: vscode.WorkspaceConfiguration): Promise<number | undefined> {
        const configured = config.get<number>('port', 0);

        if (Number.isInteger(configured) && configured > 0) {
            return configured;
        }

        let vite = false;

        for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']) {
            try {
                const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(work, name));
                const port = parseVitePort(Buffer.from(raw).toString('utf8'));

                vite = true;

                if (port) {
                    return port;
                }
            } catch {
                continue;
            }
        }

        return vite ? 5173 : undefined;
    }

    /* ---------- adres ---------- */

    /**
     * Açılacak adres. Sıra kesin: ayar > `.env` içindeki APP_URL > Herd varsayılanı
     * (Laravel projesiyse) > sunucunun kendi adresi. `.env` ve `artisan` çalışma klasöründe
     * aranır (reddedilmişse projenin kendisinde); Herd adı projenin klasör adıdır.
     */
    public async resolveUrl(target: Target, localUrl?: string): Promise<string | undefined> {
        const configured = vscode.workspace
            .getConfiguration('pitwall', target.uri)
            .get<string>('url', '')
            .trim();

        if (configured) {
            return configured;
        }

        const work = workingFolderOf(target)?.uri ?? target.uri;
        const appUrl = await this.readAppUrl(work);

        if (appUrl) {
            return appUrl;
        }

        if (await this.fileExists(vscode.Uri.joinPath(work, 'artisan'))) {
            return herdFallbackUrl(path.basename(target.path));
        }

        return localUrl;
    }

    private async readAppUrl(work: vscode.Uri): Promise<string | undefined> {
        try {
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(work, '.env'));

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
        work: vscode.Uri,
        config: vscode.WorkspaceConfiguration,
    ): Promise<PackageManager> {
        const configured = config.get<string>('packageManager', 'auto');

        if (configured !== 'auto') {
            return configured as PackageManager;
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(work);

            return detectPackageManager(entries.map(([name]) => name));
        } catch {
            return 'npm';
        }
    }

    private async scriptExists(work: vscode.Uri, script: string): Promise<boolean> {
        try {
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(work, 'package.json'));

            return hasScript(Buffer.from(raw).toString('utf8'), script);
        } catch {
            return false;
        }
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Argümanlardaki `--port 5176` değeri; yoksa undefined. */
function portArg(args: readonly string[]): number | undefined {
    const at = args.indexOf('--port');
    const port = at >= 0 ? Number(args[at + 1]) : NaN;

    return Number.isInteger(port) && port > 0 ? port : undefined;
}
