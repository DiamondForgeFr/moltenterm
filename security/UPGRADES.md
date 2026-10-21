# Dependency upgrades for #810

Electron is pinned to 42.11.15, the smallest currently maintained major, preserving the application's existing
macOS 12+ requirement. The builder minimum now states that actual floor. Electron 44 would require macOS 13;
this maintenance does not change that platform promise. Historic performance baselines keep their recorded versions.
See [Electron releases](https://releases.electronjs.org/), its
[support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) and
[macOS 12 removal in Electron 44](https://www.electronjs.org/docs/latest/breaking-changes#removed-macos-12-support).

The application updates shell-quote, ws, electron-updater, colord, uuid and Mermaid within their existing major
APIs, plus compatible vulnerable transitives. Vite remains on its patched 6.4 line. React and ReactDOM are pinned
together at 19.2.9 in both application workspaces; independent caret resolution can produce incompatible peers.

Vitest 4.1.12 fixes the UI-server and mocker advisories. The existing test API stays in place. Its
[migration guide](https://v4.vitest.dev/guide/migration.html) explains the two narrow test adaptations: callable
mock signatures are explicit, and reusing an existing console spy requires clearing setup calls before observing
the action under test. Production window/agent behavior is unchanged.

Two dependency-specific overrides are deliberately bounded:

- Monaco remains on 0.55.x because its current YAML worker manager imports that line's legacy ESM paths.
  DOMPurify 3.4.17 replaces Monaco's exact older 3.x sanitizer pin. This is a patch API update and removes the
  sanitizer advisories without changing the editor/worker API. The override must be rechecked when upgrading Monaco.
  A real YAML-file smoke exposed an existing integration gap: the worker manager passes legacy worker descriptors
  to the new raw `editor.createWebWorker` API. YAML alone receives Monaco's exported descriptor compatibility bridge;
  no global API is replaced. The browser check must obtain actual YAML diagnostics and render an HTML hover through
  Monaco's overridden sanitizer, rather than treating a successful bundle as execution evidence.
- AI SDK provider-utils 3.0.41 pins the obsolete Undici 5 line. Only this exact consumer is redirected to patched
  Undici 6.29.1, which supports Node >=18.17, below the project's Node 22 minimum. Inspection of its published
  `dist/index.mjs` shows the server-only downloader uses `new Agent({connect:{lookup}})` and `fetch(input,
  {...init,dispatcher})`; those APIs are retained in Undici 6. The consumer's DNS-address rejection remains intact.
  Validate actual Agent/fetch streaming and rejection of private download addresses before removing this override
  or changing either version. This does not grant an exception for any Undici advisory.

Lock resolution initially hit npm 10.9.2's internal Arborist `edgesOut` null error when introducing Vitest 4.
An isolated npm 11.16.0 resolved the peers; npm 10.9.2 then reconciled the lock and reproduced clean `npm ci`.
The project and security scanner retain npm 10.9.2. No global npm or another worktree's installation was changed.

Go and standalone Tsunami now pin Go 1.26.10 (#941: GO-2026-6809, crypto/x509, fixed in 1.26.10). The SSH, image, HTTP, module, text, telemetry, gRPC and fuzzy-search
updates eliminate the host's reachable findings. gRPC 1.83.1 was rejected by the fresh scanner and replaced by
1.83.2. Cross-target source scans and native release builds remain necessary; a host result is not all-platform evidence.
