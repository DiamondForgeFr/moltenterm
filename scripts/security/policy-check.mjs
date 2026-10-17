// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

/* global structuredClone, URL, process */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertCoverage, evaluatePolicy, expectedGoScopes, fingerprint, markdownReport, normalizeGo, normalizeNpm, npmInventory, parseGoStream, validatePolicy } from "./policy.mjs";

const clone = (value) => structuredClone(value);
const base = JSON.parse(fs.readFileSync(new URL("../../security/dependencies.json", import.meta.url)));
// The fixture is independent of the live dependency graph and needs no installed packages/network.
const policy = () => ({ ...clone(base), dispositions: [], exceptions: [] });
const lock = {
    lockfileVersion: 3,
    packages: {
        "": { workspaces: ["docs", "tsunami/frontend"], dependencies: { shared: "1", app: "1" }, devDependencies: { electron: "42", builder: "1" } },
        docs: { dependencies: { docs: "1", shared: "1" } },
        "tsunami/frontend": { dependencies: { app: "1" } },
        "node_modules/shared": { version: "1.0.0" },
        "node_modules/app": { version: "1.0.0" },
        "node_modules/docs": { version: "1.0.0" },
        "node_modules/electron": { version: "42.11.15", dependencies: { downloader: "1" } },
        "node_modules/downloader": { version: "1.0.0" },
        "node_modules/builder": { version: "1.0.0" },
    },
};
const advisory = { source: 123, name: "app", title: "test <img onerror=x>|`", url: "https://github.com/advisories/GHSA-1234-5678-abcd", severity: "high", range: "<2.0.0" };
function audit(name = "app", via = advisory) {
    return { auditReportVersion: 2, vulnerabilities: { [name]: { nodes: [`node_modules/${name}`], via: [via], severity: via.severity, range: via.range } }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } };
}
const npm = (raw = audit(), code = 1, graph = lock) => normalizeNpm(JSON.stringify(raw), code, graph, policy());
function disposition(finding, extra = {}) {
    const { ecosystem, id, package: name, version, occurrence, affectedRange, surface, reachability, severity, advisoryFingerprint } = finding;
    return { ecosystem, id, package: name, version, occurrence, affectedRange, surface, reachability, severity, advisoryFingerprint, targets: [finding.target], applicability: "applicable", impact: "low", input: "trusted repository input", reason: "specific reviewed condition", evidence: ["file:line and advisory condition"], owner: "AGachet", action: "owned follow-up", reviewBy: "2026-12-01", ...extra };
}
const now = new Date("2026-10-17T00:00:00Z");
const evaluate = (findings, dispositions = [], exceptions = []) => evaluatePolicy(findings, { ...policy(), dispositions, exceptions }, now);
const scope = { module: ".", target: "linux/amd64", cgo: 0, packages: ["./cmd/...", "./pkg/..."] };
const config = { protocol_version: "v1.0.0", scanner_name: "govulncheck", scanner_version: "v1.9.0", go_version: "go1.26.9", scan_mode: "source", scan_level: "symbol", db: "https://vuln.go.dev", db_last_modified: "2026-10-08T00:00:00Z" };
const osv = { id: "GO-2026-1234", aliases: ["CVE-2026-1234"], summary: "fixture", affected: [{ package: { name: "example.test/module" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.0" }] }] }] };
const trace = { module: "example.test/module", version: "v1.0.0" };
const records = () => [{ config: clone(config) }, { SBOM: { go_version: "go1.26.9", roots: ["example.test/module/app"], modules: [{ path: "example.test/module", version: "v1.0.0" }] } }, { osv: clone(osv) }, { finding: { osv: osv.id, trace: [clone(trace)] } }];
const stream = (r) => r.map((entry) => JSON.stringify(entry, null, 2)).join("\n");
const go = (r = records(), code = 0) => normalizeGo(stream(r), code, scope, policy(), "go1.26.9");

test("runtime classification follows resolved graph; Electron dev executable is runtime, its installer is build", () => {
    const inventory = npmInventory(lock, policy());
    assert.equal(inventory.get("node_modules/shared").surface, "shipped-runtime");
    assert.equal(inventory.get("node_modules/electron").surface, "shipped-runtime");
    assert.equal(inventory.get("node_modules/downloader").surface, "developer-build-install");
    assert.equal(inventory.get("node_modules/docs").surface, "docs-only");
    const missing = clone(lock); delete missing.packages["node_modules/app"];
    assert.throws(() => npmInventory(missing, policy()), /locked root/);
    const unclassified = clone(lock); unclassified.packages[""].workspaces.push("new-workspace");
    assert.throws(() => npmInventory(unclassified, policy()), /workspace/);
});

test("high runtime and unreviewed findings block; scoped low-impact docs and runtime low findings report", () => {
    const findings = npm().findings;
    assert.equal(evaluate(findings).exitCode, 1);
    assert.equal(evaluate(findings, [disposition(findings[0])]).exitCode, 1);
    const docs = npm(audit("docs")).findings;
    assert.equal(evaluate(docs).exitCode, 1);
    assert.equal(evaluate(docs, [disposition(docs[0])]).exitCode, 0);
    assert.equal(evaluate(docs, [disposition(docs[0], { impact: "high" })]).exitCode, 1);
    const lowAudit = audit(); lowAudit.vulnerabilities.app.via[0] = { ...advisory, severity: "low" }; lowAudit.metadata.vulnerabilities.low = 1; lowAudit.metadata.vulnerabilities.high = 0;
    const low = npm(lowAudit).findings;
    assert.equal(evaluate(low, [disposition(low[0])]).exitCode, 0);
});

test("exact condition review cannot hide changed advisory, range, occurrence, version, severity or reachability", () => {
    const [finding] = npm().findings;
    const reviewed = disposition(finding, { applicability: "not-applicable" });
    assert.equal(evaluate([finding], [reviewed]).exitCode, 0);
    for (const field of ["id", "version", "occurrence", "affectedRange", "severity", "advisoryFingerprint", "target", "reachability"]) {
        assert.equal(evaluate([{ ...finding, [field]: `${finding[field]}-changed` }], [reviewed]).exitCode, 1, field);
    }
    assert.throws(() => evaluate([finding], [{ ...reviewed, version: "*" }]), /wildcard/);
    assert.throws(() => evaluate([finding], [{ ...reviewed, reviewBy: "2026-02-30" }]), /review date/);
    assert.equal(evaluate([finding], [{ ...reviewed, reviewBy: "2026-10-16" }]).exitCode, 1);
    assert.throws(() => evaluate([finding], [reviewed, reviewed]), /Ambiguous/);
});

test("exceptions need exact scope, real human approval and bounded current expiry", () => {
    const [finding] = npm().findings;
    const exception = { ...disposition(finding), control: "reviewed containment", reviewedBy: "human-owner", approval: "https://github.com/example/project/issues/1#issuecomment-1", createdAt: "2026-10-16T00:00:00Z", expiresAt: "2026-11-16T00:00:00Z" };
    assert.equal(evaluate([finding], [], [exception]).exitCode, 0);
    assert.equal(evaluate([{ ...finding, target: "new-target" }], [], [exception]).exitCode, 1);
    assert.throws(() => evaluate([finding], [], [{ ...exception, reviewedBy: "Codex" }]), /human/);
    assert.throws(() => evaluate([finding], [], [{ ...exception, expiresAt: "2027-11-16T00:00:00Z" }]), /bounded/);
    assert.equal(evaluate([], [], [{ ...exception, createdAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-16T00:00:00Z" }]).exitCode, 1);
    assert.throws(() => evaluate([], [], [{ ...exception, createdAt: "2026-10-18T00:00:00Z" }]), /future|bounded/);
});

test("npm meta-vulnerability graph is retained but only original leaf occurrences become findings", () => {
    const raw = audit(); raw.vulnerabilities.parent = { nodes: ["node_modules/builder"], via: ["app"], severity: "high" }; raw.metadata.vulnerabilities.high = raw.metadata.vulnerabilities.total = 2;
    const result = npm(raw);
    assert.equal(result.findings.length, 1); assert.equal(result.parents.length, 2);
    assert.equal(result.findings[0].advisoryFingerprint, fingerprint(advisory));
    assert.equal(result.findings[0].affectedRange, "<2.0.0");
    raw.vulnerabilities.parentA = { nodes: ["node_modules/builder"], via: ["parentB"], severity: "high" };
    raw.vulnerabilities.parentB = { nodes: ["node_modules/builder"], via: ["parentA"], severity: "high" };
    raw.metadata.vulnerabilities.high = raw.metadata.vulnerabilities.total = 4;
    assert.throws(() => npm(raw), /cannot reach a leaf/);
    raw.vulnerabilities.parentB.via.push("app");
    assert.equal(npm(raw).findings.length, 1, "cycles are supported when they reach an actual advisory");
});

test("npm retrieval errors, incomplete data and invalid counts never mean clean", () => {
    assert.throws(() => normalizeNpm("broken", 1, lock, policy()), /malformed/);
    for (const raw of [{ error: { code: "ENETUNREACH" } }, { ...audit(), auditReportVersion: 99 }, { ...audit(), metadata: {} }]) assert.throws(() => npm(raw));
    assert.throws(() => npm(audit(), 2));
    const incomplete = audit(); incomplete.vulnerabilities.app.nodes = [];
    assert.throws(() => npm(incomplete), /Incomplete/);
    const counts = audit(); counts.metadata.vulnerabilities.total = 4;
    assert.throws(() => npm(counts), /count/);
    const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
    assert.equal(npm(clean, 0).findings.length, 0); assert.throws(() => npm(clean, 1), /status/);
});

test("Go module/package/symbol evidence survives; an uncalled module review cannot allow a new called symbol", () => {
    const [module] = go().findings;
    assert.equal(module.reachability, "module"); assert.deepEqual(module.aliases, osv.aliases);
    assert.equal(module.severity, "unknown"); assert.equal(evaluate([module]).exitCode, 1);
    const reviewed = disposition(module, { applicability: "not-applicable" });
    assert.equal(evaluate([module], [reviewed]).exitCode, 0);
    for (const frame of [{ ...trace, package: "example.test/module/a" }, { ...trace, package: "example.test/module/a", function: "Unsafe" }]) {
        const r = records(); r[3].finding.trace = [frame];
        assert.equal(evaluate(go(r).findings, [reviewed]).exitCode, 1);
    }
});

test("Go protocol needs successful complete exact tool/config/SBOM; duplicate identical OSV is legitimate", () => {
    const r = records(); r.splice(3, 0, { osv: clone(osv) }); assert.equal(go(r).findings.length, 1);
    r[3].osv.summary = "changed"; assert.throws(() => go(r), /Conflicting/);
    assert.throws(() => go(records(), 1), /failed/);
    for (const r of [[], records().slice(1), records().filter((r) => !r.SBOM), [...records(), { unknown: {} }]]) assert.throws(() => go(r));
    for (const field of ["go_version", "scanner_version", "scan_level", "db", "protocol_version"]) {
        const r = records(); r[0].config[field] = "unexpected"; assert.throws(() => go(r), /configuration/);
    }
    assert.throws(() => parseGoStream(stream(records()) + "\n{\"finding\":"), /truncated/);
    assert.throws(() => parseGoStream(stream(records()) + " trailing"), /Unexpected/);
    const missing = records(); delete missing[2].osv.affected; assert.throws(() => go(missing), /advisory/);
    const empty = records(); empty[1].SBOM.roots = []; assert.throws(() => go(empty), /completeness/);
});

test("coverage requires both graphs, all cross targets, native CGO and exact package patterns", () => {
    const p = validatePolicy(policy()); const scopes = expectedGoScopes(p, "linux/amd64");
    assert.equal(scopes.length, 2 * (p.goTargets.length + 1)); assertCoverage(scopes, scopes);
    assert.throws(() => assertCoverage(scopes.slice(1), scopes), /coverage/);
    assert.throws(() => assertCoverage([...scopes, scopes[0]], scopes), /coverage/);
    assert.throws(() => assertCoverage(scopes.map((s, i) => i ? s : { ...s, packages: ["./cmd/wsh/..."] }), scopes), /coverage/);
    assert.equal(expectedGoScopes(p, "darwin/arm64", true).length, 2);
    assert.throws(() => expectedGoScopes(p, "windows/amd64"), /native/);
});

test("advisory strings cannot inject Markdown tables or HTML into summaries", () => {
    const finding = { ...npm().findings[0], id: "<img onerror=x>|`\nBAD" };
    const markdown = markdownReport({ status: "blocked-policy", findings: [finding], reasons: [finding.id] });
    assert.ok(!markdown.includes("<img")); assert.ok(markdown.includes("&lt;img")); assert.ok(markdown.includes("&#124;"));
});

test("actual Required gate jq expression rejects failed, cancelled, skipped security and incomplete job lists", () => {
    const ci = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const expression = ci.match(/--argjson want "\$want" '([\s\S]*?)'\)/)?.[1];
    assert.ok(expression, "read the actual gate expression");
    const wantLine = ci.split("\n").find((line) => line.trim().startsWith('want="'));
    assert.ok(wantLine.includes("Dependency security / Scan dependencies"));
    for (const draft of [true, false]) {
        const want = JSON.parse(wantLine.trim().slice(6, -1).replaceAll('\\"', '"').replaceAll("$heavy", draft ? "skipped" : "success"));
        const jobs = Object.entries(want).map(([name, conclusion]) => ({ name, status: "completed", conclusion }));
        const verdict = (entries) => {
            const result = spawnSync("jq", ["-r", "--argjson", "want", JSON.stringify(want), expression], { input: JSON.stringify(entries), encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
        };
        assert.equal(verdict(jobs), "pass"); assert.equal(verdict(jobs.slice(1)), "wait");
        for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "neutral"]) {
            assert.equal(verdict(jobs.map((job) => job.name.startsWith("Dependency security") ? { ...job, conclusion } : job)), "fail");
        }
        assert.equal(verdict(jobs.map((job) => job.name.startsWith("Dependency security") ? { ...job, status: "in_progress", conclusion: null } : job)), "wait");
    }
});

test("release build/publish depend on security; reusable scanner receives no inherited secrets", () => {
    const read = (file) => fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
    const release = read("release.yml"); const reusable = read("security-scan.yml");
    for (const name of ["macos", "linux", "rehearsal", "publish"]) {
        const section = release.match(new RegExp(`^    ${name}:\\n([\\s\\S]*?)(?=^    \\w+:|$(?![\\s\\S]))`, "m"))?.[1];
        assert.ok(section?.match(/^ {8}needs: \[[^\]]*\bsecurity\b[^\]]*\]/m), name);
    }
    assert.equal((release.match(/node scripts\/security\/scan.mjs --native-only/g) ?? []).length, 2);
    for (const file of ["package-lock.json", "go.mod", "tsunami/go.mod", "security/**", "scripts/security/**"]) assert.ok(release.includes(`- ${file}`), file);
    for (const workflow of [release, read("ci.yml"), read("dependency-security.yml")]) {
        const caller = workflow.match(/^ {4}security:\n([\s\S]*?)(?=^ {4}\w+:|$(?![\s\S]))/m)?.[1];
        assert.ok(caller?.includes("uses: ./.github/workflows/security-scan.yml"));
        assert.ok(!caller.includes("secrets:"));
    }
    assert.ok(!/\$\{\{[^}]*\bsecrets\./.test(reusable)); assert.ok(!reusable.includes("npm ci"));
    assert.ok(reusable.includes("github.event.pull_request.head.sha || github.sha"));
    assert.ok(reusable.includes("if: always()")); assert.ok(reusable.includes("security-report/raw/"));
});

test("scanner orchestration keeps raw evidence and separates scanner failure, policy block and reported-only", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mt-security-policy-"));
    try {
        const bin = path.join(temporary, "bin"); fs.mkdirSync(bin);
        for (const args of [["--unknown"], ["--out"], ["--out", "--native-only"], ["--native-only", "--native-only"], ["--out", path.join(temporary, "unused"), "--out", path.join(temporary, "unused-again")]]) {
            const result = spawnSync(process.execPath, ["scripts/security/scan.mjs", ...args], { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
            assert.equal(result.status, 2); assert.ok(result.stderr.includes("Usage:"));
        }
        assert.ok(!fs.existsSync(path.join(temporary, "unused")));
        // Own disposable fake tool executables exercise the real orchestrator without downloads or cache writes.
        const tool = `#!/usr/bin/env node
const fs=require("node:fs"),path=require("node:path");
const name=path.basename(process.argv[1]),args=process.argv.slice(2);
if(name==="go"){
 if(args[0]==="env") console.log(JSON.stringify({GOVERSION:"go1.26.9",GOHOSTOS:"linux",GOHOSTARCH:"amd64"}));
 else if(args[0]==="install"){fs.copyFileSync(process.argv[1],path.join(process.env.GOBIN,"govulncheck"));fs.chmodSync(path.join(process.env.GOBIN,"govulncheck"),0o755);}
 else process.exit(2);
} else if(name==="npm"){
 if(args[0]==="--version")console.log("10.9.2");
 else {console.log(fs.readFileSync(process.env.MT_SECURITY_NPM_FIXTURE,"utf8"));process.exit(Number(process.env.MT_SECURITY_NPM_EXIT));}
} else console.log(fs.readFileSync(process.env.MT_SECURITY_GO_FIXTURE,"utf8"));
`;
        for (const name of ["go", "npm"]) fs.writeFileSync(path.join(bin, name), tool, { mode: 0o755 });
        const goFile = path.join(temporary, "go.json"); const npmFile = path.join(temporary, "npm.json");
        fs.writeFileSync(goFile, stream(records().slice(0, 2)));
        const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
        const vulnerable = audit("electron");
        for (const [index, raw, exit, expected, status] of [[0, "{incomplete", 1, 2, "scanner-input-failure"], [1, JSON.stringify(vulnerable), 1, 1, "blocked-policy"], [2, JSON.stringify(clean), 0, 0, "reported-only"]]) {
            fs.writeFileSync(npmFile, raw);
            const out = path.join(temporary, `report-${index}`);
            const result = spawnSync(process.execPath, ["scripts/security/scan.mjs", "--out", out], { cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, MT_SECURITY_GO_FIXTURE: goFile, MT_SECURITY_NPM_FIXTURE: npmFile, MT_SECURITY_NPM_EXIT: String(exit) } });
            assert.equal(result.status, expected, result.stderr + result.stdout);
            const report = JSON.parse(fs.readFileSync(path.join(out, "report.json")));
            assert.equal(report.status, status); assert.equal(report.coverage.length, 18);
            assert.equal(fs.readFileSync(path.join(out, "raw", "npm-audit.json"), "utf8").trim(), raw);
            assert.ok(fs.readFileSync(path.join(out, "report.md"), "utf8").includes(status));
            assert.ok(JSON.parse(fs.readFileSync(path.join(out, "manifest.json"))).runs.every((run) => run.finishedAt));
            const existing = spawnSync(process.execPath, ["scripts/security/scan.mjs", "--out", out], { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
            assert.equal(existing.status, 2); assert.ok(existing.stderr.includes("existing report directory"));
        }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
