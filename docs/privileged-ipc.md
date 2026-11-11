# Privileged desktop IPC

FR-BRW-015 (#806) extends the application identity boundary in FR-BRW-014 (#805).
The main-process registration helpers in `emain/moltenterm-privileged-ipc.ts` fail closed until the single
application identity predicate is configured. They do not infer trust from an IPC channel, URL, partition
or `webContents` ID. The #805 registry checks the registered object, its private session, live current main
frame and exact application document URL. Existing object ownership and capability checks still apply
after that caller check.

`onAppIpc` answers denied synchronous calls with `null` and ignores their action. `handleAppIpc` rejects
denied invocations with a fixed generic error. Neither logs arguments, credentials, environment values or
caller URLs. Registration returns a disposer where a temporary event listener needs cleanup.

`onGuestIpc` is reserved for the explicitly inventoried native guest input signals. It accepts only a live
webview's main frame with a live registered application host. Each handler retains its narrower guest
ownership and payload checks; this path never grants a guest general application privileges.

## Renderer environment contract

`get-env` permits only these non-secret values, checked before reading the environment:

| Name | UI purpose |
| --- | --- |
| `WAVE_SERVER_WEB_ENDPOINT` | Local backend HTTP location |
| `WAVE_SERVER_WS_ENDPOINT` | Local backend WebSocket location |
| `WAVETERM_DEV` | Development UI mode |
| `WAVETERM_DEV_VITE` | Development renderer mode |
| `MOLTENTERM_CHANNEL` | Release channel presentation |
| `MOLTENTERM_SAFE_MODE` | Safe-mode startup |

All other names and invalid name types return `null`, including HOME, PATH, auth keys and provider
credentials. Home, configuration and data paths use their dedicated guarded application APIs.

## Handler inventory

All channels below require the registered application main frame through `onAppIpc` or `handleAppIpc`.
The checks inside each handler remain in force; authenticating an application does not replace target
ownership, confirmation, capability expiry or browser-agent consent.

| Module | Application channels |
| --- | --- |
| `authkey.ts` | `get-auth-key` |
| `moltenterm-accessibility.ts` | `moltenterm:get-accessibility-support` |
| `moltenterm-window-buttons.ts` | `moltenterm-window-buttons` |
| `moltenterm-window-look.ts` | `moltenterm-window-look`, `moltenterm-window-look-support` |
| `moltenterm-hang-watch.ts` | `moltenterm-hang-pong`, `moltenterm-slow-sync-ipc`, `moltenterm-hang-diagnostics`, `moltenterm-hang-copy` |
| `moltenterm-renderer-gone.ts` | `moltenterm-show-log` |
| `emain-platform.ts` | `get-is-dev`, `get-platform`, `get-user-name`, `get-host-name`, `get-webview-preload`, `get-data-dir`, `get-config-dir`, `get-home-dir` |
| `emain-ipc.ts` | `open-external`, `download`, `get-cursor-point`, `capture-screenshot`, `get-env`, `get-about-modal-details`, `get-zoom-factor`, `webview-focus`, `register-global-webview-keys`, `set-keyboard-chord-mode`, `set-is-active`, `update-window-controls-overlay`, `quicklook`, `clear-webview-storage`, `set-window-init-status`, `fe-log`, `increment-term-commands`, `native-paste`, `open-builder`, `set-builder-window-appid`, `open-new-window`, `close-builder-window`, `do-refresh`, `save-text-file` |
| `moltenterm-native-path.ts` | `open-native-path`, `reveal-native-path`, `moltenterm-open-third-party-notices` (opens the one `THIRD-PARTY-NOTICES.txt` of the application's resources folder with the system's viewer; the renderer sends no path) |
| `moltenterm-file-clipboard.ts` | `moltenterm-copy-file` (the file panel's Copy file, FR-FILE-005: main accepts only a string that is an absolute path of an existing regular file, never reads the file, writes one clipboard entry holding its file URL, and answers only a code; macOS and Linux, `unsupported` elsewhere. No RPC, `wsh` or `molten` command reaches it) |
| `emain-window.ts` | `set-active-tab`, `create-tab`, `set-waveai-open`, `close-tab`, `switch-workspace`, `create-workspace`, `delete-workspace`, `reset-workspace`, `undo-workspace` |
| `emain-menu.ts` | `contextmenu-show`, `workspace-appmenu-show`, `builder-appmenu-show` |
| `updater.ts` | `install-app-update`, `get-app-update-status`, `get-updater-channel` |
| `moltenterm-update.ts` | `moltenterm-update-check`, `moltenterm-update-apply`, `moltenterm-update-last` |
| `moltenterm-release-feed.ts` | `moltenterm-release-check` |
| `moltenterm-release-install.ts` | `moltenterm-release-install-state`, `moltenterm-release-install-start` (main accepts only the release its own last check offers, builds the file addresses from the release tag and the file name, and installs nothing before the signed checksums, the file's SHA-256 and the platform's signature check pass), `moltenterm-release-install-apply`, `moltenterm-release-install-reveal`, `moltenterm-release-install-last`, `moltenterm-release-install-cancel` (stops only a download in flight, #2163) |
| `moltenterm-dialogs.ts` | `moltenterm-choose-path` |
| `moltenterm-i18n.ts` | `moltenterm-system-languages`, `moltenterm-set-language-packs`, `moltenterm-set-locale` |
| `moltenterm-system-notify.ts` | `moltenterm-system-notify`, `moltenterm-system-notify-close` |
| `moltenterm-carpet-thumbs.ts` | `moltenterm-carpet-thumb-put`, `moltenterm-carpet-thumb-read`, `moltenterm-carpet-thumb-remove` (the 360 carpet's thumbnails: the key is checked, a JPEG of at most 1 MB is written only into the application's own `carpet-thumbs` data folder) |
| `moltenterm-favicons.ts` | `moltenterm-favicon-read`, `moltenterm-favicon-measured`, `moltenterm-favicon-capture` (the sites' icons: an origin is checked as a web origin; main reads a page's own declared icon only through that page's session, keeps an image format of at most 64 KB in the application's own `favicons` data folder, and `capture` accepts only a web page guest of the calling window) |
| `moltenterm-downloads.ts` | `moltenterm-downloads-list`, `moltenterm-downloads-act`, `moltenterm-downloads-clear`, `moltenterm-downloads-check` (the downloads of the web pages: a request names a download by the id main gave it and one action of a fixed list; main re-checks the file before opening or revealing it, refuses a program unless the request says the user confirmed, and answers only with codes, never a path the window did not already hold; the history is a record in the application's own `downloads` data folder and clearing it touches no file) |
| `moltenterm-tab-activity.ts` | `moltenterm-window-activity-get` |
| `moltenterm-screen.ts` | `moltenterm-screen-get` |
| `moltenterm-system-idle.ts` | `moltenterm-system-idle-get` (a number of seconds, this computer's idle time; no argument) |
| `moltenterm-colleague.ts` | `moltenterm-brokk-start`, `moltenterm-brokk-stop`, `moltenterm-brokk-facts`, `moltenterm-brokk-input`, `moltenterm-brokk-shown`, `moltenterm-brokk-seen` (Brokk's kind colleague runs once in main for every tab and window: a page tells it what the developer does and the few facts only a page knows, as data read into fixed shapes (a count of agents, one of the known proximity levels, a language code) and a moment's id, a short text; main answers with the moments it raised, which hold nothing from a notification, a file, a pull request or a person, and pushes them on `moltenterm-brokk-moments` to the pages that started) |
| `moltenterm-tabview-host.ts` | `moltenterm-view-pending-action` |
| `moltenterm-busy-close.ts` | `moltenterm-busy-reply` |
| `moltenterm-site-permissions.ts` | `moltenterm-site-permission-answer` |
| `moltenterm-client-certificates.ts` | `moltenterm-client-certificate-answer` (only the window that holds the asking tab answers; main accepts a certificate only if it was in the list offered for that request, and no other answer than use, none or dismiss) |
| `moltenterm-webview-lifecycle.ts` | `moltenterm-webview-shown` |
| `moltenterm-browseragent.ts` | `moltenterm-webview-registered` |
| `moltenterm-contextmenu.ts` | `moltenterm-contextmenu-revoke`, `moltenterm-contextmenu-guest`, `moltenterm-contextmenu-capture`, `moltenterm-contextmenu-role`, `moltenterm-contextmenu-save-image` |
| `emain-web.ts` | Dynamic `getWebContentsByBlockId-<uuid>` replies: additionally bound to the original contents object and frame; only that host's live webview may be returned. Foreign replies do not consume the listener. Completion, navigation, destruction, send failure and timeout remove listener/timer resources. |

Only these three channels use `onGuestIpc`, additionally requiring the live guest's main frame and a
registered application host:

| Channel | Limited effect and retained checks |
| --- | --- |
| `webview-mouse-navigate` | Back or forward in the sending guest's own navigation history. Other directions do nothing. |
| `moltenterm-webview-input` | Notify browser-agent takeover for that registered owned guest; existing agent token/control and input matching remain unchanged. No arbitrary command or clipboard action. |
| `moltenterm-contextmenu-guest-request` | Ask the owning active app to present the guest menu. Existing active-host/guest, focus, coordinate and image rules remain. Clipboard/image actions require a separate application request with its captured capability. |

Main-to-renderer messages and `ipcRenderer.sendToHost` are not application privilege entry points. Native
browser permission and navigation callbacks retain their own policies and are outside this IPC inventory.
An inventory test rejects direct `ipcMain` registration outside the helper and requires documented channels.

## Integration status

`emain/authkey.ts` configures the helpers once, at module load, with the #805 registry predicate
`isTrustedAppSender` (#877). Every application window and builder window registers through
`registerTrustedAppContents`, so their main frames pass; guests, popups, child frames, unregistered or
destroyed contents and registered contents navigated away from the application document are denied.
`emain/moltenterm-app-auth-integration.test.ts` exercises that hookup through the real helper.

Channels added later must register through `onAppIpc`, `handleAppIpc` or (for an inventoried guest signal)
`onGuestIpc` and appear in the table above; the inventory test fails otherwise. The #808 accessibility
getter and the #849 hang watch channels follow this rule. The application-level tests use
fixture values and harmless metadata; packaged human verification remains part of the PR review gate.
