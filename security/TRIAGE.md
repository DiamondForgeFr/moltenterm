# Remaining dependency findings — #810 / #861

Reviewed 2026-10-17. Owner: **AGachet**. Review again by **2026-11-17**, sooner if input paths, callers, dependency
versions or advisory metadata change. `dependencies.json` binds each assessment to the exact advisory fingerprint,
affected range, locked occurrence/version, surface, reachability and listed targets. There are **no accepted
high-impact exceptions**. A changed advisory or a new Go package/symbol trace must be reviewed again.

The complete npm audit still reports 61 vulnerable package/meta-vulnerability entries. They resolve to **15 distinct
GHSA IDs / 18 leaf occurrences**; the full parent graph remains in the raw report. Go reports **GO-2026-5932** at module
level in the root graph, with no affected-package or called-symbol finding; standalone Tsunami has none on the scanned
targets. These numbers describe scanner evidence, not an exploit count or a claim that every dependency is safe.

## Runtime callers

- [sprintf-js / GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), 1.1.3: the vulnerable condition
  requires an attacker-controlled precision specifier in the **format string**. `emain/emain.ts:83` uses a literal
  startup format with `%s` placeholders; paths/runtime versions are arguments. `frontend/app/store/ws.ts:122` uses
  literal `sleeping %ds` and a locally bounded reconnect delay. Neither accepts a format or precision from files,
  terminal/network content or settings. This condition is nonapplicable to these callers. Follow-up: replace these
  two formatting calls and remove the direct dependency; no upstream fixed version is available.
- [KaTeX / GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7), 0.16.47: keep a **low-impact,
  potentially applicable** finding visible. Math text may be untrusted. The advisory needs a separate existing
  prototype-pollution primitive or attacker control of an options prototype; this review has not established either
  in these rendering paths and does not prove their universal absence. `WaveStreamdown` supplies text/components,
  not user-derived KaTeX options; Streamdown's default pipeline runs KaTeX then `rehype-sanitize`. Mermaid builds
  fixed rendering options and calls `sanitizeText` on its math output. Default `trust=false` and Mermaid strict mode
  alone are **not** immunity to inherited settings or every resource-limit effect. Follow-up: qualify KaTeX >=0.18.2
  through Mermaid/Streamdown with math, URL and resource-limit regressions before changing their supported ranges.
- [OpenPGP / GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932), x/crypto v0.58.0: the unmaintained APIs are
  `golang.org/x/crypto/openpgp` and its subpackages. The application's static imports and complete source-scan traces
  do not include them. x/crypto is used for other APIs, including SSH; that does not make OpenPGP present. All recorded
  findings contain only the module/version frame. Mark **only this module-level condition** nonapplicable; never
  apply this review to an imported package or called symbol. Keep the SSH handshake/key-policy fixture and rerun the
  source matrix on graph changes.

## Documentation/tooling boundary

The resolved paths below originate only in the `docs` workspace. The Taskfile's `docsite:build:public` is a separate
task. `package` builds the renderer/backend/Tsunami; it does not run the docsite task, and electron-builder's file list
does not ship the docs Node graph. No repository workflow deploys a Docusaurus server. Production output is static;
the optional `docusaurus start/serve` commands are developer tools, not an app endpoint.

This does **not** make build dependencies harmless. `npm ci` installs the workspace graph, including Sharp's native
installer; that installer downloads/builds its library and does not decode docs assets. An explicit docs build later
executes repository configuration, MDX and plugins with the developer's privileges. Reviewed repository sources/assets
are its input boundary. Never treat an image's filename extension as content validation, or run unreviewed docs/code
with signing/publishing credentials. If docs become an upload service, accept untrusted assets/configuration, gain
prototype-pollution input, or run in a credential-bearing deploy pipeline, reassess before enabling that path.

| Locked dependency / advisory | Concrete condition and current caller | Disposition / owned action |
| --- | --- | --- |
| braces 3.0.3; [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Docusaurus globby/fast-glob processes repository/config glob patterns. Deep attacker-provided brace patterns can exhaust the stack; no product/user pattern reaches this docs graph. | Low-impact docs follow-up: update the Docusaurus/glob chain; reassess if patterns come from requests or untrusted configuration. |
| postcss-selector-parser 6.1.4; [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) | Docs CSS optimization parses repository styles. The advisory concerns very large attacker-supplied selectors in synchronous request paths; this graph is not the app's CSS runtime or a selector service. | Low-impact docs follow-up: update the cssnano/parser chain to >=7.1.6 with a docs build regression. |
| qs 6.14.2; [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) | Requires stringify with both comma array format and encodeValuesOnly on null/undefined elements. Express's docs dev-server path parses query strings; no such stringify options/round-trip are configured here. | Condition nonapplicable; update docs server's qs chain to >=6.16.0 on the owned review date. |
| qs 6.14.2; [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) | Requires parse with comma=true and reliance on array limits. The docs dev-server uses Express query parsing without that option. | Condition nonapplicable; retain the same qs update follow-up. |
| qs 6.14.2; [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) | Express allows prototype-named own query properties, so their presence is not claimed safe. This advisory additionally requires passing those attacker-created objects to stringify. No docs request parse→stringify round-trip is configured. | Condition nonapplicable to current callers; recheck any future query serialization and update qs. |
| serialize-javascript 6.0.2; [GHSA-5c6j-r48x-rmvq](https://github.com/advisories/GHSA-5c6j-r48x-rmvq) | Resolved through copy-webpack-plugin 11. Docusaurus's StaticDirectoriesCopyPlugin supplies only owned from/to/info patterns, with no transform/cache callback. Vulnerable spoofed RegExp/Date serialization plus later evaluation is not this path; serialized cache keys elsewhere are strings, not evaluated JavaScript. | Condition nonapplicable; update the docs copy-plugin/serializer chain to >=7.0.5. |
| serialize-javascript 6.0.2; [GHSA-qj8w-gfj5-8c6v](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v) | Crafted array-like objects/prototypes can exhaust CPU during serialization. There is no anonymous object input to the docs build configuration/cache options. | Low-impact docs follow-up: qualify the same serializer update; reassess any external object/config source. |
| Sharp 0.32.6, **two occurrences** under @docusaurus/lqip-loader and @docusaurus/plugin-ideal-image; [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj), [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c), [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) | Native libvips/libheif/librsvg defects matter when decoding malicious image bytes; some conditions permit code execution on Linux. Both copies decode tracked docs assets during the explicit docs build, with no upload, remote-fetch or product-preview path to these copies. The plugin's PNG/JPEG extension rule alone does not establish safety. | Retain **applicable, low current exposure** docs follow-ups under the reviewed-source boundary, not a generic RCE waiver. Qualify both consumers on Sharp >=0.35.5 and native docs image output. If untrusted images are accepted or the build boundary changes, treat as high-impact developer exposure and block. |
| Tinypool 1.1.1; [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) | Docusaurus SSG constructs the worker filename from its own __dirname/ssgWorkerThread.js, fixed worker_threads options and site params. Existing Object.prototype execArgv/env pollution could still inject worker options: no identified anonymous pollution source feeds this build-only pool. Vitest 4 does not use this locked Tinypool occurrence. | Retain a low current exposure docs follow-up, with the pollution prerequisite explicit. Qualify Docusaurus/Tinypool >=2.1.2; discovery of an input primitive or credential-bearing docs build requires blocking high-impact review. |
| Tinypool 1.1.1; [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) | Docusaurus core/lib/ssg/ssgExecutor.js calls pool.run(task) **without a second options object**. The advisory explicitly excludes this invocation shape; its exploit needs a caller-provided run options object plus inherited filename. | Condition nonapplicable; same owned Tinypool follow-up. A future second run argument cannot inherit this rationale. |
| uuid 8.3.2 under sockjs; [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | SockJS transport imports only v4 and invokes uuidv4() without a caller buffer/offset. The affected paths are v3/v5/v6 with external output buffers. The app's direct uuid is separately patched. | Condition nonapplicable; update the docs SockJS chain when compatible. |

These are owned dated reviews, not promises that future dependency graphs or deployments retain the same boundary.
The policy blocks unknown/new occurrences until reviewed, and expires these reviews even if an advisory disappears.
Advisory/version fingerprints do not detect a changed application input path or deployment configuration. Reviewers
must reassess those source/deployment changes even when scanner metadata remains identical.
