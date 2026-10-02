// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Delivers a built Moltenterm.app as the new gold (#64), modelled on Notulia's scripts/build-local.sh: the next state
// (new app, the old one kept under previous/, the manifest) is assembled beside the gold folder, then renamed onto
// it, so the installed gold never sees a manifest without its complete app. The manifest's format must match
// frontend/util/moltenterm-gold.ts.
//
// usage: node scripts/moltenterm-gold-deliver.mjs --app <path/to/Moltenterm.app> --build-id <unix seconds>

/* global console, process */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GoldManifestSchema = 1;
export const GoldAppName = "Moltenterm.app";
export const GoldIdentifier = "fr.diamondforge.moltenterm";
const MaxNotes = 50;
const FallbackNotes = 20;

export function goldDir(env = process.env, home = os.homedir()) {
    if (env.MOLTENTERM_GOLD_DIR) {
        return env.MOLTENTERM_GOLD_DIR;
    }
    return path.join(home, "Library", "Application Support", "Moltenterm Local Builds", "gold");
}

function git(args, cwd) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function tryGit(args, cwd) {
    try {
        return git(args, cwd);
    } catch {
        return null;
    }
}

export function parseNotes(log) {
    return (log ?? "")
        .split("\n")
        .filter((line) => line.includes("\t"))
        .map((line) => {
            const [sha, ...rest] = line.split("\t");
            return { sha, subject: rest.join("\t") };
        });
}

// The commits since the previous gold, when it is an ancestor of this one; otherwise the last few.
export function goldNotes(previousCommit, commit, cwd) {
    const format = "--format=%H%x09%s";
    if (previousCommit && tryGit(["merge-base", "--is-ancestor", previousCommit, commit], cwd) !== null) {
        return parseNotes(tryGit(["log", format, "-n", String(MaxNotes), `${previousCommit}..${commit}`], cwd));
    }
    return parseNotes(tryGit(["log", format, "-n", String(FallbackNotes), commit], cwd));
}

export function makeManifest({ version, buildId, builtAt, commit, notes }) {
    return {
        schema: GoldManifestSchema,
        identifier: GoldIdentifier,
        productName: "Moltenterm",
        version,
        buildId,
        builtAt,
        commit,
        app: GoldAppName,
        notes,
    };
}

function readManifest(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

// APFS clones: instant and free of extra space; a plain copy elsewhere (the tests also run on Linux).
function copyApp(from, to) {
    if (process.platform === "darwin") {
        try {
            execFileSync("cp", ["-c", "-R", from, to], { stdio: "ignore" });
            return;
        } catch {
            execFileSync("ditto", [from, to], { stdio: "ignore" });
            return;
        }
    }
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

export function deliverGold({ app, dir, manifest }) {
    const parent = path.dirname(dir);
    fs.mkdirSync(parent, { recursive: true });
    const next = path.join(parent, `.${path.basename(dir)}.next`);
    const old = path.join(parent, `.${path.basename(dir)}.old`);
    fs.rmSync(next, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    fs.mkdirSync(next);
    copyApp(app, path.join(next, GoldAppName));
    const currentApp = path.join(dir, GoldAppName);
    const currentManifest = path.join(dir, "manifest.json");
    if (fs.existsSync(currentApp) && fs.existsSync(currentManifest)) {
        fs.mkdirSync(path.join(next, "previous"));
        copyApp(currentApp, path.join(next, "previous", GoldAppName));
        fs.copyFileSync(currentManifest, path.join(next, "previous", "manifest.json"));
    }
    fs.writeFileSync(path.join(next, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (fs.existsSync(dir)) {
        fs.renameSync(dir, old);
    }
    fs.renameSync(next, dir);
    fs.rmSync(old, { recursive: true, force: true });
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--app") {
            args.app = argv[++i];
        } else if (argv[i] === "--build-id") {
            args.buildId = Number(argv[++i]);
        }
    }
    return args;
}

function main() {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const { app, buildId } = parseArgs(process.argv.slice(2));
    if (!app || !fs.existsSync(app) || !Number.isInteger(buildId) || buildId <= 0) {
        console.error("usage: moltenterm-gold-deliver.mjs --app <Moltenterm.app> --build-id <unix seconds>");
        process.exit(1);
    }
    const dir = goldDir();
    const previous = readManifest(path.join(dir, "manifest.json"));
    const commit = git(["rev-parse", "HEAD"], repo);
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    const manifest = makeManifest({
        version: pkg.version,
        buildId,
        builtAt: new Date(buildId * 1000).toISOString(),
        commit,
        notes: goldNotes(previous?.commit, commit, repo),
    });
    deliverGold({ app, dir, manifest });
    console.log(`gold ${commit.slice(0, 7)} (build ${buildId}) delivered to ${dir}`);
    console.log(`${manifest.notes.length} change(s) since the previous gold`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main();
}
