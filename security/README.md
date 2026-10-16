# Dependency security

MoltenTerm scans the complete npm workspace lockfile and both Go module graphs. An advisory is a finding to assess;
its severity, npm dependency flag or Go call-graph trace alone does not establish an exploitable product defect.
The release gate must nevertheless fail when a potentially high-impact finding has not been reviewed.

`dependencies.json` is the reviewed inventory and disposition policy. Empty dispositions are not a claim that the
baseline passes the gate: every unmatched finding requires review, including lower-severity and tooling findings.

## Run and read a scan

Use Node 22, npm **10.9.2** and the exact Go toolchain selected by `scripts/moltenterm-go-toolchain.mjs`:

```sh
task security:test
node scripts/security/scan.mjs --out artifacts/security-review
task security:runtime
```

The output directory must be new. The scanner does not install the application or run npm lifecycle scripts; it
retrieves the full npm workspace audit and installs the exact pinned govulncheck into that report's tools directory.
`security:runtime` separately requires installed application dependencies. Each subprocess has a timeout and its own
stdout/stderr, arguments, exit status and retrieval timestamps in `manifest.json`. `report.json` retains original npm
parent/meta-vulnerability relationships, leaf advisory metadata/occurrences and Go traces, config and SBOM. `report.md`
is the escaped human summary. Metadata fingerprints deliberately invalidate a review when an advisory changes.

Exit **0** is `reported-only`: no blocking findings remain under current reviews. Exit **1** is `blocked-policy`:
findings need review/remediation or a review/exception expired. Exit **2** is `scanner-input-failure`: setup, retrieval,
protocol, policy or completeness failed. A failure report/raw output is retained; it never means clean. Only leaf npm
advisories become normalized findings, while npm's meta-vulnerability graph remains evidence. npm aggregates ranges
across installed occurrences, so the normalizer conservatively associates each reported leaf with every occurrence
named in that entry; it does not silently drop a potentially affected version using a second range implementation.

CI runs the full scan on every PR (drafts included) and every push to `develop`/`main`, so dependency/policy changes are
always covered. The Required gate explicitly requires its reusable job to succeed. Weekly/manual scans report newly
published advisories. Release builds and publication depend on the same secret-free reusable job. Each packaging
runner adds `--native-only` CGO-enabled scans before packaging; this supplement does not replace full npm/cross-target
coverage. Reports/raw output are uploaded even on policy/scanner failure. Tools binaries/caches are not artifacts.

Advisory retrieval happens during each run. The Go database's `db_last_modified` is the upstream database publication
time, not the time this scan retrieved it; both are recorded. Scanner pin/protocol/DB changes require policy updates.

## Shipped and development surfaces

The root package's production dependency graph is conservatively considered potentially shipped, following all
resolved transitive occurrences. The Electron executable is shipped even though `electron` is a devDependency;
it is an explicit runtime root. The downloader beneath the Electron npm installer is a build/install surface,
not part of the runtime executable. Electron updater dependencies are runtime code even when builder uses them too.

Classify every finding as `shipped-runtime`, `developer-build-install`, `docs-only`, or `needs-review`, with evidence
from the manifest, dependency path, imports and packaged artifact. Runtime wins when an installed dependency is shared
with a development graph. The production builder bundles imports and excludes `node_modules`; this helps identify
the shipped code but does not by itself prove that a vulnerable module is unused.

Build/install findings need their own exposure review: archive extraction, untrusted source processing, developer
servers and release tooling can affect developer machines even when their code is absent from the app. A docs-only
finding must distinguish a deployed server from static output and local documentation tooling.

## Blocking policy

- Block applicable high/critical runtime findings and equivalent high-impact developer/build/install exposure.
- Block high/critical findings whose surface or applicability still needs review. Unknown-severity reachable runtime
  findings also need review; missing severity is not permission to ignore them.
- Report documented nonapplicable findings, lower-impact findings and owned tooling/docs follow-ups. Every remaining
  alert needs a concrete input path/condition, evidence, accountable owner and review date or linked follow-up.
- A compensating control may support an applicability assessment; it does not waive an advisory without evidence.
  For example, Mermaid's strict mode is not blanket immunity, and `vitest run` is not an exposed Vitest UI server.
- An applicable high-impact exception requires actual human review. It names one advisory, package/version scope,
  target/surface, reason, control, accountable owner, reviewer/reference and UTC expiry. Broad wildcard or timeless
  exceptions are invalid. Expired/malformed exceptions fail; a new advisory cannot inherit another advisory's waiver.

Record advisory aliases without losing occurrences: ecosystem, canonical advisory ID, package/module, resolved
version, lockfile path/module graph and supported target identify a finding. Keep raw severity, affected/fixed range,
source and Go trace. Group duplicates only in the human summary. A module-level finding and a called-symbol finding
have different reachability evidence; neither is silently discarded.

Scanner errors are separate from findings. Missing, partial, malformed or unsupported output, failed advisory
retrieval and timeout cannot produce a clean scan. Upload raw output and a readable failure report even when the gate
fails. A valid npm audit exit 1 means findings; a JSON error response does not. In JSON mode govulncheck exits 0 even
when it finds vulnerabilities, so findings must be parsed rather than inferred from its exit code.

## Coverage and review

Scan root `cmd`/`pkg` packages and standalone `tsunami`; the local replacement does not substitute for reviewing its
own graph. Record Go version, GOOS/GOARCH, CGO/build tags, scanner version and advisory database timestamp. Declared
targets cover the published macOS/Linux architectures and remote-helper Windows/MIPS source. Desktop targets scan
`./cmd/... ./pkg/...`; remote-only targets scan `./cmd/wsh/...`. Standalone Tsunami scans `./...` for every declared
target. Cross-target source scans
must disclose CGO exclusions and be complemented by native builds and relevant native scans. Go vulnerability data
does not cover all C/native libraries or the bundled Chromium runtime. Full scans use CGO=0 on each declared target
plus CGO=1 on the host. Release packaging adds native CGO=1 coverage on the actual macOS/Linux runner; a macOS arm64
source scan does not claim native amd64 CGO coverage. Source scans cannot substitute for native artifact verification.
Build tags are recorded as the default empty set in source-scan coverage; the package build's SQLite/osuser tags do
not silently alter this scan. The release's single macOS runner contributes only its own architecture's native CGO
analysis; the other Darwin architecture retains cross-target CGO=0 coverage and its separately built artifact.

Use exact supported, patched runtime versions after checking official releases and advisories. Keep macOS 12 support
when selecting a maintained Electron line: Electron 44 requires macOS 13. Do not change historical performance
baselines to make their runtime version look current. Both `go.mod` pins, CI and build checks must agree.

Security scans run without signing/release/production credentials, use pinned tools/actions and never repair the
dependency graph during CI. The same policy must gate ready PRs and release builds/publication; a scheduled report or
a skipped draft job alone is not release evidence. The developer reviews residual exceptions and merges the PR.

## Baseline for #810

2026-10-17, dependency graph and source at `bbc10e86`:

| Scan | Result |
| --- | --- |
| npm 10.9.2, full workspace graph | 114 vulnerable package entries: 17 critical, 63 high, 21 moderate, 13 low; 182 distinct advisory URLs |
| govulncheck v1.9.0, Go 1.25.6, darwin/arm64 root source | 86 advisory IDs at all scan levels; 51 IDs with called-symbol traces (1,077 symbol traces, not 1,077 vulnerabilities) |
| govulncheck v1.9.0, Go 1.25.6, darwin/arm64 standalone tsunami | 45 advisory IDs at all scan levels; 21 IDs with called-symbol traces (422 findings across scan levels) |

The initial npm scan ran against an identical dependency graph in the #814 worktree (`c649a52d`; no dependency changes).
Raw npm/Go JSON and stderr are retained at `/private/tmp/mt810/baseline` during implementation; repeatable CI artifact
publication is part of #860. The initial baseline is vulnerable, and an empty disposition list must not pass it.

Priority is the shipped Electron runtime, Go toolchain, the direct SSH `NewClientConn` path, and renderer/main parsers,
sanitizers, shell quoting, WebSocket client and updater code. Official starting points, rechecked before upgrades:

- [Electron stable releases](https://releases.electronjs.org/) and
  [support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines).
- [Electron webview worker advisory](https://github.com/electron/electron/security/advisories/GHSA-9qh4-3jw8-366w):
  requires an unsandboxed embedder; do not claim that condition was established solely by this audit.
- [Go SSH channel deadlock](https://pkg.go.dev/vuln/GO-2026-6355): fixed in `golang.org/x/crypto v0.56.0`.
- [Go TLS ECH server memory exhaustion](https://pkg.go.dev/vuln/GO-2026-6607): fixed in Go 1.26.9/1.27.2;
  a generic TLS call trace alone does not establish the malicious ECH server condition.
- [govulncheck behavior and limitations](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck).

The final report records upgraded resolved versions, remaining evidence-backed dispositions and exact-head checks.
