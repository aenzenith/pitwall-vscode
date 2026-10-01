# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] — 2026-10-01

### Added

- Claude Code sessions are tracked per project. When Claude finishes a turn, or asks a
  question, in a project whose window you are not looking at, a small orange 🔸 appears next
  to its name. It clears once that project's window gets focus or you click the row.
- A status bar badge (`🔸 2`) counts the projects waiting on you; clicking it jumps to the
  project, or asks which one when there are several.

## [0.10.0] — 2026-09-24

### Changed

- Crashed servers are restarted automatically every time, 3 s after they die, instead of only
  once per session. Any unplanned exit counts, including exit code 0. Three restarts in a row
  that die within 60 s make Pitwall give up; starting by hand resets the counter.
- A server whose port stays silent 3 s after the health probe flagged it is killed and
  restarted under the same three-strikes rule, instead of only turning the row amber.
- The health probe checks both IPv4 and IPv6 loopback, so a server bound only to `::1` is no
  longer reported as unresponsive.

## [0.9.0] — 2026-09-19

First public release.

### Panel

- One list for every project: the current window's root folders, starred favourites and the
  projects of every other open VS Code window.
- Clicking a row goes to that project's window; a project that is open nowhere is opened in
  a new window. Only the play button starts a server.
- Per-row start, stop, reload, open address and show output; star to keep a project in the
  list even when its window is closed.
- Panel actions that span every window: start everything stopped, stop everything running,
  restart every running server.
- Running count in the status bar (`▶ 3`) and on each group header.

### Running servers

- Servers run as background processes in their own process group — no terminal tabs, and
  stopping one also takes down the `vite` under `npm`. Output goes to a per-project channel.
- Free port is guaranteed before start: the target port (`pitwall.port`, `server.port` from
  `vite.config`, then 5173) is probed, and the first free port above it is used if needed.
  Ports handed out are reserved for 60 s so simultaneous starts never collide.
- Auto start on window open: `lastSession` (default), `favorites`, `workspace` or `off`.
  Projects already running in another window are skipped.
- `build` scripts are refused, because a production build breaks a running dev server.
- Package manager detected from the lock file (pnpm / yarn / bun / npm).

### Reliability

- Crash detection: a process that dies on its own turns the row red and is brought back once.
- Health probe every 30 s; a live process with a silent port turns the row amber.
- Error lines from the output (`Failed to resolve`, `Cannot find module`, `SyntaxError`,
  `npm ERR!`, …) are surfaced on the row.
- Orphaned processes left by a crashed extension host are cleaned up on the next start.

### Cross-window

- Windows share state through the extension's global storage: state and root folders every
  5 s, commands as files, stale windows dropped after 20 s.
- A project belongs to the window that has it as a root folder or runs it; favourites are a
  shared list.

### Addresses

- The address button resolves in a fixed order: `pitwall.url`, then `APP_URL` from `.env`,
  then `https://<folder>.test` for Laravel projects, and only as a last resort the address
  the dev server printed.

### Localisation

- English and Turkish, following VS Code's display language.
