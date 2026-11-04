#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Checks that every author of a pull request has signed the CLA (CLA.md, #1870). The signatures are entries of
// .github/cla/cla.json: { "login", "name", "date", "version" }. It needs no secret and no setting outside the
// repository: the workflow (.github/workflows/cla.yml) runs it with the job's own read-only token.
//
// Trust: the list of maintainers (`exempt`) and the signatures already merged are read from the checkout, which the
// workflow makes from the base branch, never from the pull request. The only thing read from the pull request is the
// entry its own author adds to sign, taken through the API as data, and only when its login is the author's.
//
// Usage: node scripts/moltenterm-check-cla.mjs <pull request number>
//   env: GITHUB_REPOSITORY (owner/name); GH_TOKEN for `gh`
//   exit code 1 when someone has not signed, 2 when the check cannot run

/* global console, process */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ConfigPath = ".github/cla/cla.json";

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function isBot(login, type) {
    return type === "Bot" || (typeof login === "string" && login.endsWith("[bot]"));
}

export function validSignature(entry, config) {
    return entry != null && typeof entry.login === "string" && entry.login !== "" && entry.version === config.version;
}

export function parseConfig(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (parsed == null || typeof parsed !== "object" || typeof parsed.version !== "string") {
        return null;
    }
    return {
        version: parsed.version,
        exempt: Array.isArray(parsed.exempt) ? parsed.exempt.filter((l) => typeof l === "string") : [],
        signatures: Array.isArray(parsed.signatures) ? parsed.signatures : [],
    };
}

// Pure core. `config` comes from the base branch; `headConfig` from the pull request (or null); `commits` lists
// { sha, login, type, email } from the API (`login` is null when the author's email is linked to no account).
export function evaluateCla({ config, headConfig, prAuthor, commits }) {
    const baseSigned = new Set(config.signatures.filter((s) => validSignature(s, config)).map((s) => s.login.toLowerCase()));
    const signingNow =
        headConfig != null && headConfig.signatures.some((s) => validSignature(s, config) && same(s.login, prAuthor));

    const authors = new Map();
    authors.set(prAuthor.toLowerCase(), { login: prAuthor, type: null });
    const unlinked = [];
    for (const c of commits) {
        if (c.login == null) {
            unlinked.push({ sha: c.sha.slice(0, 7), email: c.email ?? "unknown" });
            continue;
        }
        authors.set(c.login.toLowerCase(), { login: c.login, type: c.type });
    }

    const ok = [];
    const missing = [];
    for (const [key, author] of authors) {
        if (isBot(author.login, author.type)) {
            ok.push({ login: author.login, how: "bot" });
        } else if (config.exempt.some((l) => same(l, author.login))) {
            ok.push({ login: author.login, how: "maintainer" });
        } else if (baseSigned.has(key)) {
            ok.push({ login: author.login, how: "signed" });
        } else if (same(author.login, prAuthor) && signingNow) {
            ok.push({ login: author.login, how: "signing in this pull request" });
        } else {
            missing.push(author.login);
        }
    }
    return { ok, missing, unlinked, pass: missing.length === 0 && unlinked.length === 0 };
}

function gh(args) {
    return execFileSync("gh", args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
    });
}

function fail(message) {
    console.error(`cla: ${message}`);
    process.exit(2);
}

function fetchPullRequest(repo, number) {
    const pr = JSON.parse(gh(["api", `repos/${repo}/pulls/${number}`]));
    const commits = gh(["api", "--paginate", `repos/${repo}/pulls/${number}/commits`, "--jq", ".[] | @json"])
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .map((c) => ({ sha: c.sha, login: c.author?.login ?? null, type: c.author?.type ?? null, email: c.commit?.author?.email }));
    let headConfig = null;
    try {
        const text = gh([
            "api",
            "-H",
            "Accept: application/vnd.github.raw+json",
            `repos/${pr.head.repo.full_name}/contents/${ConfigPath}?ref=${pr.head.sha}`,
        ]);
        headConfig = parseConfig(text);
    } catch {
        headConfig = null;
    }
    return { prAuthor: pr.user.login, commits, headConfig };
}

function main() {
    const number = Number(process.argv[2]);
    const repo = process.env.GITHUB_REPOSITORY;
    if (!Number.isInteger(number) || number <= 0 || !repo) {
        fail("usage: GITHUB_REPOSITORY=owner/name node scripts/moltenterm-check-cla.mjs <pull request number>");
    }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const config = parseConfig(fs.readFileSync(path.join(root, ConfigPath), "utf8"));
    if (config == null) {
        fail(`${ConfigPath} is missing or is not valid`);
    }
    let pr;
    try {
        pr = fetchPullRequest(repo, number);
    } catch (e) {
        fail(`cannot read pull request #${number} of ${repo}: ${e.message}`);
    }
    const result = evaluateCla({ config, ...pr });
    for (const o of result.ok) {
        console.log(`cla: ${o.login}: ${o.how}`);
    }
    for (const login of result.missing) {
        const message = `${login} has not signed the CLA (CLA.md ${config.version}). Add an entry to ${ConfigPath} in a pull request opened by ${login}; see CONTRIBUTING.md.`;
        console.log(`cla: ${message}`);
        if (process.env.GITHUB_ACTIONS === "true") {
            console.log(`::error file=${ConfigPath}::${message}`);
        }
    }
    for (const u of result.unlinked) {
        const message = `commit ${u.sha} is authored by ${u.email}, which is linked to no GitHub account: add that email to your account, or amend the commit.`;
        console.log(`cla: ${message}`);
        if (process.env.GITHUB_ACTIONS === "true") {
            console.log(`::error::${message}`);
        }
    }
    if (result.pass) {
        console.log("cla: every author has signed");
        process.exit(0);
    }
    process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
