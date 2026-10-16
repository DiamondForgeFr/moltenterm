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

## Integration status

The helper and policy are delivered first as a standalone technical subtask. The handler inventory and
single-registry hookup follow in #806. Its PR stays draft until #805 is merged and the combined exact
delivery head is validated. The application-level tests use fixture values and harmless metadata;
packaged human verification remains part of the PR review gate.
