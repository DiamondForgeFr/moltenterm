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
| `emain-platform.ts` | `get-is-dev`, `get-platform`, `get-user-name`, `get-host-name`, `get-webview-preload`, `get-data-dir`, `get-config-dir`, `get-home-dir` |
| `emain-ipc.ts` | `open-external`, `download`, `get-cursor-point`, `capture-screenshot`, `get-env`, `get-about-modal-details`, `get-zoom-factor`, `webview-focus`, `register-global-webview-keys`, `set-keyboard-chord-mode`, `set-is-active`, `update-window-controls-overlay`, `quicklook`, `clear-webview-storage`, `open-native-path`, `set-window-init-status`, `fe-log`, `increment-term-commands`, `native-paste`, `open-builder`, `set-builder-window-appid`, `open-new-window`, `close-builder-window`, `do-refresh`, `save-text-file` |
| `emain-window.ts` | `set-active-tab`, `create-tab`, `set-waveai-open`, `close-tab`, `switch-workspace`, `create-workspace`, `delete-workspace`, `reset-workspace` |
| `emain-menu.ts` | `contextmenu-show`, `workspace-appmenu-show`, `builder-appmenu-show` |
| `updater.ts` | `install-app-update`, `get-app-update-status`, `get-updater-channel` |
| `moltenterm-update.ts` | `moltenterm-update-check`, `moltenterm-update-apply`, `moltenterm-update-last` |
| `moltenterm-release-feed.ts` | `moltenterm-release-check` |
| `moltenterm-dialogs.ts` | `moltenterm-choose-path` |
| `moltenterm-i18n.ts` | `moltenterm-system-languages`, `moltenterm-set-language-packs`, `moltenterm-set-locale` |
| `moltenterm-system-notify.ts` | `moltenterm-system-notify`, `moltenterm-system-notify-close` |
| `moltenterm-tab-activity.ts` | `moltenterm-window-activity-get` |
| `moltenterm-tabview-host.ts` | `moltenterm-view-pending-action` |
| `moltenterm-busy-close.ts` | `moltenterm-busy-reply` |
| `moltenterm-site-permissions.ts` | `moltenterm-site-permission-answer` |
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

The handler migration is fail-closed pending the single #805 registry hookup. Its PR stays draft until
#805 is merged and the combined exact delivery head is validated. The independent #808 accessibility
boolean getter and #849 hang diagnostic channels require the same gate when those changes are combined;
their commits are not copied into this PR. The application-level tests use fixture values and harmless
metadata; packaged human verification remains part of the PR review gate.
