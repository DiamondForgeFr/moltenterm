# Built-in browser security audit, November 2026 (#1961)

Scope: the browser panel (`frontend/moltenterm-shell/browser/`), Wave's web blocks (`frontend/app/view/webview/`), the
Electron main side of both (`emain/authkey.ts` `will-attach-webview`, `emain/emain-tabview.ts`, `emain/emain-util.ts`
navigation handlers, `emain/moltenterm-site-permissions.ts`, `emain/moltenterm-popups.ts`,
`emain/moltenterm-external-links.ts`, `emain/moltenterm-browseragent.ts` and its policy, `emain/moltenterm-webview-input-gate.ts`,
`emain/moltenterm-webview-lifecycle.ts`, `emain/preload-webview.ts`, `emain/preload.ts`), and the agent side of the browser
tools (`pkg/molten/browseragent`). Packaging (`electron-builder.config.cjs`) and the app page (`index.html`) were read where
they bear on the browser.

Method: source review at `develop` `d7bd159cb` (2026-11-06). Line numbers refer to that commit unless a line says
otherwise. Nothing was exploited against a running build; a finding marked **needs verification** is supported by the
source but its end-to-end chain was not run. Electron 45.2.0 is pinned (`package.json:47`).

The goal set by the ticket: for some users the panel becomes their everyday browser, with their SaaS as mini-apps, so
its security has to hold up against Chrome and Firefox for everyday browsing, not only for development pages.

## Summary

| Severity | Count | Fixed here | Proposed tickets          |
| -------- | ----- | ---------- | ------------------------- |
| Critical | 0     | 0          | 0                         |
| High     | 3     | 2 (partly) | 2                         |
| Medium   | 10    | 1          | 9, plus 2 Andvari tickets |
| Low      | 9     | 1          | 5, plus 1 Andvari ticket  |
| Info     | 3     | 0          | 0                         |

No finding lets a web page escape the sandbox or reach MoltenTerm's privileged renderer on its own. The two most
serious gaps start from the agent's own shell: it could approve sites for itself and read the panel's pages around the
per-site approval. Both are fixed for the panel in this story. The largest structural gaps are packaging (Electron fuses
left at their defaults), the absence of any phishing or malware protection, and the engine lagging Chromium security
fixes between MoltenTerm releases.

## What already holds

- The app renderer lives in a private in-memory session (`AppSessionPartition`, `emain/moltenterm-app-auth-policy.ts:6`)
  and a guest can never attach to it (`emain/authkey.ts:70-75`). Backend credentials go only to the exact backend
  origin from a registered app frame, and are stripped from every other request, redirects included
  (`emain/authkey.ts:86-121`, `docs/browser-auth-boundary.md`).
- Guest pages run sandboxed, without Node and with context isolation: the webview preload exposes nothing to the page
  (no `contextBridge`), and reacts only to trusted events (`emain/preload-webview.ts:19-46`, `:66-70`).
- Guest IPC goes through `onGuestIpc`, which requires a live `webview` sender, its main frame and a trusted host
  (`emain/moltenterm-privileged-ipc.ts:32-43`). The three channels a page can reach check their payload
  (`emain/moltenterm-contextmenu.ts:178-212`, `emain/emain-ipc.ts:247-253`, `emain/moltenterm-browseragent.ts:841`).
- Every session gets permission handlers before any window; camera, microphone, location and notifications are asked
  in the tab, everything else is denied, and USB, HID and serial are always denied
  (`emain/moltenterm-site-permissions.ts:170-215`, `frontend/moltenterm-shell/browser/site-permission.ts:33-80`).
- One rule for links handed to the system: web and mail open, a local file is shown in its folder, other schemes ask,
  page-only schemes are dropped (`emain/moltenterm-external-links.ts:20-59`). A page's `window.open` goes through the
  same rule (`emain/moltenterm-popups.ts:44-52`, `frontend/moltenterm-shell/browser/browser-popup.ts:29-44`).
- Popups get `contextIsolation`, `sandbox`, no Node and no webview tag (`emain/moltenterm-popups.ts:75-80`); their title
  starts with their host (`browser-popup.ts:158`).
- Certificate errors are never bypassed: there is no `certificate-error` handler and no `setCertificateVerifyProc`, so
  Chromium's verdict stands.
- Agents: an exact allow-list of 12 CDP methods with rebuilt parameters
  (`emain/moltenterm-browseragent-policy.ts:20-37`, `:335-425`), http(s)-only navigation in both processes
  (`policy.ts:84-97`, `pkg/molten/browseragent/sites.go:160-177`), per-site approval keyed by registrable domain
  (`sites.go:84-99`), cross-host redirects asked again (`emain/moltenterm-browseragent.ts:634-647`), the user's input
  told apart from the agent's by sequence (`policy.ts:464-506`), sensitive actions asked every time
  (`pkg/molten/browseragent/input.go:329-344`), downloads of a controlled tab held for the user
  (`emain/moltenterm-browseragent.ts:231-273`), page content returned inside an untrusted envelope
  (`pkg/molten/browseragent/pages.go:58-65`), and control, answers and site decisions accepted only from a window
  (`pkg/molten/browseragent/manager.go:448-450`).

## Findings

### High

#### H1. An agent could approve a site for itself through `setconfig` (fixed for the RPC; settings file remains)

- **Evidence.** The agent's site decisions are the ordinary setting `browser:agentsites`
  (`pkg/molten/browseragent/waveenv.go:251-270`, `pkg/wconfig/settingsconfig.go:164`); the camera, microphone, location
  and notification decisions are `browser:sitepermissions` (`settingsconfig.go:166`). Wave's `SetConfigCommand` writes
  any key for any caller (`pkg/wshrpc/wshserver/wshserver.go:592-594`). The only `setconfig` restriction refuses SSH and
  WSL hosts (`pkg/molten/metaguard/remote.go:290-291`). The rule "an agent cannot allow itself" was enforced only on the
  permission bar's answer (`pkg/molten/browseragent/permission.go:301-304`).
- **Scenario.** A page the agent reads carries injected instructions. The agent runs
  `wsh setconfig 'browser:agentsites={"<site>":"allow"}'` from its terminal; its next call on that site passes without a
  question, with the user's sign-ins.
- **Fix shipped.** `SetConfigCommand` refuses both keys unless the caller is a MoltenTerm window, Electron main or
  wavesrv itself, as the router proves it (`pkg/wshrpc/wshserver/moltenterm_configguard.go`, test
  `moltenterm_configguard_test.go`). Other keys stay open to terminals.
- **Residual.** A same-user process can still edit `settings.json`. Moving consent decisions into a store only wavesrv
  writes, or signing them, is part of T19 below. This is defence in depth: an agent with a shell already holds the
  user's file access.

#### H2. `wsh web get` reads any page around the per-site approval (fixed for the panel; fixed for Wave web blocks by T2, #1976)

- **Evidence.** Electron main's `handle_webselector` (`emain/emain-wsh.ts:24-38`) runs `querySelector(...).outerHTML` in
  the page's main world (`emain/emain-web.ts:74-97`). Its webview lookup matched any webview under the block
  (`emain/preload.ts:298-301`), browser panel tabs included (their webviews carry `data-webcontentsid`,
  `frontend/moltenterm-shell/browser/browser-view.tsx:1655`). The `view == "web"` check exists only in the `wsh` client
  (`cmd/wsh/cmd/wshcmd-web.go:70`), not in Electron main. Neither checks the site approval nor wraps the result as
  untrusted. **Needs verification**: that a local terminal's route reaches this Electron command was read from the
  router code, not run.
- **Scenario.** An agent sends the webselector RPC with a browser panel's block id and reads the full HTML of a
  signed-in page on a site the user never approved.
- **Fix shipped.** The lookup takes a Wave web block's webview only, never a browser panel tab
  (`emain/moltenterm-webselector-policy.ts`, used by `emain/preload.ts`; test
  `emain/moltenterm-webselector-policy.test.ts`).
- **Residual (T2), fixed in #1976.** Wave web blocks share the panel's default session, cookies included (F M10). An
  agent could open a Wave web block on any site and read it with `wsh web get`. Electron main now asks wavesrv for the
  stored decision of the page's current address (`moltenbrowseragentwebread`, `pkg/molten/browseragent/webread.go`):
  only a stored Always reads, a Block or no decision refuses with a fixed sentence (Allow once is a session's and never
  applies to a terminal), a page that moved to another host while it was read gives no result, every item comes back
  inside the untrusted page content envelope, and an SSH or WSL host is refused by the router before Electron main
  (`remoteElectronCommands`, test `TestRemoteHostRouteAllowlist`). Gate: `emain/moltenterm-webselector-gate.ts`, test
  `emain/moltenterm-webselector-gate.test.ts`. Still open there: a live question on the Wave web block itself, which
  has no permission bar, so the user allows the site once in the browser panel.

#### H3. Electron fuses are left at their defaults (fixed in #1975, T1, and #2058 for cookies; the file protocol fuse remains)

- **Evidence.** `electron-builder.config.cjs` sets no `electronFuses` and nothing else flips them (`@electron/fuses` is
  only a transitive build dependency). Defaults keep `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`,
  `EnableNodeCliInspectArguments` and `GrantFileProtocolExtraPrivileges` on, and `EnableEmbeddedAsarIntegrityValidation`
  and `OnlyLoadAppFromAsar` off.
- **Scenario.** A same-user process launches the signed MoltenTerm binary with `ELECTRON_RUN_AS_NODE=1` or `--inspect`
  and runs its own code under MoltenTerm's signature: it inherits the app's macOS privacy grants and its keychain entry
  that encrypts the browser's cookie store, so it can read every site session of the panel. With
  `GrantFileProtocolExtraPrivileges`, a `file://` page loaded in a guest gets more than Chrome would give it (M3).
- **Fix proposal.** Flip the fuses in packaged builds (`runAsNode`, `enableNodeOptionsEnvironmentVariable`,
  `enableNodeCliInspectArguments` off; `enableEmbeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar` on;
  `grantFileProtocolExtraPrivileges` off once the app page no longer needs it). The perf and accessibility scripts drive
  the built app with `--inspect` (`scripts/perf/lib/instance.mjs:158`): they need a dev-only build or the
  `--remote-debugging-port` path. Not shipped here: it changes packaging and needs a packaged-build qualification.
- **Fix shipped (#1975).** `electronFuses` in `electron-builder.config.cjs`, from `build/moltenterm/electron-fuses.cjs`:
  `runAsNode`, `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments` off,
  `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` on. Qualified on an arm64 macOS packaged build
  (`scripts/moltenterm-qualify-packaged.mjs`): it starts and answers on the remote debugging port, ignores `--inspect`,
  SIGUSR1, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS` and `ELECTRON_RUN_AS_NODE`, and exits when a byte of `app.asar` changes;
  the same app with Electron's default fuses fails each of those checks. The perf and accessibility scripts already drive
  the dev build in `node_modules/electron`, whose fuses stay at the defaults, so they needed no move.
  `scripts/moltenterm-check-fuses.mjs` reads the fuses back from every packaged app of a release. The app builder used the
  app's own binary as Node.js for its Tailwind step; a packaged app now uses `node` from the PATH.
- **Residual: `grantFileProtocolExtraPrivileges` stays on.** The app page is loaded with `loadFile()`, and with the fuse
  off a packaged app never loads it (`ERR_FILE_NOT_FOUND` for `app.asar/dist/frontend/index.html`). It goes off with a
  custom protocol for the app page (pair with T3 and T4); M3's `file:` pages keep the extra privileges until then.
- **Residual: cookies are not encrypted.** Electron stores a session's cookies in clear unless the separate
  `enableCookieEncryption` fuse is on (it is a one-way migration, and its key is a keychain item per signing identity),
  so the scenario above was wrong about a "cookie encryption key": today a same-user process reads the cookie database
  directly, with no need to run code under MoltenTerm's signature. The fuses close the run-code-as-MoltenTerm path; the
  cookie store needs its own ticket.
- **Residual closed (#2058): cookies are encrypted on disk.** Packaged builds turn `enableCookieEncryption` on: Chromium
  writes each cookie value encrypted with the app's keychain key ("MoltenTerm Safe Storage", the one `safeStorage`
  already uses), so a program that reads the profile folder gets no session. Chromium still reads the rows an earlier
  version wrote in clear but leaves them in clear until their site sets them again, so the first start of the new
  version rewrites them once per persistent session (`emain/moltenterm-cookie-encryption.ts`,
  `emain/moltenterm-cookie-migration.ts`): the clear rows are read before Chromium locks the database, and the same
  cookies are set again through the session, which stores them encrypted. No sign-in is lost (checked on a profile
  written by a packaged build of the previous version, signed in to a local site). What stays: a partitioned cookie
  (a site embedded in another) is left in clear until its site sets it again, since Electron's cookie API cannot set its
  partition; a user who denies the keychain request keeps the clear rows (retried at the next start), and Chromium
  cannot store new cookies without the key. Qualified by `scripts/moltenterm-qualify-packaged.mjs` (a cookie the app
  stores has no clear value or bytes on disk; a clear row of an earlier version is still sent, then stored encrypted).
- **Residual: `--remote-debugging-port` is not a fuse.** A packaged build still opens a Chromium debugging port when it is
  started with that switch (it is how tests drive it), and a program that starts the app that way drives its pages
  under its signature. Closing that means the app ignores the switch outside test instances (`MOLTENTERM_BACKGROUND`
  is not proof, any program can set it); not decided here, and not tested against a running instance's profile.
- **Residual closed (#2057): the debugging switches only on a test profile.** A packaged app removes
  `--remote-debugging-port` and `--remote-debugging-pipe` before Chromium reads them unless its Chromium profile
  (`<data>/electron`) is a test profile: not the build's default profile (compared through links), and either new at
  that start, which marks it (`moltenterm-test-profile`), or marked before. Pointing the data folder at another existing
  profile (a release at the gold's data) is refused too. The main log says `remote debugging: ignored (<reason>)`. Test
  instances and the qualify script start on a new data folder under `/tmp` and keep the port; dev builds are unchanged
  (`emain/moltenterm-remote-debugging.ts`). `scripts/moltenterm-qualify-packaged.mjs` checks that the port stays closed
  on the default profile and on an unmarked one. What stays: a same-user program can copy a profile and write the mark;
  it then drives only what it could read from the copied files, and once cookies are encrypted (#2058) the copy must
  not decrypt them with the user's key.

### Medium

#### M1. `will-attach-webview` checked only the partition (fixed)

- **Evidence.** `emain/authkey.ts:70-79` refused the app's partition and kept everything else the tag asked for. It did
  not force `nodeIntegration`, `contextIsolation` or `sandbox`, did not compare `preload` with MoltenTerm's page preload,
  and did not look at `params.src`. Today's tags ask for nothing dangerous (`frontend/app/view/webview/webview.tsx:1128-1140`,
  `browser-view.tsx:1736-1748`, `frontend/builder/tabs/builder-previewtab.tsx:224`).
- **Scenario.** Any future HTML injection into the app renderer inserts
  `<webview nodeintegration webpreferences="contextIsolation=no" preload=...>` and gives a web page Node.
- **Fix shipped.** `hardenWebviewAttach` (`emain/moltenterm-webview-attach-policy.ts`) forces no Node (main frame,
  subframes, workers), context isolation, sandbox, web security, no insecure content, no experimental or Blink features
  and no nested webview; strips any preload other than `preload/preload-webview.cjs` (and any `preloadURL`); refuses to
  attach a `javascript:`, `vbscript:`, `chrome:`, `devtools:`, `chrome-devtools:` or `view-source:` first page. The
  built page preload requires only `electron`, so it runs unchanged in the forced sandbox. Tests:
  `emain/moltenterm-webview-attach-policy.test.ts`, `emain/moltenterm-app-auth-integration.test.ts`.

#### M2. The app page has no Content-Security-Policy (proposed, T3)

- **Evidence.** `index.html:1-20` declares none and no `onHeadersReceived` adds one. The app renderer holds the preload
  with privileged IPC and the backend credentials.
- **Scenario.** Any HTML-injection bug (markdown, a page title rendered as HTML by a future change, a dependency) runs
  script with the app's full reach; a CSP would be the second line.
- **Fix proposal.** A strict CSP for the app page (`script-src 'self'`, no `unsafe-eval` unless Monaco or Mermaid needs
  it in a worker, `object-src 'none'`, `frame-src` limited to what the app embeds, `connect-src` to the backend
  endpoints), rolled out in report-only mode first.

#### M3. Pages queued by a terminal or an agent can load `file:` and `data:` in the shared session (proposed, T4)

- **Evidence.** `readOpenRequests` accepts any non-empty URL from block meta
  (`frontend/moltenterm-shell/browser/browser-model.ts:223-258`), and each becomes a panel tab with that `src`
  (`browser-view.tsx:883-915`, `:1738`). `wsh web open` passes its argument through (`cmd/wsh/cmd/wshcmd-web.go:132,147`,
  `pkg/molten/browser.go:62-63`). Wave's web block keeps `file:` as is (`webview.tsx:402`). Any terminal can write block
  meta (`browser-view.tsx:926`). A web page cannot do this itself: its links and `window.open` go through
  `pageOpenTarget`.
- **Scenario.** A program in a terminal (or a remote host through wsh) opens a downloaded HTML file in the panel; with
  the default `GrantFileProtocolExtraPrivileges` fuse a `file://` page can read other local files. **Needs
  verification** for the read chain in Electron 45.
- **Fix shipped (part).** Script and engine URLs no longer attach (M1).
- **Fix proposal.** Opening a local file from a terminal is a real use (coverage and test reports through `BROWSER`),
  so confirm instead of blocking: a `file:` or `data:` page queued by a terminal asks in the tab, naming the file, and
  the `GrantFileProtocolExtraPrivileges` fuse goes off (H3).
- **Fix shipped (#1978).** A tab holding a `file:` or `data:` page that the user did not type, allow or remember does not
  mount its webview: the page area asks (Open, Always open this file, Don't open), naming the file, with no native
  dialog and no focus taken. The allowance is saved with the tab (`allowed`, in the panel's saved tabs, which a terminal
  cannot write), and "Always open this file" is `browser:localpages`, refused to a terminal's `setconfig` like the other
  consent settings. Tests: `frontend/moltenterm-shell/browser/local-page.test.ts`, `local-page-ask.test.tsx`,
  `pkg/wshrpc/wshserver/moltenterm_configguard_test.go`. The fuse stays with T1. Correction to the evidence: `BROWSER`
  hands a file or `data:` argument to the system opener (FR-BRW-007), so it never reaches the panel; the paths in are
  `wsh web open`, `molten open`, a block created with a `url`, and the queued meta.

#### M4. A site asking for a client certificate silently gets the first one (fixed, T5, #1979)

- **Evidence.** No `select-client-certificate` handler in `emain/`. Electron's default selects the first matching
  certificate of the store without asking.
- **Scenario.** Any site requesting a client certificate learns the user's identity from it (company, name, e-mail), or
  is signed in to with it, without the user knowing.
- **Fix proposal.** Handle `select-client-certificate` for guests: ask in the tab with the site and the certificate list
  (none selected by default), remember per site like other permissions. MoltenTerm's own renderers keep no certificate.
- **Fix shipped (#1979, FR-BRW-016 AC7-AC9).** `emain/moltenterm-client-certificates.ts` handles `select-client-certificate`
  and prevents Electron's default in the same tick. The question is a bar of the tab
  (`frontend/moltenterm-shell/browser/client-certificate-bar.tsx`), answered only by the window that holds the tab
  (`moltenterm-client-certificate-answer`, a certificate only if it was offered for that request). The pick or the choice to
  go without is remembered in `browser:clientcertificates`, which a terminal cannot set
  (`pkg/wshrpc/wshserver/moltenterm_configguard.go`); a remembered certificate the system no longer offers is asked again,
  and Settings › Browser forgets a choice. A Wave web block uses only a remembered choice; MoltenTerm's own renderers and
  requests from no page get none. Tests: `emain/moltenterm-client-certificates.test.ts`,
  `frontend/moltenterm-shell/browser/client-certificate.test.ts`, `client-certificate-bar.test.tsx`,
  `moltenterm_configguard_test.go`.

#### M5. No connection security indicator; the address bar hides http (proposed, T6)

- **Evidence.** `shownAddress` strips both `http://` and `https://` (`browser-model.ts:418-425`, FR-SHELL-086), and
  nothing in the panel shows a lock, a "Not secure" mark or the certificate.
- **Scenario.** A sign-in page served over plain http, or a downgraded one, looks the same as the https one.
- **Fix proposal.** A "Not secure" chip for http pages outside localhost and for pages with mixed content, a site
  information popover (connection, certificate issuer, permissions granted), and the password-over-http warning of the
  phishing section.

#### M6. No phishing or malware protection (proposed, T7)

- **Evidence.** Electron does not include Chromium's Safe Browsing service. Outside a controlled tab, a download falls
  back to Electron's save dialog with no reputation check (`emain/moltenterm-browseragent.ts:238-246` handles controlled
  tabs only).
- **Fix proposal.** See "Phishing and malware protection" below.

#### M7. The engine lags Chromium security fixes between releases (proposed, T8)

- **Evidence.** Electron is pinned to 45.2.0 (`package.json:47`, `security/dependencies.json` `electronLifecycle`).
  45.2.1, 45.2.2 and 45.2.3 were published between 2026-10-31 and 2026-11-04 (npm registry, checked 2026-11-06). The
  scanner's lifecycle check is offline: it catches an overdue review, not a new patch (`security/README.md`, "Coverage
  and review").
- **Fix proposal.** See "Engine update policy" below. Review the 45.2.1-45.2.3 notes for security fixes and bump.

#### M8. An agent's click inside a frame is never confirmed (proposed, T9)

- **Evidence.** `Molten.inspect` reports an iframe as `kind: "frame"` without looking inside
  (`emain/moltenterm-browseragent-policy.ts:634-637`, `:711`). Typing and Enter in a frame ask
  (`pkg/molten/browseragent/sensitive.go:117-125`, `:145`), a click does not (`sensitive.go:102-113`).
- **Scenario.** The agent clicks "Pay" or "Sign in" inside an embedded payment or login frame that already holds a value.
- **Fix proposal.** Ask for a left click on a frame target when the page has a sensitive form or a payment or sign-in
  frame; asking on every frame click would be too noisy (captchas, video players). Needs a product decision.

#### M9. A download from a tab or popup an agent opened skips the confirmation (proposed, T10)

- **Evidence.** `will-download` holds a download only when its source webview is registered and controlled
  (`emain/moltenterm-browseragent.ts:238-246`). A link with a target or `window.open` becomes a new, uncontrolled panel
  tab or popup (`emain/moltenterm-popups.ts:53-82`).
- **Fix proposal.** A tab or popup opened from a controlled tab inherits its control for downloads (ask on the opener's
  bar).

#### M10. One shared session for all browsing (proposed, T11)

- **Evidence.** Neither the panel nor Wave's web block sets a partition by default (`browser-view.tsx:1736-1748`,
  `webview.tsx:862-864`), so every panel, workspace and agent tab shares `session.defaultSession` and its cookies. This
  is the documented design (agents act with the user's sign-ins).
- **Risk.** A site approved for an agent in one workspace is signed in everywhere; a client's work and personal browsing
  share cookies. Agents act signed in, by design.
- **Fix proposal.** An option per workspace (or per Space) for its own persistent partition, and an option to run an
  agent's tabs in a separate, signed-out partition. Product decision.

### Low

#### L1. A favicon a page points at the backend was fetched with the app's credentials (fixed)

- **Evidence.** `pickFavicon` took any `http(s):` URL (`frontend/moltenterm-shell/browser/browser-loading.ts:50-52`); the
  tab strip draws it as an `<img>` in the app renderer (`browser-view.tsx:1842`), whose image requests to the backend get
  the auth key (`emain/authkey.ts:111-119`, `moltenterm-app-auth-policy.ts:70-73`).
- **Scenario.** A page declares `<link rel=icon href="http://127.0.0.1:<backend port>/...">`: an authenticated GET forged
  on the app's behalf. The response cannot be read back.
- **Fix shipped.** `pickFavicon` skips icons on the backend's origin (test in `browser-loading.test.ts`).

#### L2. `window.open` can flood the window with panels (proposed, T12)

- **Evidence.** Feature-less `window.open` goes to `NewWindowChannel` (`emain/moltenterm-popups.ts:53-56`); each becomes a
  panel. No user-activation check and no rate limit; `allowpopups` is on for both webviews.
- **Fix proposal.** Require the opener frame's user activation (`details.disposition`, or a renderer-side check) and cap
  new tabs per guest per second; beyond, show a "popups blocked" chip.

#### L3. Popup placement and blank-popup titles are page-controlled (proposed, T12)

- **Evidence.** `popupBounds` keeps the page's `left`/`top` (`browser-popup.ts:132-145`), unclamped to the parent window or
  the work area. A popup on `about:blank` filled by its opener shows the page's own title, with no host
  (`browser-popup.ts:158-170`).
- **Fix proposal.** Clamp popups to the work area, and title a blank popup with its opener's host.

#### L4. Permission decisions are keyed by host, not origin (proposed, T13)

- **Evidence.** `permissionSite` returns `host` for both http and https (`site-permission.ts:37-47`).
- **Risk.** A grant for `https://site` also covers `http://site`. Chromium only offers these features to secure contexts,
  which limits it.
- **Fix proposal.** Key by origin (scheme included), with a migration of the stored decisions.

#### L5. `read_page` masks fewer fields than the input tools treat as sensitive (proposed, T14)

- **Evidence.** The reading side checks `type=password` and `autocomplete` only (`pkg/molten/browseragent/axtree.go:242-252`);
  the input side also checks name and id patterns, `-webkit-text-security` and fields that were passwords
  (`emain/moltenterm-browseragent-policy.ts:592-631`).
- **Risk.** A card security code without `autocomplete`, or a password the user revealed, reaches the agent in clear.
- **Fix proposal.** One classification for both sides.

#### L6. Check-then-act windows in the agent tools (proposed, T14)

- **Evidence.** Reads compare only the host before and after (`pkg/molten/browseragent/pages.go:188`), not the history
  entry. `Molten.setField` and `Molten.inspect` run without the host re-check every `Input.*` event gets
  (`emain/moltenterm-browseragent.ts:397-405`). Typing inspects the focused field once, then sends up to 100 chunks
  (`input.go:527-546`).
- **Fix proposal.** Compare the entry id after reads, and pass the expected host to the `Molten.*` operations.

#### L7. Address bar and engine schemes (proposed, T13)

- **Evidence.** `addressOf` keeps any `scheme://` text and bare `about:`, `file:` and `data:` (`browser-model.ts:382-404`),
  so a typed `chrome://` or `devtools://` loads in the shared session. Only the user can type it.
- **Fix proposal.** Refuse `chrome:`, `devtools:` and `chrome-devtools:` in the address bar and in `loadURL` of an
  existing tab (new tabs are covered by M1); confirm a typed `data:` page.

#### L8. Permission handlers trust any non-guest contents in a browsing session (proposed, T19)

- **Evidence.** `isAppRenderer` grants everything to contents that are neither a webview nor a registered popup
  (`emain/moltenterm-site-permissions.ts:73-78`, `:176-178`, `:190-192`), whatever their session.
- **Risk.** None reachable today (every guest popup is registered), but a new window path would get camera and
  microphone without a question.
- **Fix proposal.** Grant only contents in the private app session.

#### L9. HTTP authentication is cancelled silently (proposed, T18)

- **Evidence.** No `login` handler; Electron cancels every HTTP authentication request. No credential leaks, but sites
  behind basic auth (staging servers, routers) fail with no prompt, which pushes users to put credentials in the URL.
- **Fix proposal.** An in-tab sign-in prompt naming the origin and realm, never pre-filled for a cross-origin request.

### Info

- **I1. Auth key in wavesrv's initial environment.** wavesrv receives the key in its environment
  (`emain/emain-wavesrv.ts:72`) and unsets it after reading (`pkg/authkey/authkey.go:36`); the initial environment may
  stay readable to same-user processes on some systems. Needs verification; same-user scope.
- **I2. Builder window.** It has no `will-navigate` handler (`emain/emain-builder.ts:54-80`); a navigated app page loses
  its IPC and credentials (`docs/browser-auth-boundary.md`), so the impact is cosmetic.
- **I3. Page-started navigations of a controlled tab.** JavaScript and meta-refresh redirects, and links the agent
  clicks, load unapproved sites with the user's cookies; reading and input there stay blocked
  (`pkg/molten/browseragent/pages.go:366-369`). Accepted by design.

## Engine update policy

MoltenTerm ships Chromium through Electron: a Chromium security fix reaches users only with an Electron patch and a
MoltenTerm release. Proposed policy (T8):

1. **Supported line.** Stay on an Electron major that upstream supports (the latest three stable majors) and move to the
   next one at least four weeks before end of support. `security/dependencies.json` `electronLifecycle` keeps the
   review date and the tentative end of support (today 2027-04-27 for 45).
2. **Watch.** Electron releases (`https://releases.electronjs.org/releases.json`), Electron's GitHub security
   advisories and the Chrome Releases blog (the Chromium version of each Electron patch is in the release feed).
3. **Patch deadlines**, counted from the Electron patch that carries the fix:
   - a Chromium or Electron fix for a bug exploited in the wild, or rated critical: a MoltenTerm patch within **3 days**;
   - high: within **7 days**;
   - other security fixes: the next release, within **30 days**.
4. **Staleness check (design).** A scheduled workflow (daily, plus manual dispatch) and the release workflow run
   `scripts/security/electron-staleness.mjs`:
   - read the pinned version from `package.json` and the lock;
   - fetch the release feed; compute the newest patch of the same major, its date and its Chromium version;
   - flag when a newer patch of the same major is older than 7 days, when the major's end of support is within 30
     days, or when an Electron advisory affects the pinned version (GitHub advisories API, already reached by the npm
     audit of the scanner);
   - on the schedule, open or update one issue (deduplicated by title, label `security`), never bump on its own;
   - in the release workflow, fail the release on a flag unless `dependencies.json` holds a reviewed, dated exception
     (same format and expiry rules as the scanner's).
     The offline `electronLifecycle` check stays as it is; the online check complements it.

## Phishing and malware protection

| Option                                                                                                                       | Privacy                                          | Cost and terms                                                                                                                                              | Electron feasibility                                                                                                                                                      | Coverage                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Safe Browsing Update API (hash-prefix lists kept locally, full hashes fetched only on a prefix match)                        | Good: Google sees only hash prefixes, on matches | Google's free Safe Browsing APIs are for non-commercial use; a commercial product uses Web Risk (paid per request above a free tier; check current pricing) | Feasible: wavesrv keeps the lists, Electron main checks main-frame navigations and downloads in `session.webRequest.onBeforeRequest` and shows an interstitial in the tab | The reference lists (phishing, malware, unwanted software) |
| Safe Browsing / Web Risk Lookup API (one request per URL)                                                                    | Poor: every visited URL goes to Google           | Same terms; more requests                                                                                                                                   | Simple                                                                                                                                                                    | Same lists, real time                                      |
| Open community feeds (abuse.ch URLhaus, OpenPhish community, PhishTank)                                                      | Good: lists downloaded, nothing sent             | Free, with per-feed licences (some forbid commercial use)                                                                                                   | Feasible, same hook                                                                                                                                                       | Lower and slower                                           |
| Lookalike-domain warning (Unicode confusables skeleton, edit distance to the user's bookmarks, history and a top-sites list) | Good: local                                      | Free                                                                                                                                                        | Feasible in the address bar and on navigation                                                                                                                             | Catches targeted typosquats, not lists                     |
| Password field over plain http                                                                                               | Good: local                                      | Free                                                                                                                                                        | Feasible: the webview preload sees `input[type=password]` on an `http:` page outside localhost and the tab shows a warning                                                | Narrow but certain                                         |

**Proposal.** Phase 1 (1.0.x, no third party): the "Not secure" indicator (M5), the password-over-http warning and the
lookalike-domain warning, each a warning the user can pass, never a block. Phase 2: the Update API through Web Risk
(commercial terms), lists stored by wavesrv, checked on main-frame navigations and downloads; on a hit, an interstitial
with "Back to safety" and "Continue anyway"; never send full URLs; a setting to turn it off; fail open with a visible
"protection unavailable" state when the lists are stale. Downloads also get the system quarantine attribute and a
warning for executable types.

## Passwords and secrets: Andvari integration

MoltenTerm does not build its own password manager or secret store. The suite's tool is **Andvari**, a DiamondForge soft
fork of the Bitwarden clients, browser extension first, with a key tether bound to a YubiKey (`andvari-host`, native
messaging; Andvari's `docs/SPEC.md`). Integration points MoltenTerm would need:

1. **Autofill in the browser panel.** Electron loads Chrome extensions (`session.extensions`) but implements only part of
   the MV3 APIs; the Bitwarden extension relies on APIs Electron lacks or only partly provides (action popup, context
   menus, `nativeMessaging`, `declarativeNetRequest`, `browsingData`, `webNavigation`). A spike decides between loading
   Andvari's extension as is, a small MoltenTerm shim for the missing APIs, or a native bridge to Andvari. Constraints:
   the extension runs only in guest sessions, never in the app session; autofill never fills or reveals a value in a
   tab an agent controls, and filled values stay masked to the agent tools (L5); the extension follows Andvari's
   upstream security merges.
2. **A secrets provider for agents and environments.** A reference (for example an Andvari item and field) resolved when
   an agent or a command starts, after the user's approval per secret and per project, released by a YubiKey touch,
   injected into the process environment only (never written to disk, scrollback or logs), with a time limit and an
   audit entry. The agent never gets vault access. Constraints: talk to Andvari through an authenticated local channel
   (peer credentials and code signature on a Unix socket), never through an unauthenticated localhost REST server such
   as `bw serve`.
3. **YubiKey-bound sessions in the panel.** MoltenTerm owns the panel's sessions, so it can apply Andvari's tether
   natively: presence events from `andvari-host`; with the key absent, block a protected site's background requests
   (`session.webRequest`), wipe its storage on the next user action (`session.clearStorageData` with its origins), and
   refuse agent control of protected sites. Constraints: fail closed when the helper is missing; both sides check each
   other's identity; the protected-domain list is the user's, written only from the window.

## Proposed tickets

Each proposal is now a ticket, named after its title below. In 1.0.0: T1 to T5, T8 and T19. In 1.1.0: T6, T7, T9 to T14
and T18. T15 to T17 belong to the Andvari exploration
([#1963](https://github.com/DiamondForgeFr/moltenterm/issues/1963)).

- **T1. Flip Electron fuses in packaged builds** ([#1975](https://github.com/DiamondForgeFr/moltenterm/issues/1975), High). Packaged builds keep Electron's default fuses, so a same-user
  process can run code under MoltenTerm's signature and reach what it is granted, the browser's cookie encryption key
  included. Set `electronFuses` in `electron-builder.config.cjs`: run-as-node, `NODE_OPTIONS` and CLI inspect arguments
  off, embedded asar integrity and asar-only loading on, and the file protocol's extra privileges off once the app page
  does not need them. Move the perf and accessibility scripts that drive the built app with `--inspect` to a dev build
  or the remote debugging port, and qualify a packaged build on macOS and Linux.
- **T2. Put Wave web blocks behind the agents' site approval** ([#1976](https://github.com/DiamondForgeFr/moltenterm/issues/1976), High). Wave's `wsh web get` reads a Wave web block's page
  in its main world with no site approval, and Wave web blocks share the panel's signed-in session. Check the site
  approval of FR-BRW-009 in Electron main before a webselector call (or limit it to blocks on approved sites), return
  the result inside the untrusted envelope, and refuse it for a remote caller.
- **T3. Content-Security-Policy for the app page** ([#1977](https://github.com/DiamondForgeFr/moltenterm/issues/1977), Medium). The app renderer holds privileged IPC and backend
  credentials with no CSP. Define a strict policy (self-only scripts, no objects, limited frames and connections),
  ship it report-only, fix what it reports (Monaco and Mermaid workers, inline styles), then enforce it.
- **T4. Confirm local and data pages opened from a terminal** ([#1978](https://github.com/DiamondForgeFr/moltenterm/issues/1978), Medium). Pages queued in block meta (`wsh web open`,
  `BROWSER`, agents) can load `file:` and `data:` in the shared session. Ask in the tab before such a page loads, naming
  the file; keep http(s) as today. Pair with T1's file protocol fuse.
- **T5. Client certificate picker in the tab** ([#1979](https://github.com/DiamondForgeFr/moltenterm/issues/1979), Medium). Electron gives a site the first matching client certificate
  without asking. Handle `select-client-certificate` for guests: ask in the tab with the site and the list, none
  preselected, remembered per site.
- **T6. Connection security indicator** ([#1980](https://github.com/DiamondForgeFr/moltenterm/issues/1980), Medium). The address bar hides the scheme and shows no lock. Add a "Not secure"
  chip for http outside localhost and for mixed content, a site information popover (connection, certificate, granted
  permissions), and a warning when a password field appears on an http page.
- **T7. Phishing and malware protection** ([#1982](https://github.com/DiamondForgeFr/moltenterm/issues/1982), Medium). Phase 1: lookalike-domain warning against bookmarks, history and a
  top-sites list. Phase 2: Web Risk Update API lists kept by wavesrv, checked on main-frame navigations and downloads,
  with an interstitial the user can pass, a setting, and a visible state when the lists are stale. Downloads get the
  quarantine attribute and an executable-type warning.
- **T8. Electron patch policy and staleness check** ([#1983](https://github.com/DiamondForgeFr/moltenterm/issues/1983), Medium). Adopt the patch deadlines of this report, add the scheduled
  and release-time staleness check, and bump Electron to the newest 45.2 patch after reviewing its notes.
- **T9. Confirm an agent's click inside a sensitive frame** ([#1984](https://github.com/DiamondForgeFr/moltenterm/issues/1984), Medium). A click in a frame is never confirmed, while typing
  there is. Ask for a left click on a frame target on pages with a sensitive form or a payment or sign-in frame, without
  asking on every frame.
- **T10. Downloads from tabs an agent opened** ([#1985](https://github.com/DiamondForgeFr/moltenterm/issues/1985), Medium). A tab or popup opened from a controlled tab inherits its control
  for downloads, so their downloads ask on the opener's bar.
- **T11. Optional session isolation** ([#1986](https://github.com/DiamondForgeFr/moltenterm/issues/1986), Medium, product decision). A setting for a workspace or a Space to use its own
  persistent partition, and an option for agent tabs to run in a separate, signed-out partition.
- **T12. Popups: user activation, rate limit, placement and titles** ([#1987](https://github.com/DiamondForgeFr/moltenterm/issues/1987), Low). Require user activation for `window.open`, cap
  new tabs per page, clamp popup bounds to the work area, and title a blank popup with its opener's host.
- **T13. Origin-keyed permissions and refused engine schemes** ([#1988](https://github.com/DiamondForgeFr/moltenterm/issues/1988), Low). Key site permissions by origin with a migration;
  refuse `chrome:`, `devtools:` and `chrome-devtools:` in the address bar and in navigations of an existing tab; confirm
  a typed `data:` page.
- **T14. Agent tools: masking parity and check-then-act** ([#1989](https://github.com/DiamondForgeFr/moltenterm/issues/1989), Low). One sensitive-field classification for reading and input;
  compare the history entry after reads; check the expected host in `Molten.setField` and `Molten.inspect`.
- **T15. Andvari in the browser panel (spike)** ([#1963](https://github.com/DiamondForgeFr/moltenterm/issues/1963), Medium). Decide how Andvari's autofill reaches the panel (its extension in
  Electron, a shim for missing MV3 APIs, or a native bridge), with the constraints of the Andvari section.
- **T16. Andvari secrets provider for agents** ([#1963](https://github.com/DiamondForgeFr/moltenterm/issues/1963), Medium). Resolve secret references at agent or command launch through an
  authenticated local channel to Andvari, approved per secret and project, released by a YubiKey touch, injected into
  the environment only, time-limited and audited.
- **T17. YubiKey-bound panel sessions** ([#1963](https://github.com/DiamondForgeFr/moltenterm/issues/1963), Low, later). Apply Andvari's key tether to the panel's own sessions from
  `andvari-host` presence events: block background requests, wipe on use, refuse agent control while the key is absent,
  fail closed.
- **T18. HTTP authentication prompt** ([#1990](https://github.com/DiamondForgeFr/moltenterm/issues/1990), Low). An in-tab prompt for basic and digest authentication naming origin and realm.
- **T19. Consent stores and permission handler hardening** ([#1991](https://github.com/DiamondForgeFr/moltenterm/issues/1991), Low). Keep site decisions in a store only wavesrv writes (or
  signed), so editing the settings file does not grant a site; grant the permission handlers' "app renderer" verdict only
  to contents in the private app session.

## Fixes shipped in this story

| Finding | Change                                                                                                                                      | Test (fails without the change)                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| M1      | `hardenWebviewAttach` in `will-attach-webview` (`emain/moltenterm-webview-attach-policy.ts`, `emain/authkey.ts`, `emain/emain-platform.ts`) | `emain/moltenterm-webview-attach-policy.test.ts`, `emain/moltenterm-app-auth-integration.test.ts` |
| H1      | `SetConfigCommand` refuses the consent keys from terminals (`pkg/wshrpc/wshserver/moltenterm_configguard.go`)                               | `pkg/wshrpc/wshserver/moltenterm_configguard_test.go`                                             |
| H2      | webselector lookup skips browser panel tabs (`emain/moltenterm-webselector-policy.ts`, `emain/preload.ts`)                                  | `emain/moltenterm-webselector-policy.test.ts`                                                     |
| L1      | `pickFavicon` skips the backend origin (`frontend/moltenterm-shell/browser/browser-loading.ts`)                                             | `frontend/moltenterm-shell/browser/browser-loading.test.ts`                                       |

M3 was fixed afterwards by #1978 (see the finding).

FR-BRW-014 was amended in the SRS before these changes.
