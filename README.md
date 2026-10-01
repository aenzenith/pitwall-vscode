# Pitwall

Jump between project windows and run their npm dev servers — every open VS Code window in one panel.

*[Türkçe](README.tr.md)*

```
┌─ NPM DEV ─────────────── 3 running ───┐
│ This window                            │
│  ● paddock                             │
│ Favourites                             │
│  ● telemetry-api 🔸                    │
│  ⊘ garage-admin                        │
│  ○ pitlane-docs                        │
│  ⊘ apex-cms                            │
│ Other windows                          │
│  ● gridwall.dev                        │
└────────────────────────────────────────┘
```

State lives in the icon: `●` running · `○` stopped · `⊘` favourite whose window is closed.
A small `🔸` after the name means Claude is waiting on you there.
A row shows only the folder name; the window name is added when it differs.

## The panel

- **This window** — the workspace's root folders.
- **Favourites** — the ones you starred. They stay in the list even when their window is
  closed; starting one runs it from this window.
- **Other windows** — projects of the other VS Code windows open right now. Their servers
  can be started and stopped from here.

**Clicking a row goes to that project's window** — running or not. If the window is open it
comes to the front; if the project is not open anywhere, it opens in a **new window**. The
only thing that starts a server is the `▶` button.

Windows talk through a shared directory (the extension's global storage): each one writes its
state and root folders every 5 s, and commands are dropped as files. A window that goes quiet
for 20 s falls off the list. A project belongs to the window that has it as a root folder or
actually runs it; favourites are a shared list and are never claimed by a window.

## Claude sessions

Hand work to Claude in several projects, go do something else, and still not forget to come
back. Pitwall reads Claude Code's session logs (`~/.claude/projects`) for every project in
the panel — CLI and VS Code sessions alike, including ones started in a subfolder.

- **`🔸` next to the name** — Claude finished a turn, or asked a question (`AskUserQuestion`,
  plan approval), and you haven't looked yet. The tooltip says which and when. While Claude is
  still working, nothing is shown.
- **It clears** when that project's window gets focus, or when you click the row or the badge.
  A turn that finishes in the window you are looking at is never flagged.
- **`🔸 2` in the status bar** — how many projects are waiting. Click it to jump to the
  project; with several, it asks which one.
- Works for favourites whose window is closed, too. Seen state is shared by every window;
  anything older than the first run counts as seen.

Not caught: permission prompts (Claude Code doesn't log them). The log format is not a public
API, so a Claude Code update may break detection.

## What it does

- **Start / stop / reload** — inline buttons on a row, or the status bar (`⌘⌥D`, `⌘⌥R`).
- **Three panel actions** — `▷` starts every stopped project in the list, `■` stops every
  running one, `⟳` restarts all running servers. All three span every window; work for
  another window's project is handed to that window. Starts are spaced 1 s apart so ports
  don't race.
- **Running count** — `▶ 3` in the status bar (all windows), `3 running` on the group header.
- **No terminal tabs.** Servers run as background processes; output goes to a per-project
  output channel (`Dev: paddock`), opened with the `⎙` button on the row. Each process gets
  its own process group, so stopping it also takes down the `vite` under `npm`. Closing the
  window kills them all — no orphans left behind.
- **Free port, silently.** The target port is probed before starting; if it is busy, the
  first free port above it is used (`npm run dev -- --port 5176`). No prompt, no warning, no
  marker on the row. Target port: `pitwall.port` → `server.port` in `vite.config` → 5173.
  Ports handed out are reserved for 60 s, so a second server starting at the same moment is
  never given the same one.
- **Crash detection and automatic restart** — if a process dies on its own (any exit code,
  not a deliberate stop) the row turns red and the server is brought back 3 s later. It keeps
  coming back no matter how often it crashes; only three restarts in a row that die within
  60 s make Pitwall give up (`crashed — … · gave up after 3 restarts`). Starting by hand
  resets the counter.
- **Health probe** — every 30 s the port of each running server is checked (IPv4 and IPv6
  loopback). Process alive but the port silent turns the row amber (`:5173 not responding`);
  if it is still silent 3 s later the process is killed and restarted, under the same
  three-strikes rule.
- **Error line on the row** — output matching `Failed to resolve`, `Cannot find module`,
  `SyntaxError`, `npm ERR!` and friends is shortened onto the row; the `⎙` button opens the output.
- **Orphan cleanup** — if the extension host crashes, `deactivate` never runs. Each window
  records its pids in a shared `pids/` directory, and the next start kills the process groups
  left behind by dead windows.
- **Address button** — `↗` on a running row opens the browser. The order is fixed:
  `pitwall.url` → `APP_URL` from `.env` → `https://<folder>.test` for Laravel projects →
  **last resort** the address the server printed. A vite address is not the app's address.
- **Auto start** — on window open. `pitwall.autoStart`: `lastSession` (default), `favorites`,
  `workspace`, `off`. Projects already running in another window are skipped; starts are
  spaced 1.5 s apart.
- **`build` scripts are never run** — blocked on purpose: a production build breaks the dev
  server you have open.
- Package manager comes from the lock file (pnpm / yarn / bun / npm).
- **English and Turkish** — the UI follows VS Code's display language.

## Settings

| Key | Default |
|---|---|
| `pitwall.script` | `dev` |
| `pitwall.packageManager` | `auto` |
| `pitwall.port` | `0` (automatic) |
| `pitwall.autoStart` | `lastSession` |
| `pitwall.autoStartOpensUrl` | `false` |
| `pitwall.openUrlOnStart` | `false` |
| `pitwall.url` | `""` (automatic) |
| `pitwall.openUrlTimeoutMs` | `15000` |
| `pitwall.revealTerminal` | `false` |
| `pitwall.restartDelayMs` | `600` |

Every key is `resource` scoped, so it can be overridden per folder in a multi-root workspace.

## Development

```bash
npm install
npm test        # pure-logic tests (vitest)
npm run compile
```

Open this folder in VS Code and press **F5** for an Extension Development Host.

## Install

```bash
npm run package
code --install-extension pitwall-0.9.0.vsix
```

## Licence

MIT
