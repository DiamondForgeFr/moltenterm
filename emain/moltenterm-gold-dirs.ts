// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The gold's own folders (#509). A release keeps the product's identity (fr.diamondforge.moltenterm, the "moltenterm"
// folders); the gold has an identity of its own, as dev builds do, so that a release installed beside it neither
// reads its database, nor shares its single-instance lock (kept in <data>/electron), nor replaces its macOS privacy
// grants (#224). The first gold with that identity takes over the folders the golds used before, by renaming them.

import fs from "fs";
import path from "path";

export const GoldDirSuffix = "gold";

// The suffix of the configuration and data folder names: "dev" for a dev build, "gold" for a gold, none for a release.
export function moltentermDirSuffix(channel: string, isDev: boolean): string {
    if (isDev) {
        return "dev";
    }
    return channel === "gold" ? GoldDirSuffix : "";
}

export type GoldDirMove = { from: string; to: string };

export type GoldDirsPlan = {
    moves: GoldDirMove[];
    // Set when a MoltenTerm still runs on the old folders: moving them under it would break it, and starting on empty
    // folders would leave the gold's data behind for good.
    busy?: string;
};

type FsLike = {
    existsSync: (p: string) => boolean;
    readlinkSync: (p: string) => string;
};

type ProcessAlive = (pid: number) => boolean;

function realProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e?.code === "EPERM";
    }
}

// Chromium's single-instance lock is a symlink named SingletonLock whose target is "<host>-<pid>".
export function lockHolder(electronDir: string, fsx: FsLike = fs, alive: ProcessAlive = realProcessAlive): number {
    let target: string;
    try {
        target = fsx.readlinkSync(path.join(electronDir, "SingletonLock"));
    } catch {
        return 0;
    }
    const match = /-(\d+)$/.exec(target ?? "");
    if (!match) {
        return 0;
    }
    const pid = Number(match[1]);
    return pid > 0 && alive(pid) ? pid : 0;
}

// What the first gold moves: each old folder whose gold folder does not exist yet. A folder given by an override
// variable is never moved (the caller leaves it out).
export function planGoldDirs(
    pairs: GoldDirMove[],
    legacyDataDir: string,
    fsx: FsLike = fs,
    alive: ProcessAlive = realProcessAlive
): GoldDirsPlan {
    const moves = pairs.filter((pair) => pair.from !== pair.to && !fsx.existsSync(pair.to) && fsx.existsSync(pair.from));
    if (moves.length === 0) {
        return { moves };
    }
    const pid = lockHolder(path.join(legacyDataDir, "electron"), fsx, alive);
    if (pid > 0) {
        return { moves: [], busy: `MoltenTerm (pid ${pid}) is using ${legacyDataDir}` };
    }
    return { moves };
}

export function applyGoldDirs(plan: GoldDirsPlan, rename: (from: string, to: string) => void = fs.renameSync): string[] {
    const done: string[] = [];
    for (const move of plan.moves) {
        fs.mkdirSync(path.dirname(move.to), { recursive: true });
        rename(move.from, move.to);
        done.push(`${move.from} -> ${move.to}`);
    }
    return done;
}
