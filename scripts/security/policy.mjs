// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

export class ScanInputError extends Error {}
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const surfaces = ["shipped-runtime", "developer-build-install", "docs-only", "needs-review"];
const severities = ["critical", "high", "moderate", "low", "info", "unknown"];
const fail = (message) => { throw new ScanInputError(message); };
export const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validatePolicy(policy) {
    if (!object(policy) || policy.schema !== 1 || !text(policy.owner)) fail("Unsupported or malformed security policy");
    if (!/^\d+\.\d+\.\d+$/.test(policy.scanners?.npm) || !/^v\d+\.\d+\.\d+$/.test(policy.scanners?.govulncheck)) fail("Scanner versions must be exact");
    if (!Array.isArray(policy.blockingSeverities) || policy.blockingSeverities.join(",") !== "critical,high") fail("High/critical severity policy is required");
    if (!Array.isArray(policy.additionalRuntimeNpmRoots) || !policy.additionalRuntimeNpmRoots.includes("electron")) fail("Electron runtime classification is required");
    if (!object(policy.npmWorkspaces) || Object.values(policy.npmWorkspaces).some((s) => !surfaces.includes(s) || s === "needs-review")) fail("Workspace surfaces must be explicit");
    if (!Array.isArray(policy.goModules) || !policy.goModules.includes(".") || !policy.goModules.includes("tsunami")) fail("Both Go module graphs are required");
    if (!Array.isArray(policy.goTargets) || !policy.goTargets.length || new Set(policy.goTargets.map((t) => t.target)).size !== policy.goTargets.length) fail("Go target coverage must be unique and explicit");
    for (const target of policy.goTargets) {
        if (!/^[a-z0-9]+\/[a-z0-9]+$/.test(target.target) || !Array.isArray(target.packages) || !target.packages.length || target.packages.some((p) => !/^\.\/\w[^\s]*$/.test(p))) fail("Invalid Go target/package scope");
    }
    if (!Array.isArray(policy.nativeGoTargets) || policy.nativeGoTargets.some((t) => !policy.goTargets.some((entry) => entry.target === t))) fail("Invalid native Go target coverage");
    if (!Array.isArray(policy.dispositions) || !Array.isArray(policy.exceptions)) fail("Disposition and exception lists are required");
    return policy;
}

// npm's lock stores all platforms and workspaces. Resolve installed occurrences, never the package's dev flag.
export function npmInventory(lock, policy) {
    if (lock?.lockfileVersion !== 3 || !object(lock.packages) || !object(lock.packages[""])) fail("A complete npm v3 workspace lockfile is required");
    const packages = lock.packages;
    const listed = packages[""].workspaces;
    if (!Array.isArray(listed) || JSON.stringify([...listed].sort()) !== JSON.stringify(Object.keys(policy.npmWorkspaces).sort())) fail("Unclassified or missing npm workspace");
    const dereference = (location) => {
        const seen = new Set();
        while (packages[location]?.link) {
            if (seen.has(location)) fail("Cyclic workspace link");
            seen.add(location);
            location = packages[location].resolved;
        }
        return packages[location] ? location : null;
    };
    const resolve = (from, name) => {
        for (let base = from;; base = path.posix.dirname(base)) {
            const location = path.posix.join(base === "." ? "" : base, "node_modules", name);
            if (packages[location]) return dereference(location);
            if (base === "" || base === ".") return null;
        }
    };
    const inventory = new Map();
    const seen = new Set();
    const walk = (from, surface, trail) => {
        const key = `${from}:${surface}`;
        const entry = inventory.get(from) ?? { surfaces: new Set(), paths: [] };
        entry.surfaces.add(surface);
        if (!seen.has(key)) entry.paths.push(trail);
        inventory.set(from, entry);
        if (seen.has(key)) return;
        seen.add(key);
        const pkg = packages[from];
        const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
        for (const name of Object.keys(dependencies)) {
            const next = resolve(from, name);
            if (next) walk(next, surface, [...trail, next]);
            else if (!pkg.optionalDependencies?.[name] && !pkg.peerDependenciesMeta?.[name]?.optional) fail(`Unresolved locked dependency ${from} -> ${name}`);
        }
    };
    const roots = (location, surface, includeDev = false) => {
        if (!packages[location]) fail(`Missing workspace ${location}`);
        const pkg = packages[location];
        const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies, ...(includeDev ? pkg.devDependencies : {}) };
        for (const name of Object.keys(dependencies)) {
            const next = resolve(location, name);
            if (next) walk(next, surface, [location || "application", next]);
            else if (!pkg.optionalDependencies?.[name]) fail(`Missing locked root ${location} -> ${name}`);
        }
    };
    roots("", "shipped-runtime");
    for (const [name, surface] of Object.entries(policy.npmWorkspaces)) {
        roots(name, surface, surface === "docs-only");
        if (surface !== "docs-only") {
            const pkg = packages[name];
            for (const dependency of Object.keys(pkg.devDependencies ?? {})) {
                const next = resolve(name, dependency);
                if (!next) fail(`Missing workspace development dependency ${dependency}`);
                walk(next, "developer-build-install", [name, next]);
            }
        }
    }
    for (const name of Object.keys(packages[""].devDependencies ?? {})) {
        const next = resolve("", name);
        if (!next) fail(`Missing development dependency ${name}`);
        walk(next, "developer-build-install", ["application tooling", next]);
    }
    // Only the executable is shipped; its npm downloader/extractor remains in the installation graph above.
    for (const name of policy.additionalRuntimeNpmRoots) {
        const location = resolve("", name);
        if (!location) fail(`Missing explicit runtime dependency ${name}`);
        const entry = inventory.get(location) ?? { surfaces: new Set(), paths: [] };
        entry.surfaces.add("shipped-runtime");
        entry.paths.push(["explicit shipped runtime", location]);
        inventory.set(location, entry);
    }
    return new Map([...inventory].map(([location, entry]) => [location, {
        surface: surfaces.find((surface) => entry.surfaces.has(surface)), paths: entry.paths,
    }]));
}

export function normalizeNpm(raw, exitCode, lock, policy) {
    let audit;
    try { audit = JSON.parse(raw); } catch { fail("npm audit returned malformed JSON"); }
    if (![0, 1].includes(exitCode) || audit.error || audit.auditReportVersion !== 2 || !object(audit.vulnerabilities) || !object(audit.metadata?.vulnerabilities)) fail("npm audit did not successfully retrieve a complete v2 report");
    const inventory = npmInventory(lock, policy);
    const findings = [];
    const parents = [];
    for (const [name, entry] of Object.entries(audit.vulnerabilities)) {
        if (!Array.isArray(entry.nodes) || !entry.nodes.length || !Array.isArray(entry.via) || !entry.via.length) fail(`Incomplete npm entry ${name}`);
        parents.push({ package: name, nodes: entry.nodes, severity: entry.severity, via: entry.via, range: entry.range, fixAvailable: entry.fixAvailable });
        for (const via of entry.via) {
            if (typeof via === "string") {
                if (!audit.vulnerabilities[via]) fail(`Missing npm advisory reference ${via}`);
                continue;
            }
            if (!object(via) || !Number.isSafeInteger(via.source) || !/^https:\/\/github.com\/advisories\/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(via.url) || !text(via.range) || !severities.includes(via.severity)) fail(`Unsupported npm advisory ${name}`);
            for (const occurrence of entry.nodes) {
                const pkg = lock.packages[occurrence];
                if (!text(pkg?.version)) fail(`npm advisory names an absent locked occurrence ${occurrence}`);
                const classified = inventory.get(occurrence);
                findings.push({
                    ecosystem: "npm", id: via.url.split("/").at(-1), aliases: [via.url, `npm:${via.source}`],
                    package: name, version: pkg.version, occurrence, target: "npm", reachability: "locked",
                    severity: via.severity, affectedRange: via.range, source: via.url, title: via.title,
                    advisoryFingerprint: fingerprint(via), surface: classified?.surface ?? "needs-review", paths: classified?.paths ?? [],
                });
            }
        }
    }
    // Cycles are legitimate only when each component still explains a validated leaf advisory.
    for (const name of Object.keys(audit.vulnerabilities)) {
        const pending = [name], visited = new Set();
        let explained = false;
        while (pending.length && !explained) {
            const current = pending.pop();
            if (visited.has(current)) continue;
            visited.add(current);
            for (const via of audit.vulnerabilities[current].via) {
                if (typeof via === "string") pending.push(via);
                else explained = true;
            }
        }
        if (!explained) fail(`npm meta-vulnerability ${name} cannot reach a leaf advisory`);
    }
    if (Object.keys(audit.vulnerabilities).length && !findings.length) fail("npm returned entries without any leaf advisories");
    const counts = audit.metadata.vulnerabilities;
    if (!["info", "low", "moderate", "high", "critical", "total"].every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
        counts.total !== Object.keys(audit.vulnerabilities).length ||
        counts.total !== ["info", "low", "moderate", "high", "critical"].reduce((sum, key) => sum + counts[key], 0) ||
        (exitCode === 1 && counts.total === 0)) fail("npm advisory count/exit status is inconsistent");
    return { findings, parents, counts: audit.metadata.vulnerabilities };
}

// govulncheck emits adjacent JSON objects, not a JSON array and not JSONL. Do not drop malformed trailing records.
export function parseGoStream(raw) {
    const records = [];
    let start = -1, depth = 0, quoted = false, escaped = false;
    for (let index = 0; index < raw.length; index++) {
        const char = raw[index];
        if (start < 0) {
            if (/\s/.test(char)) continue;
            if (char !== "{") fail("Unexpected govulncheck stream content");
            start = index;
        }
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}") {
            depth--;
            if (!depth) {
                try { records.push(JSON.parse(raw.slice(start, index + 1))); } catch { fail("Malformed govulncheck record"); }
                start = -1;
            }
        }
    }
    if (start >= 0 || !records.length) fail("Missing or truncated govulncheck stream");
    return records;
}

export function normalizeGo(raw, exitCode, scope, policy, goVersion) {
    if (exitCode !== 0) fail(`govulncheck failed for ${scope.module} ${scope.target}`);
    const records = parseGoStream(raw);
    const configs = records.filter((r) => r.config).map((r) => r.config);
    const sboms = records.filter((r) => r.SBOM).map((r) => r.SBOM);
    if (configs.length !== 1 || sboms.length !== 1 || !Array.isArray(sboms[0].modules) || !sboms[0].modules.length ||
        sboms[0].modules.some((module) => !text(module.path)) || !Array.isArray(sboms[0].roots) || !sboms[0].roots.length || sboms[0].roots.some((root) => !text(root))) fail("Missing govulncheck config/SBOM completeness evidence");
    const config = configs[0];
    if (config.protocol_version !== "v1.0.0" || config.scanner_name !== "govulncheck" || config.scanner_version !== policy.scanners.govulncheck || config.go_version !== goVersion || config.scan_mode !== "source" || config.scan_level !== "symbol" || config.db !== "https://vuln.go.dev" || !Number.isFinite(Date.parse(config.db_last_modified))) fail("Unsupported govulncheck tool/protocol/database configuration");
    if (sboms[0].go_version !== goVersion) fail("Go scan used a different toolchain");
    const advisories = new Map();
    for (const record of records) {
        if (!object(record) || Object.keys(record).length !== 1 || !["config", "SBOM", "osv", "finding", "progress"].includes(Object.keys(record)[0])) fail("Unknown govulncheck protocol record");
        if (record.osv) {
            if (!/^GO-\d{4}-\d+$/.test(record.osv.id) || !Array.isArray(record.osv.affected) || !record.osv.affected.length ||
                record.osv.affected.some((entry) => !text(entry.package?.name) || !Array.isArray(entry.ranges) || !entry.ranges.length)) fail("Invalid Go advisory");
            // The protocol can repeat identical OSV records for packages/modules. Conflicting records cannot be reviewed safely.
            if (advisories.has(record.osv.id) && fingerprint(advisories.get(record.osv.id)) !== fingerprint(record.osv)) fail("Conflicting Go advisory records");
            advisories.set(record.osv.id, record.osv);
        }
    }
    const findings = [];
    for (const { finding } of records.filter((r) => r.finding)) {
        const advisory = advisories.get(finding.osv);
        const trace = finding.trace;
        if (!advisory || !Array.isArray(trace) || !trace.length || !text(trace[0].module) || !text(trace[0].version)) fail("Incomplete Go finding/advisory trace");
        const frame = trace[0];
        const severity = advisory.database_specific?.severity?.toLowerCase();
        findings.push({
            ecosystem: "go", id: advisory.id, aliases: advisory.aliases ?? [], package: frame.module, version: frame.version,
            occurrence: scope.module, target: `${scope.target}/cgo${scope.cgo}`, reachability: frame.function ? "symbol" : frame.package ? "package" : "module",
            severity: severities.includes(severity) ? severity : "unknown", severityVectors: advisory.severity ?? [],
            affectedRange: JSON.stringify(advisory.affected?.map((entry) => ({ package: entry.package?.name, ranges: entry.ranges }))), source: `https://pkg.go.dev/vuln/${advisory.id}`, title: advisory.summary,
            advisoryFingerprint: fingerprint(advisory), surface: "shipped-runtime", trace, fixedVersion: finding.fixed_version ?? "",
        });
    }
    return { findings, config, sbom: sboms[0] };
}

const scopeFields = ["ecosystem", "id", "package", "version", "occurrence", "affectedRange", "surface", "reachability", "severity", "advisoryFingerprint"];
function validateAssessment(entry, exception) {
    if (!object(entry) || scopeFields.some((field) => !text(entry[field])) || !/^[a-f0-9]{64}$/.test(entry.advisoryFingerprint) || !surfaces.includes(entry.surface) || !severities.includes(entry.severity)) fail("Malformed advisory assessment scope");
    if ([entry.id, entry.package, entry.version, entry.occurrence].some((value) => /[*?]/.test(value))) fail("Advisory assessments cannot use wildcard scopes");
    if (!Array.isArray(entry.targets) || !entry.targets.length || entry.targets.some((t) => !text(t) || /[*?]/.test(t)) || new Set(entry.targets).size !== entry.targets.length) fail("Assessment targets must be exact");
    if (!text(entry.owner) || !text(entry.input) || !text(entry.reason) || !Array.isArray(entry.evidence) || !entry.evidence.length || entry.evidence.some((e) => !text(e))) fail("Assessment needs input, evidence, reason and owner");
    if (exception) {
        if (!text(entry.control) || !text(entry.reviewedBy) || /^(ai|codex|claude|agent)$/i.test(entry.reviewedBy) || !/^https:\/\/github.com\//.test(entry.approval)) fail("An exception requires an explicit human approval reference and control");
        if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(entry.createdAt) || !/^\d{4}-\d\d-\d\dT.*Z$/.test(entry.expiresAt) || !Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.expiresAt)) || Date.parse(entry.expiresAt) <= Date.parse(entry.createdAt) || Date.parse(entry.expiresAt) - Date.parse(entry.createdAt) > 90 * 86400_000) fail("Exception expiry must be a valid bounded UTC interval");
        for (const value of [entry.createdAt, entry.expiresAt]) if (new Date(value).toISOString().replace(".000Z", "Z") !== value.replace(".000Z", "Z")) fail("Exception timestamps must be exact valid ISO UTC dates");
    } else if (!["applicable", "not-applicable"].includes(entry.applicability) || !["high", "low"].includes(entry.impact) || !text(entry.action) || !/^\d{4}-\d\d-\d\d$/.test(entry.reviewBy) || !Number.isFinite(Date.parse(`${entry.reviewBy}T00:00:00Z`)) || new Date(`${entry.reviewBy}T00:00:00Z`).toISOString().slice(0, 10) !== entry.reviewBy) fail("Disposition needs applicability, assessed impact, action and review date");
}

export function evaluatePolicy(findings, policy, now = new Date()) {
    validatePolicy(policy);
    policy.dispositions.forEach((entry) => validateAssessment(entry, false));
    policy.exceptions.forEach((entry) => validateAssessment(entry, true));
    const reasons = [];
    for (const entry of policy.dispositions) if (Date.parse(`${entry.reviewBy}T00:00:00Z`) <= now.getTime()) reasons.push(`Disposition review overdue: ${entry.id} ${entry.package}`);
    for (const entry of policy.exceptions) {
        if (Date.parse(entry.expiresAt) <= now.getTime()) reasons.push(`Exception expired: ${entry.id} ${entry.package}`);
        if (Date.parse(entry.createdAt) > now.getTime()) fail("Exception cannot be created in the future");
    }
    const matches = (entry, finding) => scopeFields.every((field) => entry[field] === finding[field]) && entry.targets.includes(finding.target);
    const assessed = findings.map((finding) => {
        const dispositions = policy.dispositions.filter((entry) => matches(entry, finding));
        const exceptions = policy.exceptions.filter((entry) => matches(entry, finding));
        if (dispositions.length > 1 || exceptions.length > 1) fail(`Ambiguous assessment for ${finding.id}`);
        const assessment = dispositions[0];
        const exception = exceptions.find((entry) => Date.parse(entry.expiresAt) > now.getTime());
        let verdict = "reported";
        let reason = assessment?.reason ?? "Finding requires a scoped applicability review";
        const high = policy.blockingSeverities.includes(finding.severity);
        if (!assessment && !exception) verdict = "blocked";
        else if (assessment?.applicability !== "not-applicable" && !exception && (
            assessment?.impact === "high" ||
            (finding.surface === "shipped-runtime" && (high || finding.severity === "unknown")) ||
            finding.surface === "needs-review"
        )) verdict = "blocked";
        if (exception) reason = `Human-reviewed exception until ${exception.expiresAt}: ${exception.reason}`;
        if (verdict === "blocked") reasons.push(`${finding.id} ${finding.package}@${finding.version} ${finding.occurrence} ${finding.target}: ${reason}`);
        return { ...finding, verdict, assessment: assessment ?? null, exception: exception ?? null, reason };
    });
    return { status: reasons.length ? "blocked-policy" : "reported-only", exitCode: reasons.length ? 1 : 0, reasons, findings: assessed };
}

export function expectedGoScopes(policy, hostTarget, nativeOnly = false) {
    const native = policy.nativeGoTargets.includes(hostTarget);
    if (!native) fail(`No reviewed native source-scan configuration for ${hostTarget}`);
    const targets = nativeOnly ? [] : policy.goTargets.map((target) => ({ ...target, cgo: 0 }));
    targets.push({ ...policy.goTargets.find((target) => target.target === hostTarget), cgo: 1 });
    return policy.goModules.flatMap((module) => targets.map((target) => ({
        module, target: target.target, cgo: target.cgo, buildTags: [], packages: module === "." ? target.packages : ["./..."],
    })));
}

export function assertCoverage(actual, expected) {
    const key = (entry) => JSON.stringify([entry.module, entry.target, entry.cgo, entry.packages]);
    const entries = actual.map(key).sort();
    if (new Set(entries).size !== entries.length || JSON.stringify(entries) !== JSON.stringify(expected.map(key).sort())) fail("Missing, duplicated or changed Go module/target/package coverage");
}

export function markdownReport(report) {
    const escape = (value) => String(value ?? "").replace(/[&<>|`\r\n]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "&#124;", "`": "&#96;", "\r": " ", "\n": " " })[char]);
    const lines = ["# Dependency security", "", `Result: **${escape(report.status)}**`, "", `Commit: ${escape(report.commit)}; mode: ${escape(report.mode)}; retrieved: ${escape(report.finishedAt)}`, "", "Raw output, tool versions, complete coverage and original traces are included in the JSON/artifact.", "Cross-target Go scans use CGO=0; the runner's native supplemental scans use CGO=1. Native libraries and Chromium need separate advisory tracking.", ""];
    if (report.error) lines.push(`Scanner/policy input failure: ${escape(report.error)}`, "");
    for (const reason of report.reasons ?? []) lines.push(`- ${escape(reason)}`);
    lines.push("", `Normalized occurrences: ${report.findings?.length ?? 0}; npm vulnerable package entries: ${report.npmCounts?.total ?? "not scanned"}. These are not unique exploitable defects.`, "", "| Advisory | Package/version | Occurrence/target | Surface | Verdict |", "| --- | --- | --- | --- | --- |");
    for (const finding of report.findings ?? []) lines.push(`| ${escape(finding.id)} | ${escape(finding.package)}@${escape(finding.version)} | ${escape(finding.occurrence)} / ${escape(finding.target)} | ${escape(finding.surface)} | ${escape(finding.verdict)} |`);
    return lines.join("\n") + "\n";
}
