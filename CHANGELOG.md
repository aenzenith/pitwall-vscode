# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases are cut
by release-please from Conventional Commits.

## [1.2.0](https://github.com/aenzenith/pitwall-vscode/compare/v1.1.2...v1.2.0) (2026-10-22)


### Features

* **runner:** a project whose app sits in a subfolder runs its dev server there ([0ac5f50](https://github.com/aenzenith/pitwall-vscode/commit/0ac5f508251d89ec6f7fc2a2a97729ce4794b8c4))

## [1.1.2](https://github.com/aenzenith/pitwall-vscode/compare/v1.1.1...v1.1.2) (2026-10-21)


### Bug Fixes

* **registry:** a damaged favourites file is set aside, never written over ([ca8117e](https://github.com/aenzenith/pitwall-vscode/commit/ca8117e44bff66d7d8176d3d26f55dd85bd6791c))
* **runner:** a script named build runs like any other ([ef97dcb](https://github.com/aenzenith/pitwall-vscode/commit/ef97dcbd94740ca429aee62746c97dbb6cedbeeb))

## [1.1.1](https://github.com/aenzenith/pitwall-vscode/compare/v1.1.0...v1.1.1) (2026-10-15)


### Bug Fixes

* **claude:** marks for long folder paths, and a turn stopped with Esc rests at once ([5a73386](https://github.com/aenzenith/pitwall-vscode/commit/5a73386132b31a788cbde12468bbcdcc83182db6))
* **registry:** orphans and commands are taken safely ([dc57b9b](https://github.com/aenzenith/pitwall-vscode/commit/dc57b9b191b49ae2792ef4eb2d0a6a6f39da0bef))
* **registry:** the same folder in another spelling on Windows is one project ([0b91709](https://github.com/aenzenith/pitwall-vscode/commit/0b91709731748a6992683b0eb4acbeebd71e8b19))
* **runner:** a restart keeps its port, quick clicks leave no second server, a slow stop stays stopped ([aed18c7](https://github.com/aenzenith/pitwall-vscode/commit/aed18c721e8dfe161bf0bb57d76bc0c8a4f8935c))
* **runner:** no --port for a project that asks for none ([3125766](https://github.com/aenzenith/pitwall-vscode/commit/312576632fda8b3e4e4038f4d09e840dd7fd545a))

## [1.1.0](https://github.com/aenzenith/pitwall-vscode/compare/v1.0.0...v1.1.0) (2026-10-14)


### Features

* **claude:** a breathing ring while Claude works ([8dfbc5b](https://github.com/aenzenith/pitwall-vscode/commit/8dfbc5bc0b55ffe15637e4ceddd5eb103340cfb6))

## [1.0.0](https://github.com/aenzenith/pitwall-vscode/compare/v0.15.3...v1.0.0) (2026-10-05)


### Miscellaneous

* release 1.0.0 ([b35ef19](https://github.com/aenzenith/pitwall-vscode/commit/b35ef1975711bc2f86efc74b902a6fbf6f7ec8bf))

## [0.15.3](https://github.com/aenzenith/pitwall-vscode/compare/v0.15.2...v0.15.3) (2026-10-05)


### Bug Fixes

* **claude:** no dot while a session's subagents still run ([82c72e8](https://github.com/aenzenith/pitwall-vscode/commit/82c72e82432cb9ab3944494b1ec7f04506a3ba55))
* **panel:** title shortened to "Pitwall" ([2c5dd8f](https://github.com/aenzenith/pitwall-vscode/commit/2c5dd8f933ec35739bd5f788756fb6b059d5d815))

## [0.15.2](https://github.com/aenzenith/pitwall-vscode/compare/v0.15.1...v0.15.2) (2026-10-04)


### Bug Fixes

* **tree:** rows show the state of whoever runs the server ([bb7035e](https://github.com/aenzenith/pitwall-vscode/commit/bb7035e55b73b7491494cf606338443b8d8e9937))

## [0.15.1](https://github.com/aenzenith/pitwall-vscode/compare/v0.15.0...v0.15.1) (2026-10-02)


### Bug Fixes

* **orphans:** servers of live participants no longer reaped ([05555db](https://github.com/aenzenith/pitwall-vscode/commit/05555dbac430e96a479cc6096ab34eb50e49b018))
* **registry:** commands sent in the same millisecond kept apart ([887e0ad](https://github.com/aenzenith/pitwall-vscode/commit/887e0adccae648589c33a3b6c3c69cc5531cf978))

## [0.15.0](https://github.com/aenzenith/pitwall-vscode/compare/v0.14.0...v0.15.0) (2026-10-02)


### Features

* **claude:** sessions brought up on request from the Pitwall app ([09b14c0](https://github.com/aenzenith/pitwall-vscode/commit/09b14c0ae68e2d8ec726c3924a30ebe3801222ef))

## [0.14.0](https://github.com/aenzenith/pitwall-vscode/compare/v0.13.0...v0.14.0) (2026-10-01)


### Features

* **output:** server output mirrored to ~/.pitwall/output ([824e9a7](https://github.com/aenzenith/pitwall-vscode/commit/824e9a7cf0e174f01c997b832d2d756eae027328))
* **tree:** local folders running elsewhere shown with their runner's state ([8b27226](https://github.com/aenzenith/pitwall-vscode/commit/8b272266e756ca840c225f60a49e85ded374c7ff))

## [0.13.0](https://github.com/aenzenith/pitwall-vscode/compare/v0.12.2...v0.13.0) (2026-10-01)


### Features

* **storage:** shared state moved to ~/.pitwall ([96e261c](https://github.com/aenzenith/pitwall-vscode/commit/96e261cd32be378121d45152e7439476a6a8071b))

## [0.12.2](https://github.com/aenzenith/pitwall-vscode/compare/v0.12.1...v0.12.2) (2026-10-01)


### Bug Fixes

* **listing:** display name changed to Pitwall for VS Code ([8a35d9b](https://github.com/aenzenith/pitwall-vscode/commit/8a35d9bd7c92c362592283f1d9639e08424ef3bd))

## [0.12.1](https://github.com/aenzenith/pitwall-vscode/compare/v0.12.0...v0.12.1) (2026-10-01)


### Bug Fixes

* **listing:** extension renamed to pitwall-vscode ([887209d](https://github.com/aenzenith/pitwall-vscode/commit/887209d6e2042f2dfa13ab661a2c7a6c293d21e2))

## [0.12.0](https://github.com/aenzenith/pitwall/compare/v0.11.1...v0.12.0) (2026-10-01)


### Features

* **platform:** Windows support for starting and stopping servers ([86de28a](https://github.com/aenzenith/pitwall/commit/86de28abf4a877e135d40036d447f11bbc05f369))

## [0.11.1] — 2026-10-01

### Changed

- The Claude marker is now a small orange dot on the corner of the row's status icon, like a
  notification badge, instead of a 🔸 after the name. The status bar badge is an orange
  `• N`.

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
