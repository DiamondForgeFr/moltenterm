#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Refuses a package-lock.json that `npm install` would rewrite (#1877): it would come back modified after each install,
// in every checkout. `npm ci` lets most of this through: a root name, version or licence that differs, a dependency
// removed from a manifest, a range changed but still satisfied. Comparing fields here would miss what only npm can tell
// (an override, a locked version outside its range), so the check asks npm: it settles a throwaway copy of the manifests
// and the lock, offline with an empty cache, and the result must be the lock, byte for byte. A lock in sync needs
// nothing from the registry. No node_modules is read or written and no script of the project runs.
//
// `--committed` reads HEAD instead of the working tree. The local CI needs it: its `ci.prepare` runs `npm install`
// before the jobs, which would heal the very lock this check looks at.
//
// npm's version can change what it writes: CI installs the one `packageManager` names, and a failure under another
// version says so.
//
// Usage: node scripts/moltenterm-check-lockfile.mjs [--committed]   (exit code 1 on drift, 2 when it cannot run)

/* global console, process */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LockFile = "package-lock.json";
export const FixCommand = "npm install --package-lock-only --ignore-scripts";
const MaxShownLines = 20;

export function manifestsOf(manifest) {
    return ["package.json", ...(manifest.workspaces ?? []).map((w) => `${w}/package.json`)];
}

// A lock repeats most of its lines, so a line counts as kept only as many times as the other text has it.
function linesMissingFrom(lines, other) {
    const left = new Map();
    for (const line of other) {
        left.set(line, (left.get(line) ?? 0) + 1);
    }
    return lines.filter((line) => {
        const count = left.get(line) ?? 0;
        left.set(line, count - 1);
        return count <= 0;
    });
}

export function changedLines(before, after) {
    const a = before.split("\n");
    const b = after.split("\n");
    return [
        ...linesMissingFrom(a, b).map((line) => `- ${line.trim()}`),
        ...linesMissingFrom(b, a).map((line) => `+ ${line.trim()}`),
    ];
}

function npmErrors(stderr) {
    return stderr
        .split("\n")
        .filter((line) => line.startsWith("npm error ") && !line.includes("A complete log of this run"))
        .map((line) => line.slice("npm error ".length));
}

// The user's npm configuration stays out: the question is what the project's lock settles to, not what this machine's
// settings (legacy-peer-deps, for one) would make of it.
function settle(dir) {
    const args = ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"];
    const scratch = ["--cache", path.join(dir, ".npm-cache"), "--userconfig", path.join(dir, ".no-user-npmrc")];
    const npm = spawnSync("npm", [...args, ...scratch], { cwd: dir, encoding: "utf8" });
    if (npm.error != null) {
        throw npm.error;
    }
    return npm;
}

// What is wrong with the lock `read(file)` gives: { message, lines }, or null when npm would leave it as it is.
export function lockDrift(read) {
    const lock = read(LockFile);
    const manifests = manifestsOf(JSON.parse(read("package.json")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moltenterm-lockfile-"));
    try {
        for (const file of [...manifests, LockFile]) {
            fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            fs.writeFileSync(path.join(dir, file), read(file));
        }
        const npm = settle(dir);
        if (npm.status !== 0) {
            return {
                message: `npm cannot settle ${LockFile} offline: a manifest asks for what the lock does not hold`,
                lines: npmErrors(npm.stderr),
            };
        }
        const settled = fs.readFileSync(path.join(dir, LockFile), "utf8");
        if (settled === lock) {
            return null;
        }
        return { message: `\`npm install\` would rewrite ${LockFile}`, lines: changedLines(lock, settled) };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

export function npmVersionNote(packageManager, version) {
    if (packageManager == null || packageManager === `npm@${version}`) {
        return null;
    }
    return `this is npm ${version} and package.json pins ${packageManager}: another npm may write the lock differently`;
}

export function treeReader(root) {
    return (file) => fs.readFileSync(path.join(root, file), "utf8");
}

export function commitReader(root) {
    return (file) =>
        execFileSync("git", ["show", `HEAD:${file}`], {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
        });
}

function main() {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const read = process.argv.includes("--committed") ? commitReader(root) : treeReader(root);
    let drift;
    try {
        drift = lockDrift(read);
    } catch (err) {
        console.error(`lockfile: cannot run: ${err.message}`);
        process.exit(2);
    }
    if (drift == null) {
        console.log(`lockfile: ${LockFile} matches package.json and its workspaces`);
        process.exit(0);
    }
    console.log(`lockfile: ${drift.message}:`);
    for (const line of drift.lines.slice(0, MaxShownLines)) {
        console.log(`  ${line}`);
    }
    if (drift.lines.length > MaxShownLines) {
        console.log(`  ... and ${drift.lines.length - MaxShownLines} more lines`);
    }
    const version = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    const note = npmVersionNote(JSON.parse(read("package.json")).packageManager, version);
    if (note != null) {
        console.log(`lockfile: ${note}`);
    }
    console.log(`lockfile: run \`${FixCommand}\` and commit ${LockFile}`);
    if (process.env.GITHUB_ACTIONS === "true") {
        console.log(`::error file=${LockFile}::${drift.message}; run ${FixCommand} and commit it`);
    }
    process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
