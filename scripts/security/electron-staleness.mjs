#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The online half of the Electron update policy (security/ELECTRON.md, #1983). The offline `electronLifecycle` check
// of the scanner catches an overdue human review; this one reads what upstream published since: Electron's release
// feed and its GitHub security advisories. It raises four findings about the pinned version:
//   newer-release    a newer release of the same major has been out for more than --max-age-days (7)
//   advisory         a published Electron advisory whose vulnerable range holds the pin
//   end-of-support   the reviewed end of support of the major is within 30 days, or past
//   unsupported-line the major is not among the latest three stable ones
// A finding is cleared by a bump, or by a human-reviewed, dated exception in security/dependencies.json.
//
// Usage: node scripts/security/electron-staleness.mjs [--enforce] [--issue] [--json] [--max-age-days N]
//          [--repo owner/name] [--root dir] [--feed file] [--advisories file] [--now ISO]
//   --enforce  exit 1 when a finding is not excepted (the release workflow)
//   --issue    open, update or close the one `security` issue (the daily workflow); needs gh, GH_TOKEN, --repo or
//              GITHUB_REPOSITORY
// Exit codes: 0 report, 1 findings under --enforce, 2 input failure. A failed read is never "current".

/* global process, console, fetch, AbortSignal, setTimeout, URL */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FeedUrl = "https://releases.electronjs.org/releases.json";
export const AdvisoriesUrl = "https://api.github.com/repos/electron/electron/security-advisories";
export const IssueTitle = "Electron engine update overdue";
export const IssueLabel = "security";
export const FlagCodes = ["newer-release", "advisory", "end-of-support", "unsupported-line"];
export const DefaultMaxAgeDays = 7;
export const EndOfSupportDays = 30;
export const SupportedMajors = 3;
export const ExceptionMaxDays = 90;

const DayMs = 86400_000;
const AdvisoryDeadlineDays = { critical: 3, high: 7 };
const OtherAdvisoryDeadlineDays = 30;
const MaxAgeDaysLimit = 30;
const StableVersion = /^\d+\.\d+\.\d+$/;
const VersionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const IssueMarker = /<!-- electron-staleness:([0-9a-f]+) -->/;
const RepoPattern = /^[\w.-]+\/[\w.-]+$/;

export class StalenessInputError extends Error {}
const fail = (message) => {
    throw new StalenessInputError(message);
};
const text = (value) => typeof value === "string" && value.trim().length > 0;
const day = (stamp) => new Date(stamp).toISOString().slice(0, 10);

// `lenient` pads "12" and "12.1" the way advisory ranges sometimes write them.
export function parseVersion(value, lenient = false) {
    let source = String(value ?? "").trim();
    if (lenient && /^\d+(\.\d+)?$/.test(source)) {
        source = `${source}${".0".repeat(3 - source.split(".").length)}`;
    }
    const match = VersionPattern.exec(source);
    if (!match) {
        fail(`Not an Electron version: ${value}`);
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        pre: match[4] ? match[4].split(".") : [],
    };
}

export function compareVersions(a, b, lenient = false) {
    const x = parseVersion(a, lenient);
    const y = parseVersion(b, lenient);
    for (const key of ["major", "minor", "patch"]) {
        if (x[key] !== y[key]) {
            return x[key] < y[key] ? -1 : 1;
        }
    }
    if (!x.pre.length || !y.pre.length) {
        return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    }
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i];
        const q = y.pre[i];
        if (p === undefined || q === undefined) {
            return p === undefined ? -1 : 1;
        }
        if (p === q) {
            continue;
        }
        const numeric = [/^\d+$/.test(p), /^\d+$/.test(q)];
        if (numeric[0] && numeric[1]) {
            return Number(p) < Number(q) ? -1 : 1;
        }
        if (numeric[0] !== numeric[1]) {
            return numeric[0] ? -1 : 1;
        }
        return p < q ? -1 : 1;
    }
    return 0;
}

const ClausePattern = /(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/g;

// GitHub writes a vulnerable range as alternatives joined by "||", each a run of clauses separated by commas or spaces:
// ">= 45.0.0-alpha.1, < 45.0.0-beta.6" or "< 35.7.5 || >= 36.0.0-alpha.1 < 36.8.1". Anything else fails the run.
export function inRange(version, range) {
    const alternatives = String(range ?? "")
        .split("||")
        .map((alternative) => alternative.trim().replace(/([<>])\s+=/g, "$1="));
    if (alternatives.some((alternative) => !alternative)) {
        fail("An advisory has an empty vulnerable range");
    }
    return alternatives.some((alternative) => {
        const clauses = [...alternative.matchAll(ClausePattern)];
        if (!clauses.length || alternative.replace(ClausePattern, "").replace(/[\s,]/g, "")) {
            fail(`Unrecognised advisory range: ${range}`);
        }
        return clauses.every(([, operator, bound]) => {
            const order = compareVersions(version, bound, true);
            switch (operator ?? "=") {
                case ">=":
                    return order >= 0;
                case ">":
                    return order > 0;
                case "<=":
                    return order <= 0;
                case "<":
                    return order < 0;
                default:
                    return order === 0;
            }
        });
    });
}

export function parseFeed(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
        fail("The release feed is not a list of releases");
    }
    const releases = [];
    for (const entry of raw) {
        if (typeof entry?.version !== "string" || !StableVersion.test(entry.version)) {
            continue;
        }
        const at = Date.parse(entry.fullDate ?? `${entry.date}T00:00:00Z`);
        if (!Number.isFinite(at)) {
            fail(`Release ${entry.version} has no valid date`);
        }
        releases.push({ version: entry.version, at, chromium: typeof entry.chrome === "string" ? entry.chrome : "" });
    }
    if (!releases.length) {
        fail("The release feed holds no stable release");
    }
    return releases;
}

export function parseAdvisories(raw) {
    if (!Array.isArray(raw)) {
        fail("The advisory list is not a list");
    }
    const advisories = [];
    for (const item of raw) {
        if (!text(item?.ghsa_id)) {
            fail("An advisory has no identifier");
        }
        if (item.withdrawn_at || (item.state && item.state !== "published")) {
            continue;
        }
        const ranges = (Array.isArray(item.vulnerabilities) ? item.vulnerabilities : [])
            .filter((entry) => entry?.package?.name === "electron" && (entry.package.ecosystem ?? "npm") === "npm")
            .map((entry) => ({
                range: String(entry.vulnerable_version_range ?? ""),
                patched: String(entry.patched_versions ?? ""),
            }));
        if (!ranges.length) {
            continue;
        }
        advisories.push({
            id: item.ghsa_id,
            severity: String(item.severity ?? "unknown").toLowerCase(),
            summary: String(item.summary ?? ""),
            url: String(item.html_url ?? `https://github.com/advisories/${item.ghsa_id}`),
            publishedAt: Date.parse(item.published_at ?? ""),
            ranges,
        });
    }
    return advisories;
}

// Same rules as the scanner's exceptions (scripts/security/policy.mjs, validateAssessment): a human reviewer, a GitHub
// approval link, a control, exact scopes (no wildcard), exact UTC timestamps and at most 90 days. Malformed fails the run.
export function validateExceptions(exceptions, now) {
    if (!Array.isArray(exceptions)) {
        fail("electronExceptions must be a list");
    }
    const seen = new Set();
    for (const entry of exceptions) {
        const scoped = ["code", "id", "version"].every((field) => text(entry?.[field]));
        if (!scoped || !FlagCodes.includes(entry.code) || !StableVersion.test(entry.version)) {
            fail("Malformed Electron exception scope");
        }
        if ([entry.id, entry.version].some((value) => /[*?]/.test(value))) {
            fail("Electron exceptions cannot use wildcard scopes");
        }
        if (!["reason", "owner", "control"].every((field) => text(entry[field]))) {
            fail("An Electron exception needs a reason, an owner and a control");
        }
        if (
            !text(entry.reviewedBy) ||
            /^(ai|codex|claude|agent)$/i.test(entry.reviewedBy) ||
            !/^https:\/\/github\.com\//.test(entry.approval ?? "")
        ) {
            fail("An Electron exception requires an explicit human approval reference");
        }
        const stamps = [entry.createdAt, entry.expiresAt];
        for (const stamp of stamps) {
            if (
                typeof stamp !== "string" ||
                !/^\d{4}-\d\d-\d\dT.*Z$/.test(stamp) ||
                !Number.isFinite(Date.parse(stamp))
            ) {
                fail("Electron exception timestamps must be valid ISO UTC dates");
            }
            if (new Date(stamp).toISOString().replace(".000Z", "Z") !== stamp.replace(".000Z", "Z")) {
                fail("Electron exception timestamps must be exact valid ISO UTC dates");
            }
        }
        const [created, expires] = stamps.map(Date.parse);
        if (expires <= created || expires - created > ExceptionMaxDays * DayMs) {
            fail("Electron exception expiry must be a valid bounded UTC interval");
        }
        if (created > now.getTime()) {
            fail("An Electron exception cannot be created in the future");
        }
        const key = `${entry.code}:${entry.id}:${entry.version}`;
        if (seen.has(key)) {
            fail(`Ambiguous Electron exception for ${key}`);
        }
        seen.add(key);
    }
    return exceptions;
}

const PatchedPattern = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

function fixRelease(patched, releases) {
    const version = patched.match(PatchedPattern)?.[0];
    return { version, release: releases.find((release) => release.version === version) };
}

// GitHub lists a patched version per branch, and sometimes an open-ended range for a branch it did not patch (GHSA-vv43,
// ">= 40.0.0-alpha.1" with no fix, while its text lists 42.0.0-beta.2 as fixed). A fix lands on the main branch first, so a
// version at or above the highest patched version already holds it: only a range with no fix at all stays open.
function affects(advisory, pinned) {
    const hit = advisory.ranges.find((entry) => inRange(pinned, entry.range));
    if (!hit) {
        return null;
    }
    const patched = advisory.ranges
        .flatMap((entry) => entry.patched.match(PatchedPattern) ?? [])
        .sort((a, b) => compareVersions(a, b));
    return patched.length && compareVersions(pinned, patched[patched.length - 1]) >= 0 ? null : hit;
}

export function evaluate({
    pinned,
    feed,
    advisories,
    lifecycle,
    exceptions = [],
    now,
    maxAgeDays = DefaultMaxAgeDays,
}) {
    const pin = parseVersion(pinned);
    if (pin.pre.length) {
        fail(`Electron must be pinned to a stable version, not ${pinned}`);
    }
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        fail("A valid current time is required");
    }
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > MaxAgeDaysLimit) {
        fail(`--max-age-days must be a whole number from 1 to ${MaxAgeDaysLimit}`);
    }
    if (!/^\d{4}-\d\d-\d\d$/.test(lifecycle?.tentativeEndOfSupport ?? "") || lifecycle.version !== pinned) {
        fail("The Electron lifecycle review does not describe the pinned version");
    }
    const end = Date.parse(`${lifecycle.tentativeEndOfSupport}T00:00:00Z`);
    if (!Number.isFinite(end) || day(end) !== lifecycle.tentativeEndOfSupport) {
        fail("Invalid Electron end of support date");
    }
    validateExceptions(exceptions, now);
    const nowMs = now.getTime();
    const current = feed.find((release) => release.version === pinned);
    if (!current) {
        fail(`Electron ${pinned} is not in the release feed`);
    }
    const found = [];
    const pending = [];

    const newer = feed
        .filter(
            (release) =>
                parseVersion(release.version).major === pin.major && compareVersions(release.version, pinned) > 0
        )
        .sort((a, b) => compareVersions(a.version, b.version));
    if (newer.length) {
        const first = newer[0];
        const latest = newer[newer.length - 1];
        const item = {
            code: "newer-release",
            id: latest.version,
            title: `Electron ${latest.version} is out (Chromium ${latest.chromium || "unknown"})`,
            detail: `${first.version}, the first release after the pin, came out on ${day(first.at)}${newer.length > 1 ? `; ${newer.length} releases of ${pin.major}.x are newer` : ""}`,
            dueBy: first.at + maxAgeDays * DayMs,
        };
        (nowMs > item.dueBy ? found : pending).push(item);
    }

    for (const advisory of advisories) {
        const hit = affects(advisory, pinned);
        if (!hit) {
            continue;
        }
        const { version: fixedIn, release } = fixRelease(hit.patched, feed);
        const days = AdvisoryDeadlineDays[advisory.severity] ?? OtherAdvisoryDeadlineDays;
        const from = release?.at ?? advisory.publishedAt;
        found.push({
            code: "advisory",
            id: advisory.id,
            title: `${advisory.id} (${advisory.severity}) affects ${pinned}`,
            detail: `${advisory.summary || "No summary"}; fixed in ${fixedIn ?? "no release yet"}; ${advisory.url}`,
            dueBy: Number.isFinite(from) ? from + days * DayMs : null,
        });
    }

    if (end - nowMs <= EndOfSupportDays * DayMs) {
        found.push({
            code: "end-of-support",
            id: String(pin.major),
            title: `Electron ${pin.major} ${end > nowMs ? "ends support" : "ended support"} on ${lifecycle.tentativeEndOfSupport}`,
            detail: "Move to the next stable major at least four weeks before the end of support",
            dueBy: end - EndOfSupportDays * DayMs,
        });
    }

    const supported = [...new Set(feed.map((release) => parseVersion(release.version).major))]
        .sort((a, b) => b - a)
        .slice(0, SupportedMajors);
    if (!supported.includes(pin.major)) {
        found.push({
            code: "unsupported-line",
            id: String(pin.major),
            title: `Electron ${pin.major} is not among the latest ${SupportedMajors} stable majors (${supported.join(", ")})`,
            detail: "Upstream no longer ships security fixes for this major",
            dueBy: null,
        });
    }

    const flags = [];
    const excepted = [];
    for (const flag of found) {
        const matching = exceptions.filter(
            (entry) => entry.code === flag.code && entry.id === flag.id && entry.version === pinned
        );
        const live = matching.find((entry) => Date.parse(entry.expiresAt) > nowMs);
        if (live) {
            excepted.push({ ...flag, exception: live });
        } else {
            flags.push(matching.length ? { ...flag, expiredException: matching[0] } : flag);
        }
    }
    const latest = feed
        .filter((release) => parseVersion(release.version).major === pin.major)
        .sort((a, b) => compareVersions(a.version, b.version))
        .pop();
    return {
        status: flags.length ? "stale" : "current",
        pinned,
        major: pin.major,
        checkedAt: now.toISOString(),
        maxAgeDays,
        chromium: current.chromium,
        latest: { version: latest.version, chromium: latest.chromium, date: day(latest.at) },
        flags,
        excepted,
        pending,
    };
}

const ZeroWidthSpace = String.fromCharCode(0x200b);

// Advisory summaries come from the network and end up in an issue body: no markup, no table break, no mention.
const plain = (value) =>
    String(value)
        .replace(/\p{Cc}/gu, " ")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\|/g, "&#124;")
        .replace(/`/g, "'")
        .replace(/@(?=\w)/g, `@${ZeroWidthSpace}`);

export const reportKey = (report) =>
    createHash("sha256")
        .update(JSON.stringify([report.pinned, ...report.flags.map((flag) => `${flag.code}:${flag.id}`).sort()]))
        .digest("hex")
        .slice(0, 16);

const due = (flag) => (flag.dueBy == null ? "now" : day(flag.dueBy));

export function renderMarkdown(report) {
    const lines = [
        `## Electron engine: ${report.pinned} ${report.status === "current" ? "is current" : "needs an update"}`,
        "",
        `Pinned ${report.pinned} (Chromium ${plain(report.chromium || "unknown")}). Newest ${report.major}.x: ${report.latest.version} (Chromium ${plain(report.latest.chromium || "unknown")}, ${report.latest.date}). Checked ${report.checkedAt}.`,
        "",
    ];
    if (report.flags.length) {
        lines.push("| Finding | Detail | Act by |", "| --- | --- | --- |");
        for (const flag of report.flags) {
            const note = flag.expiredException ? ` (the exception expired ${flag.expiredException.expiresAt})` : "";
            lines.push(`| ${plain(flag.title)}${note} | ${plain(flag.detail)} | ${due(flag)} |`);
        }
        lines.push("");
    }
    if (report.pending.length) {
        lines.push(`Inside the ${report.maxAgeDays}-day window, not yet a finding:`, "");
        for (const flag of report.pending) {
            lines.push(`- ${plain(flag.title)}; ${plain(flag.detail)}; a finding from ${due(flag)}`);
        }
        lines.push("");
    }
    if (report.excepted.length) {
        lines.push("Covered by a reviewed exception in `security/dependencies.json`:", "");
        for (const flag of report.excepted) {
            lines.push(
                `- ${plain(flag.title)}; until ${flag.exception.expiresAt}, reviewed by ${plain(flag.exception.reviewedBy)} (${plain(flag.exception.approval)})`
            );
        }
        lines.push("");
    }
    if (report.flags.length) {
        lines.push(
            "To clear it (`security/ELECTRON.md`):",
            "",
            `1. Read the release notes of every release after ${report.pinned} (https://github.com/electron/electron/releases).`,
            `2. Bump \`electron\` to ${report.latest.version} in \`package.json\` and the lock with npm 10.9.2, and renew \`electronLifecycle\` in \`security/dependencies.json\`.`,
            "3. Requalify a packaged build: `node scripts/moltenterm-qualify-packaged.mjs <packaged app>`, and say what ran in the pull request.",
            "4. When a bump cannot ship in time, record a human-reviewed, dated exception in `electronExceptions` (at most 90 days).",
            "",
            `<!-- electron-staleness:${reportKey(report)} -->`,
            ""
        );
    }
    return lines.join("\n");
}

const defaultRun = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

// One issue, found by its title: opened for findings, edited and commented when they change, closed when none is left.
export function syncIssue(report, markdown, { run = defaultRun, repo } = {}) {
    if (!RepoPattern.test(repo ?? "")) {
        fail("--issue needs --repo owner/name or GITHUB_REPOSITORY");
    }
    const gh = (...args) => run([...args, "--repo", repo]);
    const listed = JSON.parse(
        gh(
            "issue",
            "list",
            "--state",
            "open",
            "--search",
            `"${IssueTitle}" in:title`,
            "--json",
            "number,title,body,labels",
            "--limit",
            "50"
        ) || "[]"
    );
    const issue = listed.filter((entry) => entry.title === IssueTitle).sort((a, b) => a.number - b.number)[0];
    if (!report.flags.length) {
        if (!issue) {
            return "none";
        }
        gh(
            "issue",
            "comment",
            String(issue.number),
            "--body",
            `Electron ${report.pinned} is current again as of ${report.checkedAt}: no finding is left. Closing.`
        );
        gh("issue", "close", String(issue.number), "--reason", "completed");
        return "closed";
    }
    const names = JSON.parse(
        gh("label", "list", "--search", IssueLabel, "--json", "name", "--limit", "100") || "[]"
    ).map((label) => label.name);
    if (!names.includes(IssueLabel)) {
        gh("label", "create", IssueLabel, "--description", "Security finding", "--color", "B60205");
    }
    if (!issue) {
        gh("issue", "create", "--title", IssueTitle, "--label", IssueLabel, "--body", markdown);
        return "created";
    }
    if (!(issue.labels ?? []).some((label) => label.name === IssueLabel)) {
        gh("issue", "edit", String(issue.number), "--add-label", IssueLabel);
    }
    if (IssueMarker.exec(issue.body ?? "")?.[1] === reportKey(report)) {
        return "unchanged";
    }
    gh("issue", "edit", String(issue.number), "--body", markdown);
    gh(
        "issue",
        "comment",
        String(issue.number),
        "--body",
        `The findings changed as of ${report.checkedAt}; the description above is current.`
    );
    return "updated";
}

const FetchAttempts = 3;

async function fetchPage(url, headers, retryDelayMs) {
    let last;
    for (let attempt = 1; attempt <= FetchAttempts; attempt++) {
        try {
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return { body: await response.json(), link: response.headers?.get("link") ?? "" };
        } catch (error) {
            last = error;
            if (attempt < FetchAttempts) {
                await new Promise((resolve) => setTimeout(resolve, attempt * retryDelayMs));
            }
        }
    }
    return fail(`Could not read ${url}: ${last?.message}`);
}

const fetchJson = async (url, headers, retryDelayMs) => (await fetchPage(url, headers, retryDelayMs)).body;

// GitHub answers this list with a cursor in the Link header, naming the repository by its id
// (https://api.github.com/repositories/9384267/security-advisories?per_page=100&after=...); a page number is ignored
// and would repeat the first page. The token follows the link only to GitHub's own advisory endpoint.
function isAdvisoriesLink(link) {
    try {
        const url = new URL(link);
        return url.origin === "https://api.github.com" && url.pathname.endsWith("/security-advisories");
    } catch {
        return false;
    }
}

async function readAdvisories(headers, retryDelayMs) {
    const all = [];
    let url = `${AdvisoriesUrl}?per_page=100`;
    for (let page = 1; page <= 20; page++) {
        const { body, link } = await fetchPage(url, headers, retryDelayMs);
        if (!Array.isArray(body)) {
            fail("The advisory list is not a list");
        }
        all.push(...body);
        const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
        if (!next) {
            return all;
        }
        if (!isAdvisoriesLink(next)) {
            fail(`The advisory list continues at an unexpected address: ${next}`);
        }
        url = next;
    }
    return fail("The advisory list is longer than 20 pages");
}

function readJson(file, what) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        return fail(`Could not read ${what} (${file}): ${error.message}`);
    }
}

export function readPin(root) {
    const manifest = readJson(path.join(root, "package.json"), "package.json");
    const lock = readJson(path.join(root, "package-lock.json"), "package-lock.json");
    const policy = readJson(path.join(root, "security/dependencies.json"), "security/dependencies.json");
    const pinned = manifest?.devDependencies?.electron;
    if (!StableVersion.test(pinned ?? "")) {
        fail("package.json must pin Electron to an exact stable version");
    }
    if (
        lock?.packages?.[""]?.devDependencies?.electron !== pinned ||
        lock?.packages?.["node_modules/electron"]?.version !== pinned
    ) {
        fail("package-lock.json does not lock the Electron version package.json pins");
    }
    return { pinned, lifecycle: policy.electronLifecycle, exceptions: policy.electronExceptions ?? [] };
}

const Flags = { "--enforce": "enforce", "--issue": "issue", "--json": "json" };
const Values = {
    "--max-age-days": "maxAgeDays",
    "--repo": "repo",
    "--root": "root",
    "--feed": "feed",
    "--advisories": "advisories",
    "--now": "now",
};

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (Flags[arg]) {
            options[Flags[arg]] = true;
        } else if (Values[arg]) {
            if (argv[i + 1] == null || argv[i + 1].startsWith("--") || options[Values[arg]] !== undefined) {
                fail(`${arg} needs one value`);
            }
            options[Values[arg]] = argv[++i];
        } else {
            fail(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

export async function main(
    argv,
    env = process.env,
    { run = defaultRun, out = (line) => console.log(line), retryDelayMs = 2000 } = {}
) {
    try {
        const options = parseArgs(argv);
        const root = path.resolve(options.root ?? fileURLToPath(new URL("../../", import.meta.url)));
        const now = new Date(options.now ?? Date.now());
        const maxAgeDays = options.maxAgeDays == null ? DefaultMaxAgeDays : Number(options.maxAgeDays);
        const { pinned, lifecycle, exceptions } = readPin(root);
        const token = env.GH_TOKEN || env.GITHUB_TOKEN;
        const headers = {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
        const feed = parseFeed(
            options.feed
                ? readJson(options.feed, "the release feed")
                : await fetchJson(FeedUrl, { Accept: "application/json" }, retryDelayMs)
        );
        const advisories = parseAdvisories(
            options.advisories
                ? readJson(options.advisories, "the advisories")
                : await readAdvisories(headers, retryDelayMs)
        );
        const report = evaluate({ pinned, feed, advisories, lifecycle, exceptions, now, maxAgeDays });
        const markdown = renderMarkdown(report);
        out(options.json ? JSON.stringify(report, null, 2) : markdown);
        if (env.GITHUB_STEP_SUMMARY) {
            fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
        }
        if (options.issue) {
            const result = syncIssue(report, markdown, { run, repo: options.repo ?? env.GITHUB_REPOSITORY });
            out(`Issue "${IssueTitle}": ${result}`);
        }
        if (options.enforce && report.flags.length) {
            for (const flag of report.flags) {
                out(`::error title=Electron engine::${plain(flag.title)}`);
            }
            return 1;
        }
        return 0;
    } catch (error) {
        // A failed gh call or an unexpected error is an input failure too: neither may read as "current".
        console.error(
            `electron-staleness: ${error instanceof StalenessInputError ? error.message : (error?.stack ?? error)}`
        );
        return 2;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main(process.argv.slice(2));
}
