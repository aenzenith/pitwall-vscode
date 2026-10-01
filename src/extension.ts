import * as path from 'path';
import * as vscode from 'vscode';

import { ClaudeWatch } from './claude';
import { hasScript, pickFolder } from './resolve';
import { killOrphan } from './process';
import { adoptOldStorage, OLD_EXTENSION_ID, sharedDir } from './storage';
import { ownedProjects, Registry, type RemoteCommand } from './registry';
import { DevRunner, type Target, targetFromFolder, targetFromPath } from './runner';
import { DevTree, favoriteOf, type ProjectNode } from './tree';

const LAST_FOLDER_KEY = 'pitwall.lastFolderPath';
const LAST_RUNNING_KEY = 'pitwall.lastRunning';

let runner: DevRunner;
let registry: Registry;
let tree: DevTree;
let statusItem: vscode.StatusBarItem;
let restartItem: vscode.StatusBarItem;
let countItem: vscode.StatusBarItem;
let claudeItem: vscode.StatusBarItem;
let claude: ClaudeWatch;
let state: vscode.Memento;

/** folderPath|script -> script var mı. package.json değişince temizlenir. */
const scriptCache = new Map<string, boolean>();

let refreshToken = 0;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    state = context.workspaceState;
    const shared = sharedDir();
    const ownStorage = context.globalStorageUri.fsPath;

    // Eski yerler: bu kimliğin kendi deposu, sonra silinen `aenzenith.pitwall` kimliğininki.
    adoptOldStorage(shared, [ownStorage, path.join(path.dirname(ownStorage), OLD_EXTENSION_ID)]);
    registry = new Registry(shared, vscode.workspace.name ?? 'VSCode');
    runner = new DevRunner(() => void sync(), { dir: shared, windowId: registry.windowId });
    claude = new ClaudeWatch(shared);
    tree = new DevTree(runner, registry, claude, context.extensionUri);

    statusItem = vscode.window.createStatusBarItem('pitwall.main', vscode.StatusBarAlignment.Left, 100);
    statusItem.command = 'pitwall.toggle';

    restartItem = vscode.window.createStatusBarItem('pitwall.restart', vscode.StatusBarAlignment.Left, 99);
    restartItem.command = 'pitwall.restart';
    restartItem.text = '$(refresh) npm dev reload';
    restartItem.tooltip = vscode.l10n.t('Restart the dev server');

    countItem = vscode.window.createStatusBarItem('pitwall.count', vscode.StatusBarAlignment.Left, 101);
    countItem.command = 'pitwall.focusView';

    claudeItem = vscode.window.createStatusBarItem('pitwall.claude', vscode.StatusBarAlignment.Left, 102);
    claudeItem.command = 'pitwall.showClaudePending';
    claudeItem.color = new vscode.ThemeColor('charts.orange');

    const packageJsonWatcher = vscode.workspace.createFileSystemWatcher('**/package.json');
    const onPackageJsonChange = (): void => {
        scriptCache.clear();
        void sync();
    };

    registry.on('changed', () => tree.refresh());
    claude.on('changed', () => {
        tree.refresh();
        drawClaudeItem();
    });
    registry.on('command', (command: RemoteCommand) => void handleRemoteCommand(command));

    context.subscriptions.push(
        statusItem,
        restartItem,
        countItem,
        claudeItem,
        runner,
        tree,
        { dispose: () => registry.dispose() },
        vscode.window.registerTreeDataProvider('pitwall.view', tree),
        packageJsonWatcher,
        packageJsonWatcher.onDidChange(onPackageJsonChange),
        packageJsonWatcher.onDidCreate(onPackageJsonChange),
        packageJsonWatcher.onDidDelete(onPackageJsonChange),
        vscode.window.onDidChangeActiveTextEditor(() => void sync()),
        vscode.window.onDidChangeWindowState(() => scanClaude()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => void sync()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('pitwall')) {
                scriptCache.clear();
                void sync();
            }
        }),
        vscode.commands.registerCommand('pitwall.toggle', () => runHere((target) => runner.toggle(target))),
        vscode.commands.registerCommand('pitwall.restart', () => runHere((target) => runner.restart(target))),
        vscode.commands.registerCommand('pitwall.stop', () => runHere((target) => runner.stop(target.path))),
        vscode.commands.registerCommand('pitwall.startAll', () => void startEverywhere()),
        vscode.commands.registerCommand('pitwall.stopAll', () => void stopEverywhere()),
        vscode.commands.registerCommand('pitwall.restartAll', () => void restartEverywhere()),
        vscode.commands.registerCommand('pitwall.refresh', () => tree.refresh()),
        vscode.commands.registerCommand('pitwall.focusView', () =>
            vscode.commands.executeCommand('pitwall.view.focus'),
        ),
        vscode.commands.registerCommand('pitwall.startNode', (node: ProjectNode) => void act(node, 'start')),
        vscode.commands.registerCommand('pitwall.stopNode', (node: ProjectNode) => void act(node, 'stop')),
        vscode.commands.registerCommand('pitwall.restartNode', (node: ProjectNode) => void act(node, 'restart')),
        vscode.commands.registerCommand('pitwall.openUrl', (node: ProjectNode) => void openNodeUrl(node)),
        vscode.commands.registerCommand('pitwall.focusWindow', (node: ProjectNode) => void focusWindow(node)),
        vscode.commands.registerCommand('pitwall.showClaudePending', () => void showClaudePending()),
        vscode.commands.registerCommand('pitwall.toggleFavorite', (node: ProjectNode) => toggleFavorite(node)),
        vscode.commands.registerCommand('pitwall.removeFavorite', (node: ProjectNode) => toggleFavorite(node)),
        vscode.commands.registerCommand('pitwall.addFavorite', () => void addFavorite()),
        vscode.commands.registerCommand('pitwall.showOutput', (node: ProjectNode) =>
            runner.reveal(node.state.folderPath),
        ),
    );

    const ticker = setInterval(() => {
        tree.refresh();
        scanClaude();
    }, 5000);
    context.subscriptions.push({ dispose: () => clearInterval(ticker) });

    void reapOrphans();
    scanClaude();
    await sync();
    await autoStart();
}

/**
 * Eklenti çökerse `deactivate` koşmaz ve süreçler öksüz kalır.
 * Açılışta ölü pencerelerin bıraktığı süreç grupları kapatılır.
 */
async function reapOrphans(): Promise<void> {
    const orphans = registry.takeOrphans();
    let killed = 0;

    for (const orphan of orphans) {
        if (await killOrphan(orphan.pid)) {
            killed += 1;
        }
    }

    if (killed > 0) {
        vscode.window.setStatusBarMessage(
            vscode.l10n.t('Pitwall: closed {0} orphaned dev processes', String(killed)),
            6000,
        );
    }
}

export function deactivate(): void {
    runner?.dispose();
    registry?.dispose();
}

/* ---------- durum yayını ---------- */

/** Durum çubuğunu çizer, ağacı tazeler, durumu diğer pencerelere duyurur. */
async function sync(): Promise<void> {
    tree.refresh();
    publish();
    await state.update(LAST_RUNNING_KEY, runner.runningPaths());
    await drawStatusBar();
}

/**
 * Bu pencere YALNIZ kendi kök klasörlerini ve burada çalıştırdığı projeleri duyurur.
 * Favoriler ortak listedir; onları da yayınlamak her pencerenin her favoriye
 * "bu bende açık" demesine yol açar.
 */
function publish(): void {
    const targets = tree.localTargets();
    const known = new Set(targets.map((target) => target.path));

    for (const folderPath of runner.runningPaths()) {
        if (!known.has(folderPath)) {
            targets.push(targetFromPath(folderPath));
        }
    }

    registry.publish(
        targets.map((target) => runner.stateOf(target)),
        tree.localTargets().map((target) => target.path),
    );
    registry.recordPids(runner.pids());
}

async function drawStatusBar(): Promise<void> {
    const token = ++refreshToken;
    const totals = tree.runningTotals();

    if (totals.everywhere > 0) {
        countItem.text = `$(play) ${totals.everywhere}`;
        countItem.tooltip = vscode.l10n.t(
            '{0} in this window · {1} in total — open the panel',
            String(totals.here),
            String(totals.everywhere),
        );
        countItem.show();
    } else {
        countItem.hide();
    }

    const folder = resolveFolder();

    if (!folder) {
        hideMain();

        return;
    }

    const script = vscode.workspace.getConfiguration('pitwall', folder.uri).get<string>('script', 'dev');

    if (!(await scriptAvailable(folder, script))) {
        if (token === refreshToken) {
            hideMain();
        }

        return;
    }

    if (token !== refreshToken) {
        return;
    }

    const target = targetFromFolder(folder);

    if (runner.isBusy(target.path)) {
        statusItem.text = '$(sync~spin) npm dev reload';
        statusItem.tooltip = vscode.l10n.t('Restarting… — {0}', folder.name);
    } else if (runner.isRunning(target.path)) {
        statusItem.text = '$(primitive-square) npm dev stop';
        statusItem.tooltip = new vscode.MarkdownString(
            vscode.l10n.t('`{0}` is running — **{1}**\n\nClick to stop.', script, folder.name),
        );
    } else {
        statusItem.text = '$(play) npm dev start';
        statusItem.tooltip = new vscode.MarkdownString(
            vscode.l10n.t('Run `{0}` in **{1}**.', script, folder.name),
        );
    }

    restartItem.tooltip = new vscode.MarkdownString(
        vscode.l10n.t('**{0}** — restart `{1}`.', folder.name, script),
    );
    statusItem.show();
    restartItem.show();
}

function hideMain(): void {
    statusItem.hide();
    restartItem.hide();
}

/* ---------- Claude oturumları ---------- */

/**
 * Paneldeki projelerin Claude oturumlarını tarar. Odaktaki pencerenin kendi
 * köklerinde biten iş görülmüş sayılır; işaret yalnız bakılmayan yerlerde çıkar.
 */
function scanClaude(): void {
    const lookingAt = vscode.window.state.focused ? tree.localTargets().map((target) => target.path) : [];

    claude.scan(
        tree.allNodes().map((node) => node.state.folderPath),
        lookingAt,
    );
}

function drawClaudeItem(): void {
    const names = claudePendingNodes().map((node) => node.state.name);

    if (names.length === 0) {
        claudeItem.hide();

        return;
    }

    claudeItem.text = `$(circle-small-filled) ${names.length}`;
    claudeItem.tooltip = vscode.l10n.t('Claude is waiting in: {0}', names.join(', '));
    claudeItem.show();
}

function claudePendingNodes(): ProjectNode[] {
    const pending = new Set(claude.pendingPaths());
    const seen = new Set<string>();

    return tree.allNodes().filter((node) => {
        const folderPath = node.state.folderPath;

        if (!pending.has(folderPath) || seen.has(folderPath)) {
            return false;
        }

        seen.add(folderPath);

        return true;
    });
}

/** Durum çubuğu rozeti: tek iş varsa doğrudan penceresine, birden fazlaysa seçtirir. */
async function showClaudePending(): Promise<void> {
    const nodes = claudePendingNodes();

    if (nodes.length === 0) {
        return;
    }

    if (nodes.length === 1) {
        await focusWindow(nodes[0]);

        return;
    }

    const picked = await vscode.window.showQuickPick(
        nodes.map((node) => ({ label: node.state.name, description: node.state.folderPath, node })),
        { placeHolder: vscode.l10n.t('Which project should open?') },
    );

    if (picked) {
        await focusWindow(picked.node);
    }
}

/* ---------- otomatik başlatma ---------- */

/**
 * Pencere açılınca dev sunucularını kaldırır. Aynı projeyi başka pencere
 * zaten çalıştırıyorsa atlanır; portlar çakışmasın diye aralarında bekleme var.
 */
async function autoStart(): Promise<void> {
    const mode = vscode.workspace.getConfiguration('pitwall').get<string>('autoStart', 'off');

    if (mode === 'off') {
        return;
    }

    const wanted = pickAutoStartTargets(mode);

    for (const [index, target] of wanted.entries()) {
        if (runner.isRunning(target.path) || registry.findWindowFor(target.path)) {
            continue;
        }

        const script = vscode.workspace.getConfiguration('pitwall', target.uri).get<string>('script', 'dev');

        if (!(await scriptAvailableAt(target, script))) {
            continue;
        }

        if (index > 0) {
            await wait(1500);
        }

        await runner.start(target, vscode.workspace.getConfiguration('pitwall').get<boolean>('autoStartOpensUrl', false));
    }
}

function pickAutoStartTargets(mode: string): Target[] {
    if (mode === 'favorites') {
        return registry.readFavorites().map((favorite) => targetFromPath(favorite.path, favorite.name));
    }

    if (mode === 'workspace') {
        return tree.localTargets();
    }

    const remembered = state.get<string[]>(LAST_RUNNING_KEY, []);

    return remembered.map((folderPath) => targetFromPath(folderPath));
}

/* ---------- panel eylemleri ---------- */

async function act(node: ProjectNode, action: 'start' | 'stop' | 'restart'): Promise<void> {
    if (node.windowId) {
        registry.send({ target: node.windowId, action, folderPath: node.state.folderPath });

        return;
    }

    const target = targetFromPath(node.state.folderPath, node.state.name);

    if (action === 'stop') {
        await runner.stop(target.path);

        return;
    }

    if (action === 'restart') {
        await runner.restart(target);

        return;
    }

    await runner.start(target);
}

async function handleRemoteCommand(command: RemoteCommand): Promise<void> {
    const target = targetFromPath(command.folderPath);

    if (command.action === 'stop') {
        await runner.stop(target.path);

        return;
    }

    if (command.action === 'restart') {
        await runner.restart(target);

        return;
    }

    await runner.start(target, false);
}

/**
 * Adres düğmesi. Sunucunun bastığı vite adresi değil, projenin gerçek adresi açılır:
 * ayar > `.env` APP_URL > Herd varsayılanı > (başka yoksa) sunucunun adresi.
 */
async function openNodeUrl(node: ProjectNode): Promise<void> {
    const target = targetFromPath(node.state.folderPath, node.state.name);
    const url = await runner.resolveUrl(target, node.state.url);

    if (!url) {
        await focusWindow(node);

        return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * Satıra tıklayınca projenin penceresine gider — dev çalışsın ya da çalışmasın.
 * Pencereyi öne getirmenin API'si yok; klasörü `vscode://` ile açmak o pencereyi odaklar,
 * hiç açık değilse yeni pencerede açar.
 */
async function focusWindow(node: ProjectNode): Promise<void> {
    claude.markSeen(node.state.folderPath);

    const local = tree.localTargets().some((target) => target.path === node.state.folderPath);

    if (local) {
        return;
    }

    if (node.windowId) {
        // `vscode://file/<yol>`: Uri.file yolu her platformda `/c:/…` biçimine çevirir.
        const folder = vscode.Uri.file(node.state.folderPath);

        await vscode.env.openExternal(
            vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: 'file', path: folder.path }),
        );

        return;
    }

    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.state.folderPath), {
        forceNewWindow: true,
    });
}

/** Listedeki bütün çalışan sunucuları durdurur — başka pencerelerdekiler dahil. */
async function stopEverywhere(): Promise<void> {
    for (const peer of registry.readPeers()) {
        for (const project of ownedProjects(peer)) {
            if (project.running) {
                registry.send({ target: peer.windowId, action: 'stop', folderPath: project.folderPath });
            }
        }
    }

    await runner.stopAll();
}

/** Paneldeki durmuş bütün projeleri başlatır — favoriler ve başka pencereler dahil. */
async function startEverywhere(): Promise<void> {
    const idle = tree.allNodes().filter((node) => !node.state.running);

    for (const [index, node] of idle.entries()) {
        if (index > 0) {
            await wait(1000);
        }

        await act(node, 'start');
    }
}

/** Paneldeki çalışan bütün projeleri yeniden başlatır. */
async function restartEverywhere(): Promise<void> {
    const running = tree.allNodes().filter((node) => node.state.running);

    for (const [index, node] of running.entries()) {
        if (index > 0) {
            await wait(1000);
        }

        await act(node, 'restart');
    }
}

function toggleFavorite(node: ProjectNode): void {
    registry.toggleFavorite(favoriteOf(node));
    tree.refresh();
}

/** Panele, bu pencerede açık olmayan bir klasörü favori olarak ekler. */
async function addFavorite(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t('Add to favourites'),
    });

    if (!picked || picked.length === 0) {
        return;
    }

    const target = targetFromPath(picked[0].fsPath);

    registry.toggleFavorite({ path: target.path, name: target.name });
    tree.refresh();
}

/* ---------- durum çubuğu komutları ---------- */

async function runHere(action: (target: Target) => Promise<void>): Promise<void> {
    const folder = resolveFolder() ?? (await askForFolder());

    if (!folder) {
        return;
    }

    await state.update(LAST_FOLDER_KEY, folder.uri.fsPath);
    await action(targetFromFolder(folder));
}

function resolveFolder(): vscode.WorkspaceFolder | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activePath = activeUri?.scheme === 'file' ? activeUri.fsPath : undefined;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        path: folder.uri.fsPath,
        name: folder.name,
        folder,
    }));

    return pickFolder(activePath, folders, state.get<string>(LAST_FOLDER_KEY))?.folder;
}

async function askForFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (folders.length === 0) {
        void vscode.window.showWarningMessage(vscode.l10n.t('Pitwall: no folder is open.'));

        return undefined;
    }

    const picked = await vscode.window.showQuickPick(
        folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
        { placeHolder: vscode.l10n.t('Which project should the dev server start in?') },
    );

    return picked?.folder;
}

/* ---------- yardımcılar ---------- */

async function scriptAvailable(folder: vscode.WorkspaceFolder, script: string): Promise<boolean> {
    return scriptAvailableAt(targetFromFolder(folder), script);
}

async function scriptAvailableAt(target: Target, script: string): Promise<boolean> {
    const key = `${target.path}|${script}`;
    const cached = scriptCache.get(key);

    if (cached !== undefined) {
        return cached;
    }

    let available = false;

    try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(target.uri, 'package.json'));
        available = hasScript(Buffer.from(raw).toString('utf8'), script);
    } catch {
        available = false;
    }

    scriptCache.set(key, available);

    return available;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
