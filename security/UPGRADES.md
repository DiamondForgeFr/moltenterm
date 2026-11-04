# Dependency upgrades for #810

KaTeX 0.18.10 is pinned by an exact npm override for Mermaid, Streamdown, rehype-katex and
micromark-extension-math (#1602). Their current 0.16 dependency ranges do not include it; the override is a
qualified compatibility exception, not an upstream-supported range. Reassess and remove it when all consumers
support a patched version, and repeat renderer, trust and resource-limit tests on consumer upgrades. Registry
0.18.11 is deprecated by its publisher for accidentally introduced breaking changes; 0.18.10 is not deprecated.
Its Commander 15 CLI dependency requires Node >=22.12.0; the renderer does not use that CLI. CI uses Node 22.
Existing Streamdown sanitization strips KaTeX formatting and MathML, including before this change (#1610).

Electron is pinned to 45.2.0 (#1590), with the developer-approved macOS 13+ minimum. Electron 42 is out of support;
the earlier #810 choice of 42.11.15 and macOS 12 support is historical. Historic performance baselines keep their
recorded versions. Electron 45 is tentatively supported until April 27, 2027; the pinned lifecycle review expires
at the start of December 1, 2026 UTC. Check the live upstream release list and schedule before every release.
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

minimatch and glob are moved by range overrides (#1913). GHSA-g3hv-75wg-m249 (minimatch `>=7.0.0 <11.0.1`) and
GHSA-3g3m-2fjr-6pw4 (glob `>=9.0.0 <=14.0.1`) have no fix on the 9.x and 10.x lines, and no current release of a
consumer asks for a fixed one. The root `package.json` overrides `minimatch@>=7.0.0 <12.0.0` to 11.0.4 and
`glob@>=9.0.0 <15.0.0` to 14.0.3. npm applies a ranged key to every dependency whose requested range meets it: the
`^9`/`^10` requests move, while the 3.x and 5.x copies (outside the advisory, on an older API) and glob 7 keep their
versions. Each key's range must contain its own value: npm 10.9.2 matches a key against the edge's current spec,
which is the override's value once applied, so a key bounded at the advisory's fix (`<11.0.1`) drops the override
on the next reload (glob stayed 10.5.0 under unified-engine). With an existing lock, `npm install` also left the
hoisted glob 10.5.0 in place, invalid; `npm update glob` replaced it, and a clean `npm ci` reproduces the tree. Both
are qualified compatibility exceptions outside the consumers' declared ranges:

- minimatch 11 matches each path portion with a `Matcher` in place of a `RegExp`, and removes `makeRe()`,
  `Minimatch#regexp` and `matchOne()`. The consumers moved here use only `minimatch()`, `minimatch.match()`,
  `new Minimatch()`, `Minimatch#match(path, partial)`, `negate` and `set` (tested for non-string items):
  @electron/universal 2.0.3 (`matchBase` allow lists), app-builder-lib 26.17.0 (`fileMatcher.js`, `util/filter.js`),
  @typescript-eslint/typescript-estree 8.56.1 (`allowDefaultProject`, unused by this configuration) and
  @npmcli/map-workspaces 3.0.6.
- glob 10 recognises a pattern portion by `instanceof RegExp`, so it cannot run on minimatch 11: glob 14 is the line
  built for it. Its consumers, @npmcli/map-workspaces 3.0.6, @npmcli/package-json 5.2.1 and unified-engine 11.2.2
  (remark-cli, eslint-mdx), call `glob()` and `hasMagic()` with `cwd`, `ignore`, `nocase` and `mark`, which glob 14
  keeps. None passes the removed `debug` option.

The qualification compared each consumer before and after on the same tree. The unsigned arm64 app directory and a
universal merge (both wavesrv binaries in each architecture, so @electron/universal reaches its `x64ArchFiles`,
`singleArchFiles` and plist calls) built by electron-builder hold the same files and app.asar entries, byte for
byte, except the packaged `package.json`, which carries the two new overrides, and the `ElectronAsarIntegrity` hash
that follows it in the Info.plist files. Workspace discovery, package normalisation (`directories.bin`,
`directories.man`, `gypfile`, readme), docs globs, remark-cli and eslint-mdx on the docs, and the electron-builder
file filters give the same results. A new consumer of an affected line is moved too: qualify it when it enters the
lock, and drop each override once every consumer asks for a fixed version.

Lock resolution initially hit npm 10.9.2's internal Arborist `edgesOut` null error when introducing Vitest 4.
An isolated npm 11.16.0 resolved the peers; npm 10.9.2 then reconciled the lock and reproduced clean `npm ci`.
The project and security scanner retain npm 10.9.2. No global npm or another worktree's installation was changed.

Go and standalone Tsunami now pin Go 1.26.10 (#941: GO-2026-6809, crypto/x509, fixed in 1.26.10). The SSH, image, HTTP, module, text, telemetry, gRPC and fuzzy-search
updates eliminate the host's reachable findings. gRPC 1.83.1 was rejected by the fresh scanner and replaced by
1.83.2. Cross-target source scans and native release builds remain necessary; a host result is not all-platform evidence.
