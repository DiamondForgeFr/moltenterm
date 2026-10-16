# Browser backend authentication

FR-BRW-014 (#805) separates embedded browsing from application HTTP and WebSocket access. The raw legacy auth key
alone is insufficient. Electron generates a separate random proof secret for each backend startup, passes it only
to wavesrv's startup environment, and removes it from the backend environment after initialization. The main process
derives domain-separated HMAC-SHA256 proofs for `main` and `renderer`; the backend compares decoded proofs in constant time.
Neither the secret nor either proof is returned through the preload bridge.

| Caller | Transport and admission |
| --- | --- |
| App tab, hot spare, builder | Private in-memory app session. Exact registered WebContents, session, current main frame and expected document URL. Only non-navigation requests to the exact backend origin receive the renderer proof. |
| Electron main | Native HTTP and Node WebSocket attach the main proof, require an absent Origin, and disable redirects on privileged requests. HTTP applies this policy to both Electron net and global-fetch fallback. |
| Development renderer | Renderer proof plus the exact configured renderer Origin; authenticated media without Origin is accepted deliberately. CORS preflight allows only that configured Origin. |
| Packaged renderer | Renderer proof plus absent, `null`, or `file://` Origin. CORS preflights and responses with opaque/file Origin require the injected renderer proof too. An opaque or absent Origin never grants access by itself. |
| Browser guest, popup, child frame, retired or navigated app contents | No app credential injection, even for the exact backend URL. Guest default and custom cookie partitions are preserved; the reserved app partition is rejected when attaching a webview. |
| CLI and remote peers | Existing Unix-domain/routed RPC identity and authorization remain in place. They do not use the browser HTTP/WS proof. |
| Public schema metadata | `/schema/` remains public. It supplies schemas, not window identity or privileged RPC. |
| Native PDF subframe | A random 256-bit resource token permits GET/HEAD (including Range) of one resolved PDF path and connection. It never authorizes service or WebSocket calls. |

PDF tokens expire after ten minutes, are bounded to 512 entries, and are pruned on issuance. Only the authenticated
renderer can mint, renew or revoke them. The mounted preview renews once per minute without reloading the PDF viewer,
revokes on disposal, and revokes a mint that finishes after disposal. Reads cannot extend a token's life. Requests
cannot substitute the path, connection, query or method; streaming rechecks PDF MIME before sending content. Responses
disable caching and referrer propagation. A leaked token grants only that resource until expiry or revocation; token
URLs must not be logged. Closing the backend revokes all tokens.

The app session listener strips copied app credential headers before deciding whether to inject replacements, including
on external redirects. Navigation requests are denied even when Electron still reports the previously trusted frame.
`get-auth-key` is restricted to the same registered main-frame identity. Broader IPC hardening is tracked separately in
#806; this change does not alter browser-agent consent or ownership checks.

Automated checks cover caller/origin matrices, real HTTP and WS handshakes using harmless metadata, exact frame/session
registration, navigation and destruction, native fallback transport, PDF Range/HEAD/expiry/revocation and preview lease
lifecycle. Human packaged verification remains required before 1.0.0: app startup, multiple windows/hot spares/builder,
PDF and media previews, default/custom guest login persistence, and guest/popup/subframe refusal against harmless app
metadata. Use a disposable isolated app profile for these checks, never the installed user profile.
