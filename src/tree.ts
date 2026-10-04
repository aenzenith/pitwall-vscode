import * as path from 'path';
import * as vscode from 'vscode';

import type { ClaudeWatch } from './claude';
import { locate, ownedProjects, type Favorite, type ProjectState, type Registry } from './registry';
import type { DevRunner, Target } from './runner';
import { targetFromFolder, targetFromPath } from './runner';

type Scope = 'local' | 'favorite' | 'remote';

type IconState = 'running' | 'idle' | 'closed' | 'crashed' | 'issue';

const THEME_ICONS: Record<IconState, () => vscode.ThemeIcon> = {
    crashed: () => new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
    issue: () => new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')),
    running: () => new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed')),
    closed: () => new vscode.ThemeIcon('circle-slash'),
    idle: () => new vscode.ThemeIcon('circle-outline'),
};

export type ProjectNode = {
    kind: 'project';
    scope: Scope;
    state: ProjectState;
    favorite: boolean;
    /** Projeyi açık tutan başka pencere varsa onun kimliği. */
    windowId?: string;
    windowTitle?: string;
};

type GroupNode = {
    kind: 'group';
    id: string;
    label: string;
    detail: string;
};

export type Node = GroupNode | ProjectNode;

/**
 * Panel ağacı: bu pencerenin kökleri, favoriler ve açık diğer pencereler.
 */
export class DevTree implements vscode.TreeDataProvider<Node> {
    private readonly emitter = new vscode.EventEmitter<Node | undefined>();

    public readonly onDidChangeTreeData = this.emitter.event;

    public constructor(
        private readonly runner: DevRunner,
        private readonly registry: Registry,
        private readonly claude: ClaudeWatch,
        private readonly extensionUri: vscode.Uri,
    ) {}

    public refresh(): void {
        this.emitter.fire(undefined);
    }

    public dispose(): void {
        this.emitter.dispose();
    }

    /** Bu pencerede açık olan kök klasörler. */
    public localTargets(): Target[] {
        return (vscode.workspace.workspaceFolders ?? []).map(targetFromFolder);
    }

    /** Panelde görünen her satırın hedefi — favoriler dahil. */
    public allTargets(): Target[] {
        const targets = this.localTargets();
        const seen = new Set(targets.map((target) => target.path));

        for (const favorite of this.registry.readFavorites()) {
            if (!seen.has(favorite.path)) {
                targets.push(targetFromPath(favorite.path, favorite.name));
                seen.add(favorite.path);
            }
        }

        return targets;
    }

    public getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'group') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
            item.description = node.detail;
            item.contextValue = `group.${node.id}`;

            return item;
        }

        return this.projectItem(node);
    }

    public getChildren(node?: Node): Node[] {
        if (!node) {
            return this.groups();
        }

        if (node.kind === 'group') {
            return this.projectsOf(node.id);
        }

        return [];
    }

    /** Durum çubuğu rozeti için: bütün pencerelerde çalışan sayısı. */
    public runningTotals(): { here: number; everywhere: number } {
        const here = this.runner.runningPaths().length;
        const everywhere = this.registry
            .readWindows()
            .reduce((total, record) => total + ownedProjects(record).filter((project) => project.running).length, 0);

        return { here, everywhere };
    }

    /** Paneldeki bütün proje satırları — üç grubun tamamı. */
    public allNodes(): ProjectNode[] {
        return [...this.projectsOf('local'), ...this.projectsOf('favorite'), ...this.projectsOf('remote')];
    }

    private groups(): GroupNode[] {
        const groups: GroupNode[] = [];
        const local = this.projectsOf('local');
        const favorites = this.projectsOf('favorite');
        const remote = this.projectsOf('remote');

        if (local.length > 0) {
            groups.push({ kind: 'group', id: 'local', label: vscode.l10n.t('This window'), detail: summarize(local) });
        }

        if (favorites.length > 0) {
            groups.push({ kind: 'group', id: 'favorite', label: vscode.l10n.t('Favourites'), detail: summarize(favorites) });
        }

        if (remote.length > 0) {
            groups.push({ kind: 'group', id: 'remote', label: vscode.l10n.t('Other windows'), detail: summarize(remote) });
        }

        return groups;
    }

    private projectsOf(scope: string): ProjectNode[] {
        const favorites = this.registry.readFavorites();
        const isFavorite = (folderPath: string): boolean => favorites.some((item) => item.path === folderPath);
        const localPaths = new Set(this.localTargets().map((target) => target.path));
        const peers = this.registry.readPeers();

        if (scope === 'local') {
            const nodes = this.localTargets().map((target): ProjectNode => {
                // Bu pencerenin kökü başka yerde (ör. Pitwall uygulamasında) çalışıyorsa onu göster;
                // düğmeler oraya gider, aynı proje iki kez başlatılmaz.
                const elsewhere = this.runner.isRunning(target.path) ? undefined : this.registry.findRunnerFor(target.path);

                return {
                    kind: 'project',
                    scope: 'local',
                    state: elsewhere?.project ?? this.runner.stateOf(target),
                    favorite: isFavorite(target.path),
                    windowId: elsewhere?.record.windowId,
                    windowTitle: elsewhere?.record.title,
                };
            });

            // Burada çalışan ama ne kök ne favori olan proje (çalışırken favoriden çıkarıldı):
            // satırı kaybolmasın, durdurulabilsin.
            for (const folderPath of this.runner.runningPaths()) {
                if (!localPaths.has(folderPath) && !isFavorite(folderPath)) {
                    nodes.push({
                        kind: 'project',
                        scope: 'local',
                        state: this.runner.stateOf(targetFromPath(folderPath)),
                        favorite: false,
                    });
                }
            }

            return nodes;
        }

        if (scope === 'favorite') {
            return favorites
                .filter((favorite) => !localPaths.has(favorite.path))
                .map((favorite) => this.remoteOrClosed(favorite, peers, true));
        }

        const nodes: ProjectNode[] = [];
        const seen = new Set<string>();

        for (const peer of peers) {
            for (const { folderPath } of ownedProjects(peer)) {
                // Burada çalışan proje "Bu pencere"de durur; iki katılımcının sahiplendiği tek satırdır.
                if (
                    localPaths.has(folderPath) ||
                    isFavorite(folderPath) ||
                    seen.has(folderPath) ||
                    this.runner.isRunning(folderPath)
                ) {
                    continue;
                }

                seen.add(folderPath);

                const place = locate(peers, folderPath);

                if (place) {
                    nodes.push({
                        kind: 'project',
                        scope: 'remote',
                        state: place.project,
                        favorite: false,
                        windowId: place.record.windowId,
                        windowTitle: place.record.title,
                    });
                }
            }
        }

        return nodes;
    }

    /**
     * Favori: burada çalışıyorsa buradaki durumu, başka katılımcıdaysa (çalıştıran, yoksa açık
     * tutan) oradakini gösterir; hiçbiri değilse kapalı satır.
     */
    private remoteOrClosed(
        favorite: Favorite,
        peers: ReturnType<Registry['readPeers']>,
        isFavorite: boolean,
    ): ProjectNode {
        const place = this.runner.isRunning(favorite.path) ? undefined : locate(peers, favorite.path);

        if (place) {
            return {
                kind: 'project',
                scope: 'favorite',
                state: place.project,
                favorite: isFavorite,
                windowId: place.record.windowId,
                windowTitle: place.record.title,
            };
        }

        const target = targetFromPath(favorite.path, favorite.name);

        return {
            kind: 'project',
            scope: 'favorite',
            state: this.runner.stateOf(target),
            favorite: isFavorite,
        };
    }

    private projectItem(node: ProjectNode): vscode.TreeItem {
        const { state } = node;
        const busy = this.runner.isBusy(state.folderPath);
        const item = new vscode.TreeItem(state.name, vscode.TreeItemCollapsibleState.None);

        item.description = this.describe(node, busy);
        item.tooltip = this.tooltip(node);
        item.iconPath = this.icon(node, busy);
        item.contextValue = this.contextValue(node);
        item.command = {
            command: 'pitwall.focusWindow',
            title: vscode.l10n.t('Go to its window'),
            arguments: [node],
        };

        return item;
    }

    private describe(node: ProjectNode, busy: boolean): string {
        if (busy) {
            return vscode.l10n.t('restarting…');
        }

        return node.state.issue?.text ?? windowLabel(node);
    }

    private tooltip(node: ProjectNode): vscode.MarkdownString {
        const lines = [`**${node.state.name}**`, '', `\`${node.state.folderPath}\``];

        if (node.state.issue) {
            lines.push('', `**${node.state.issue.text}**`, '', vscode.l10n.t('Open the output for details.'));
        }

        const turn = this.claude.pendingFor(node.state.folderPath);

        if (turn) {
            const time = new Date(turn.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            lines.push(
                '',
                turn.kind === 'asking'
                    ? vscode.l10n.t('Claude asked a question at {0} — waiting for your answer.', time)
                    : vscode.l10n.t('Claude finished at {0} — not looked at yet.', time),
            );
        }

        if (node.state.url) {
            lines.push('', node.state.url);
        }

        if (node.windowTitle) {
            lines.push('', vscode.l10n.t('Window: {0}', node.windowTitle));
        } else if (node.scope === 'favorite' && !node.state.running) {
            lines.push('', vscode.l10n.t('Window closed — starting it runs the server from this window.'));
        }

        return new vscode.MarkdownString(lines.join('\n'));
    }

    /**
     * Bakılmamış Claude işi varsa durum ikonunun turuncu noktalı SVG eşi çizilir;
     * ThemeIcon üstüne rozet koymanın API'si yok.
     */
    private icon(node: ProjectNode, busy: boolean): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
        if (busy) {
            return new vscode.ThemeIcon('sync~spin');
        }

        const state = iconState(node);

        if (!this.claude.pendingFor(node.state.folderPath)) {
            return THEME_ICONS[state]();
        }

        const dir = vscode.Uri.joinPath(this.extensionUri, 'resources', 'claude');

        return {
            light: vscode.Uri.joinPath(dir, `${state}-light.svg`),
            dark: vscode.Uri.joinPath(dir, `${state}-dark.svg`),
        };
    }

    /**
     * Satır içi düğmeleri seçen anahtar: `project.<kapsam>.<durum>.<fav|nofav>`.
     * Yıldız ikonu komuta bağlı olduğu için favori/değil iki ayrı komutla çizilir.
     */
    private contextValue(node: ProjectNode): string {
        const where = node.windowId ? 'remote' : 'here';
        const state = node.state.running ? 'running' : 'idle';

        return `project.${where}.${state}.${node.favorite ? 'fav' : 'nofav'}`;
    }
}

function iconState(node: ProjectNode): IconState {
    const issue = node.state.issue;

    if (issue?.kind === 'crashed') {
        return 'crashed';
    }

    if (issue) {
        return 'issue';
    }

    if (node.state.running) {
        return 'running';
    }

    return node.scope === 'favorite' && !node.windowId ? 'closed' : 'idle';
}

/**
 * Pencere başlığı yalnız proje adından farklıysa yazılır.
 * Tek klasörlü pencerede başlık = klasör adıdır; yoksa satırda ad iki kez görünür.
 */
function windowLabel(node: ProjectNode): string {
    if (!node.windowTitle) {
        return '';
    }

    if (node.scope === 'local') {
        return vscode.l10n.t('running in {0}', node.windowTitle);
    }

    return node.windowTitle === node.state.name ? '' : node.windowTitle;
}

function summarize(nodes: ProjectNode[]): string {
    const running = nodes.filter((node) => node.state.running).length;

    return running > 0 ? vscode.l10n.t('{0} running', String(running)) : '';
}

export function favoriteOf(node: ProjectNode): Favorite {
    return { path: node.state.folderPath, name: node.state.name || path.basename(node.state.folderPath) };
}
