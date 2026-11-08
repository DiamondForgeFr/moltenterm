// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2057, FR-BRW-014: the remote debugging switches are Chromium's, not a fuse, so a packaged app
// would open a debugging port on whatever profile it runs with. Any same-user program could then start MoltenTerm with
// `--remote-debugging-port` and drive the user's signed-in pages. A packaged app honours the switches only on a test
// profile: not the build's default profile, and either new at this start (it is then marked) or marked before. A path
// rule alone is not enough: the data folder can point at another build's real profile (a release at the gold's data).
//
// #2066: the mark alone is not enough either. A same-user program can let the app mark a new folder, copy the user's
// real Cookies files into it and start again with the port: Chromium would decrypt them with the app's own keychain key,
// which a signed app gets without a prompt. So a packaged app never asks the system for its real key on a test profile:
// the cookie key of that run is a throwaway one (Chromium's mock keychain on macOS, the basic store on Linux). Copied
// cookies stay unreadable, and the cookies a test instance creates itself keep working across its starts. A path or
// content check on the Cookies file would be weaker: it can be raced between the check and Chromium opening the file.
// Windows has no such switch; its key is protected by DPAPI for the user, which a same-user program can already call.

import fs from "fs";
import path from "path";

export const RemoteDebuggingSwitches = ["remote-debugging-port", "remote-debugging-pipe"];
export const TestProfileMarkName = "moltenterm-test-profile";
export const MockKeychainSwitch = "use-mock-keychain";
export const PasswordStoreSwitch = "password-store";
export const BasicPasswordStore = "basic";

export const ReasonNotRequested = "not-requested";
export const ReasonDevBuild = "dev-build";
export const ReasonDefaultProfile = "default-profile";
export const ReasonNewProfile = "new-profile";
export const ReasonMarkedProfile = "marked-profile";
export const ReasonUnmarkedProfile = "unmarked-profile";

export type RemoteDebuggingInput = {
    requested: boolean;
    packaged: boolean;
    profileDir: string;
    defaultProfileDir: string;
    profileExists: boolean;
    profileMarked: boolean;
    caseInsensitive: boolean;
};

export type RemoteDebuggingDecision = {
    honour: boolean;
    markProfile: boolean;
    reason: string;
};

type CommandLineLike = {
    hasSwitch(name: string): boolean;
    removeSwitch(name: string): void;
    appendSwitch(name: string, value?: string): void;
};

// The switches that keep a run off the system's real cookie key, or null where none exists.
export function throwawayKeySwitch(platform: string): { name: string; value?: string } {
    if (platform === "darwin") {
        return { name: MockKeychainSwitch };
    }
    if (platform === "linux") {
        return { name: PasswordStoreSwitch, value: BasicPasswordStore };
    }
    return null;
}

// A packaged app uses a throwaway cookie key on every run of a test profile, whether or not it opens the port, so a test
// profile's own cookies are read back with the key that wrote them.
export function usesThrowawayKey(opts: {
    packaged: boolean;
    decision: RemoteDebuggingDecision;
    profileMarked: boolean;
    isDefaultProfile: boolean;
}): boolean {
    if (!opts.packaged || opts.isDefaultProfile) {
        return false;
    }
    return opts.decision.honour || opts.profileMarked;
}

// The caller's own --password-store is replaced: on a test profile the key never comes from the system.
function forceThrowawayKey(commandLine: CommandLineLike, platform: string): boolean {
    const sw = throwawayKeySwitch(platform);
    if (sw == null) {
        return false;
    }
    commandLine.removeSwitch(sw.name);
    if (sw.value == null) {
        commandLine.appendSwitch(sw.name);
    } else {
        commandLine.appendSwitch(sw.name, sw.value);
    }
    return true;
}

export function decideRemoteDebugging(input: RemoteDebuggingInput): RemoteDebuggingDecision {
    if (!input.requested) {
        return { honour: false, markProfile: false, reason: ReasonNotRequested };
    }
    if (!input.packaged) {
        return { honour: true, markProfile: false, reason: ReasonDevBuild };
    }
    if (sameDir(input.profileDir, input.defaultProfileDir, input.caseInsensitive)) {
        return { honour: false, markProfile: false, reason: ReasonDefaultProfile };
    }
    if (!input.profileExists) {
        return { honour: true, markProfile: true, reason: ReasonNewProfile };
    }
    if (input.profileMarked) {
        return { honour: true, markProfile: false, reason: ReasonMarkedProfile };
    }
    return { honour: false, markProfile: false, reason: ReasonUnmarkedProfile };
}

function sameDir(a: string, b: string, caseInsensitive: boolean): boolean {
    const ra = realDir(a);
    const rb = realDir(b);
    return caseInsensitive ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

// A symbolic link to the default profile is the default profile. A folder that does not exist yet resolves through its
// nearest existing parent, so a link higher up counts too.
function realDir(p: string): string {
    const abs = path.resolve(p);
    try {
        return fs.realpathSync.native(abs);
    } catch {
        const parent = path.dirname(abs);
        if (parent === abs) {
            return abs;
        }
        return path.join(realDir(parent), path.basename(abs));
    }
}

function profileHasMark(profileDir: string): boolean {
    try {
        return fs.statSync(path.join(profileDir, TestProfileMarkName)).isFile();
    } catch {
        return false;
    }
}

// Must run before the app is ready: Chromium reads the switches when its browser process starts its message loop.
export function applyRemoteDebuggingPolicy(opts: {
    commandLine: CommandLineLike;
    packaged: boolean;
    profileDir: string;
    defaultProfileDir: string;
    platform?: string;
    log?: (line: string) => void;
}): RemoteDebuggingDecision {
    const log = opts.log ?? ((line: string) => console.log(line));
    const platform = opts.platform ?? process.platform;
    const caseInsensitive = platform === "darwin" || platform === "win32";
    const profileMarked = profileHasMark(opts.profileDir);
    const decision = decideRemoteDebugging({
        requested: RemoteDebuggingSwitches.some((s) => opts.commandLine.hasSwitch(s)),
        packaged: opts.packaged,
        profileDir: opts.profileDir,
        defaultProfileDir: opts.defaultProfileDir,
        profileExists: fs.existsSync(opts.profileDir),
        profileMarked,
        caseInsensitive,
    });
    if (decision.reason === ReasonDevBuild) {
        return decision;
    }
    if (decision.reason === ReasonNotRequested) {
        const isolate = usesThrowawayKey({
            packaged: opts.packaged,
            decision,
            profileMarked,
            isDefaultProfile: sameDir(opts.profileDir, opts.defaultProfileDir, caseInsensitive),
        });
        if (isolate && forceThrowawayKey(opts.commandLine, platform)) {
            log(`remote debugging: off; the test profile ${opts.profileDir} uses a throwaway cookie key`);
        }
        return decision;
    }
    if (!decision.honour) {
        for (const name of RemoteDebuggingSwitches) {
            opts.commandLine.removeSwitch(name);
        }
        log(`remote debugging: ignored (${decision.reason}): the profile ${opts.profileDir} is not a test profile`);
        return decision;
    }
    if (decision.markProfile) {
        try {
            fs.mkdirSync(opts.profileDir, { recursive: true });
            fs.writeFileSync(
                path.join(opts.profileDir, TestProfileMarkName),
                "Created by a MoltenTerm start with a remote debugging switch: a test profile, not a user's.\n"
            );
        } catch (e) {
            for (const name of RemoteDebuggingSwitches) {
                opts.commandLine.removeSwitch(name);
            }
            log(`remote debugging: ignored: could not mark the new profile ${opts.profileDir} (${e})`);
            return { honour: false, markProfile: false, reason: decision.reason };
        }
    }
    const key = forceThrowawayKey(opts.commandLine, platform)
        ? "with a throwaway cookie key"
        : "with the system's cookie key (no throwaway key on this platform)";
    log(`remote debugging: allowed (${decision.reason}) on the test profile ${opts.profileDir}, ${key}`);
    return decision;
}
