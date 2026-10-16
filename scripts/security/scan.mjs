// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

/* global console, process, setTimeout, clearTimeout, URL */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoverage, evaluatePolicy, expectedGoScopes, fingerprint, markdownReport, normalizeGo, normalizeNpm, ScanInputError, validatePolicy } from "./policy.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
let nativeOnly = false;
let requestedOut;
let invalidArgs = false;
for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--native-only" && !nativeOnly) nativeOnly = true;
    else if (arg === "--out" && requestedOut === undefined && args[index + 1] && !args[index + 1].startsWith("--")) requestedOut = args[++index];
    else invalidArgs = true;
}
if (invalidArgs) {
    console.error("Usage: node scripts/security/scan.mjs [--native-only] [--out NEW_DIRECTORY]");
    process.exit(2);
}
const out = path.resolve(requestedOut ?? path.join(repo, "artifacts", `security-${Date.now()}`));
if (fs.existsSync(out)) {
    console.error("Refusing an existing report directory; use a fresh --out path");
    process.exit(2);
}
fs.mkdirSync(path.join(out, "raw"), { recursive: true });
const report = { schema: 1, status: "scanner-input-failure", exitCode: 2, mode: nativeOnly ? "native-go-supplement" : "full", startedAt: new Date().toISOString(), commit: "unknown", tools: { node: process.version }, coverage: [], findings: [], reasons: [] };
const manifest = { schema: 1, startedAt: report.startedAt, mode: report.mode, runs: [] };
const read = (name) => fs.readFileSync(path.join(out, "raw", name), "utf8");
const json = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + "\n");
let interrupted;
const active = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    interrupted = signal;
    for (const cancel of active) cancel(`scan cancelled by ${signal}`);
});

async function run(name, command, argv, env = {}, timeout = 10 * 60_000) {
    if (interrupted) throw new ScanInputError(`Scan cancelled by ${interrupted}`);
    const stdout = `${name}.json`;
    const stderr = `${name}.stderr`;
    const descriptors = ["ignore", fs.openSync(path.join(out, "raw", stdout), "wx"), fs.openSync(path.join(out, "raw", stderr), "wx")];
    const entry = { name, command, argv, stdout: `raw/${stdout}`, stderr: `raw/${stderr}`, startedAt: new Date().toISOString() };
    manifest.runs.push(entry);
    const result = await new Promise((resolve) => {
        let finished = false;
        let hardKill;
        const child = spawn(command, argv, { cwd: repo, env: { ...process.env, ...env }, stdio: descriptors, detached: true });
        const kill = (signal) => {
            try { process.kill(-child.pid, signal); } catch { /* the owned process group already exited */ }
        };
        const cancel = (reason) => {
            if (entry.error) return;
            entry.error = reason;
            kill("SIGTERM");
            hardKill = setTimeout(() => kill("SIGKILL"), 1000);
        };
        active.add(cancel);
        const timer = setTimeout(() => cancel("scanner timed out"), timeout);
        const done = (code, signal, error) => {
            if (finished) return;
            finished = true;
            active.delete(cancel);
            clearTimeout(timer);
            // A timed-out parent may exit before its grandchildren; still kill the owned group after the grace period.
            if (!entry.error) clearTimeout(hardKill);
            fs.closeSync(descriptors[1]);
            fs.closeSync(descriptors[2]);
            if (error) entry.error = error.message;
            entry.exitCode = code;
            entry.signal = signal;
            entry.finishedAt = new Date().toISOString();
            resolve(entry);
        };
        child.once("error", (error) => done(null, null, error));
        child.once("close", (code, signal) => done(code, signal));
    });
    json("manifest.json", manifest);
    return result;
}
const successful = (entry) => {
    if (entry.exitCode !== 0 || entry.signal || entry.error) throw new ScanInputError(`${entry.name} failed: ${entry.error ?? entry.signal ?? entry.exitCode}; see ${entry.stderr}`);
    return read(`${entry.name}.json`).trim();
};

try {
    const policy = validatePolicy(JSON.parse(fs.readFileSync(path.join(repo, "security/dependencies.json"), "utf8")));
    const lock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8"));
    const commit = await run("commit", "git", ["rev-parse", "HEAD"]);
    report.commit = successful(commit);
    report.inputs = Object.fromEntries(["package.json", "package-lock.json", "docs/package.json", "tsunami/frontend/package.json", "go.mod", "go.sum", "tsunami/go.mod", "tsunami/go.sum", "security/dependencies.json"].map((name) => [name, fingerprint(fs.readFileSync(path.join(repo, name), "utf8"))]));
    const pinned = await run("pinned-go", process.execPath, ["scripts/moltenterm-go-toolchain.mjs"]);
    const goVersion = successful(pinned);
    if (!/^go\d+\.\d+\.\d+$/.test(goVersion)) throw new ScanInputError("The project's exact Go toolchain could not be resolved");
    for (const module of policy.goModules) {
        const goMod = fs.readFileSync(path.join(repo, module, "go.mod"), "utf8");
        if (goMod.match(/^go (\S+)$/m)?.[1] !== goVersion.slice(2)) throw new ScanInputError(`Incoherent Go module pin: ${module}`);
    }
    const goEnv = await run("go-environment", "go", ["env", "-json", "GOVERSION", "GOHOSTOS", "GOHOSTARCH"], { GOTOOLCHAIN: goVersion });
    const host = JSON.parse(successful(goEnv));
    if (host.GOVERSION !== goVersion) throw new ScanInputError("Go resolved a different toolchain");
    const hostTarget = `${host.GOHOSTOS}/${host.GOHOSTARCH}`;
    report.tools.go = goVersion;
    report.nativeHost = hostTarget;
    const scopes = expectedGoScopes(policy, hostTarget, nativeOnly);

    let npmResult;
    if (!nativeOnly) {
        const npmVersion = successful(await run("npm-version", "npm", ["--version"]));
        report.tools.npm = npmVersion;
        if (npmVersion !== policy.scanners.npm) throw new ScanInputError(`npm ${policy.scanners.npm} is required; found ${npmVersion}`);
        console.log("Retrieving full npm workspace audit (development, optional and peer dependencies included)");
        npmResult = await run("npm-audit", "npm", ["audit", "--json", "--ignore-scripts", "--include=dev", "--include=optional", "--include=peer", "--workspaces", "--include-workspace-root=true", "--registry=https://registry.npmjs.org"], {}, 3 * 60_000);
    }

    const tools = path.join(out, "tools");
    fs.mkdirSync(tools);
    successful(await run("govulncheck-install", "go", ["install", `golang.org/x/vuln/cmd/govulncheck@${policy.scanners.govulncheck}`], { GOTOOLCHAIN: goVersion, GOBIN: tools }));
    report.tools.govulncheck = policy.scanners.govulncheck;
    const scans = [];
    for (const scope of scopes) {
        const name = `go-${scope.module === "." ? "root" : scope.module.replaceAll("/", "-")}-${scope.target.replace("/", "-")}-cgo${scope.cgo}`;
        const [GOOS, GOARCH] = scope.target.split("/");
        console.log(`Scanning ${scope.module} for ${scope.target}, CGO=${scope.cgo}`);
        const result = await run(name, path.join(tools, "govulncheck"), ["-C", scope.module, "-json", ...scope.packages], { GOTOOLCHAIN: goVersion, GOVULNDB: "https://vuln.go.dev", GOOS, GOARCH, CGO_ENABLED: String(scope.cgo), GOMAXPROCS: "4", GOFLAGS: "-mod=readonly" });
        scans.push({ ...scope, result });
        report.coverage.push({ ...scope, raw: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
    }
    assertCoverage(scans, scopes);
    const findings = [];
    if (!nativeOnly) {
        if (npmResult.signal || npmResult.error) throw new ScanInputError(`npm audit retrieval failed: ${npmResult.error ?? npmResult.signal}`);
        const normalized = normalizeNpm(read("npm-audit.json"), npmResult.exitCode, lock, policy);
        findings.push(...normalized.findings);
        report.npmCounts = normalized.counts;
        report.npmParents = normalized.parents;
    }
    for (const scope of scans) {
        if (scope.result.signal || scope.result.error) throw new ScanInputError(`Go scan failed: ${scope.result.name}`);
        const normalized = normalizeGo(read(`${scope.result.name}.json`), scope.result.exitCode, scope, policy, goVersion);
        findings.push(...normalized.findings);
        Object.assign(report.coverage.find((entry) => entry.raw === scope.result.stdout), { config: normalized.config, sbom: normalized.sbom });
    }
    Object.assign(report, evaluatePolicy(findings, policy));
} catch (error) {
    report.status = "scanner-input-failure";
    report.exitCode = 2;
    report.error = error.message;
} finally {
    report.finishedAt = new Date().toISOString();
    manifest.finishedAt = report.finishedAt;
    json("manifest.json", manifest);
    json("report.json", report);
    fs.writeFileSync(path.join(out, "report.md"), markdownReport(report));
    console.log(`${report.status}: ${out}/report.md`);
    process.exitCode = report.exitCode;
}
