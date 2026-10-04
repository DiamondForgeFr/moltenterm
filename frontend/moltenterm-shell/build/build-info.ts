// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The facts of a Moltenterm build, written once at build time for the status bar (FR-SHELL-008, DS-SHELL-008) and the
// About panel (FR-REL-001). Runs in the build configuration (Node), never in the app.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareVersions, releaseOf, Version, VersionRules } from "../releases/versions";

export type MoltentermBuildInfo = {
    // dev, local, gold, rc or public.
    channel: string;
    // package.json's version (1.0.0-0 before the first release candidate).
    version: string;
    branch: string;
    commit: string;
    shortCommit: string;
    dirty: boolean;
    builtAt: string;
    // Unix seconds; the gold delivery sets it (MOLTENTERM_BUILD_ID) so the app and its manifest agree (#64).
    buildId: number;
    // The highest release (candidate or public) reachable from the built commit, "" before the first one.
    releaseTag: string;
    // The commits since releaseTag (all of them before the first release); -1 when git could not say.
    changesSinceRelease: number;
};

type Git = (args: string[]) => string;
type ReadText = (path: string) => string;

function realGit(args: string[]): string {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function realReadText(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

function tryGit(git: Git, args: string[]): string {
    try {
        return git(args);
    } catch {
        return "";
    }
}

function readJson(readText: ReadText, path: string): any {
    try {
        return JSON.parse(readText(path));
    } catch {
        return null;
    }
}

// The last release the build contains, read with the project's own rules: a fork's upstream tags do not count.
function lastReachableRelease(git: Git, rules: VersionRules): string {
    const listed = tryGit(git, ["tag", "--merged", "HEAD", "-l", `${rules.tagprefix || "v"}*`]);
    let best = "";
    let bestVersion: Version = null;
    for (const tag of listed.split("\n")) {
        const v = releaseOf(rules, tag);
        if (v && (bestVersion == null || compareVersions(v, bestVersion) > 0)) {
            best = tag.trim();
            bestVersion = v;
        }
    }
    return best;
}

export function makeMoltentermBuildInfo(
    env: Record<string, string> = process.env,
    git: Git = realGit,
    now: Date = new Date(),
    readText: ReadText = realReadText
): MoltentermBuildInfo {
    const commit = tryGit(git, ["rev-parse", "HEAD"]);
    const envBuildId = Number(env.MOLTENTERM_BUILD_ID);
    const rules: VersionRules = readJson(readText, ".molten/project.json")?.versions ?? {};
    const releaseTag = commit ? lastReachableRelease(git, rules) : "";
    const count = Number.parseInt(tryGit(git, ["rev-list", "--count", releaseTag ? `${releaseTag}..HEAD` : "HEAD"]), 10);
    return {
        channel: env.MOLTENTERM_BUILD_CHANNEL || "local",
        version: readJson(readText, "package.json")?.version ?? "",
        branch: tryGit(git, ["rev-parse", "--abbrev-ref", "HEAD"]),
        commit,
        shortCommit: commit.slice(0, 7),
        dirty: tryGit(git, ["status", "--porcelain", "--untracked-files=no"]) !== "",
        builtAt: now.toISOString(),
        buildId: Number.isInteger(envBuildId) && envBuildId > 0 ? envBuildId : Math.floor(now.getTime() / 1000),
        releaseTag,
        changesSinceRelease: Number.isInteger(count) ? count : -1,
    };
}
