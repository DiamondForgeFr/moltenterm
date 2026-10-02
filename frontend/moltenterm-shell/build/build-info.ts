// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The facts of a Moltenterm build, written once at build time for the status bar (FR-SHELL-008, DS-SHELL-008). Runs
// in the build configuration (Node), never in the app.

import { execFileSync } from "node:child_process";

export type MoltentermBuildInfo = {
    channel: string;
    branch: string;
    commit: string;
    shortCommit: string;
    dirty: boolean;
    builtAt: string;
    // Unix seconds; the gold delivery sets it (MOLTENTERM_BUILD_ID) so the app and its manifest agree (#64).
    buildId: number;
};

type Git = (args: string[]) => string;

function realGit(args: string[]): string {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function tryGit(git: Git, args: string[]): string {
    try {
        return git(args);
    } catch {
        return "";
    }
}

export function makeMoltentermBuildInfo(
    env: Record<string, string> = process.env,
    git: Git = realGit,
    now: Date = new Date()
): MoltentermBuildInfo {
    const commit = tryGit(git, ["rev-parse", "HEAD"]);
    const envBuildId = Number(env.MOLTENTERM_BUILD_ID);
    return {
        channel: env.MOLTENTERM_BUILD_CHANNEL || "local",
        branch: tryGit(git, ["rev-parse", "--abbrev-ref", "HEAD"]),
        commit,
        shortCommit: commit.slice(0, 7),
        dirty: tryGit(git, ["status", "--porcelain", "--untracked-files=no"]) !== "",
        builtAt: now.toISOString(),
        buildId: Number.isInteger(envBuildId) && envBuildId > 0 ? envBuildId : Math.floor(now.getTime() / 1000),
    };
}
