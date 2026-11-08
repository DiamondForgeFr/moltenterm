// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    applyRemoteDebuggingPolicy,
    BasicPasswordStore,
    decideRemoteDebugging,
    MockKeychainSwitch,
    PasswordStoreSwitch,
    ReasonDefaultProfile,
    ReasonDevBuild,
    ReasonMarkedProfile,
    ReasonNewProfile,
    ReasonNotRequested,
    ReasonUnmarkedProfile,
    RemoteDebuggingInput,
    TestProfileMarkName,
    throwawayKeySwitch,
} from "./moltenterm-remote-debugging";

function input(over: Partial<RemoteDebuggingInput> = {}): RemoteDebuggingInput {
    return {
        requested: true,
        packaged: true,
        profileDir: "/tmp/mt-test/data/electron",
        defaultProfileDir: "/Users/someone/Library/Application Support/moltenterm/electron",
        profileExists: false,
        profileMarked: false,
        caseInsensitive: false,
        ...over,
    };
}

describe("decideRemoteDebugging", () => {
    it("ignores the switch in a packaged app on the default profile", () => {
        const d = decideRemoteDebugging(
            input({ profileDir: input().defaultProfileDir, profileExists: true, profileMarked: true })
        );
        expect(d).toEqual({ honour: false, markProfile: false, reason: ReasonDefaultProfile });
    });

    it("matches the default profile case-insensitively where the disk is", () => {
        const d = decideRemoteDebugging(
            input({ profileDir: input().defaultProfileDir.toUpperCase(), caseInsensitive: true })
        );
        expect(d.reason).toBe(ReasonDefaultProfile);
    });

    it("honours it on a new profile of its own and marks it", () => {
        expect(decideRemoteDebugging(input())).toEqual({ honour: true, markProfile: true, reason: ReasonNewProfile });
    });

    it("honours it on a profile a debugging start marked", () => {
        const d = decideRemoteDebugging(input({ profileExists: true, profileMarked: true }));
        expect(d).toEqual({ honour: true, markProfile: false, reason: ReasonMarkedProfile });
    });

    it("ignores it on another existing profile without the mark", () => {
        const d = decideRemoteDebugging(input({ profileExists: true }));
        expect(d).toEqual({ honour: false, markProfile: false, reason: ReasonUnmarkedProfile });
    });

    it("keeps it in a dev build, even on the default profile", () => {
        const d = decideRemoteDebugging(input({ packaged: false, profileDir: input().defaultProfileDir }));
        expect(d).toEqual({ honour: true, markProfile: false, reason: ReasonDevBuild });
    });

    it("does nothing without the switch", () => {
        expect(decideRemoteDebugging(input({ requested: false })).reason).toBe(ReasonNotRequested);
    });
});

describe("applyRemoteDebuggingPolicy", () => {
    let root: string;
    let lines: string[];

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-rdp-"));
        lines = [];
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function commandLine(switches: string[], values: Record<string, string> = {}) {
        const present = new Set(switches);
        const value = new Map(Object.entries(values));
        for (const name of value.keys()) {
            present.add(name);
        }
        return {
            present,
            value,
            hasSwitch: (name: string) => present.has(name),
            removeSwitch: (name: string) => {
                present.delete(name);
                value.delete(name);
            },
            appendSwitch: (name: string, v?: string) => {
                present.add(name);
                if (v != null) {
                    value.set(name, v);
                }
            },
        };
    }

    function apply(
        cl: ReturnType<typeof commandLine>,
        profileDir: string,
        defaultProfileDir: string,
        packaged = true,
        platform = "linux"
    ) {
        return applyRemoteDebuggingPolicy({
            commandLine: cl,
            packaged,
            profileDir,
            defaultProfileDir,
            platform,
            log: (l) => lines.push(l),
        });
    }

    function isolated(cl: ReturnType<typeof commandLine>, platform: string): boolean {
        if (platform === "darwin") {
            return cl.present.has(MockKeychainSwitch);
        }
        return cl.value.get(PasswordStoreSwitch) === BasicPasswordStore;
    }

    for (const platform of ["darwin", "linux"]) {
        describe(`cookie key on ${platform} (#2066)`, () => {
            const defaultProfile = () => path.join(root, "default", "electron");

            it("never asks the system for the real key when the port opens on a new test profile", () => {
                const cl = commandLine(["remote-debugging-port"]);
                expect(apply(cl, path.join(root, "test", "electron"), defaultProfile(), true, platform).honour).toBe(
                    true
                );
                expect(isolated(cl, platform)).toBe(true);
                expect(lines.join("\n")).toContain("with a throwaway cookie key");
            });

            it("keeps the throwaway key on a marked profile, with or without the port", () => {
                const profile = path.join(root, "test", "electron");
                apply(commandLine(["remote-debugging-port"]), profile, defaultProfile(), true, platform);
                const withPort = commandLine(["remote-debugging-port"]);
                expect(apply(withPort, profile, defaultProfile(), true, platform).reason).toBe(ReasonMarkedProfile);
                expect(isolated(withPort, platform)).toBe(true);
                const without = commandLine([]);
                expect(apply(without, profile, defaultProfile(), true, platform).reason).toBe(ReasonNotRequested);
                expect(isolated(without, platform)).toBe(true);
            });

            it("leaves the real key on the user's own and unmarked profiles, and in a dev build", () => {
                const own = defaultProfile();
                fs.mkdirSync(own, { recursive: true });
                fs.writeFileSync(path.join(own, TestProfileMarkName), "");
                const ownPort = commandLine(["remote-debugging-port"]);
                apply(ownPort, own, own, true, platform);
                expect(isolated(ownPort, platform)).toBe(false);
                const ownPlain = commandLine([]);
                apply(ownPlain, own, own, true, platform);
                expect(isolated(ownPlain, platform)).toBe(false);

                const other = path.join(root, "gold", "electron");
                fs.mkdirSync(other, { recursive: true });
                const otherPort = commandLine(["remote-debugging-port"]);
                apply(otherPort, other, own, true, platform);
                expect(isolated(otherPort, platform)).toBe(false);

                const dev = commandLine(["remote-debugging-port"]);
                apply(dev, path.join(root, "dev", "electron"), own, false, platform);
                expect(isolated(dev, platform)).toBe(false);
            });
        });
    }

    it("replaces a password store the caller asked for on a test profile", () => {
        const cl = commandLine(["remote-debugging-port"], { [PasswordStoreSwitch]: "gnome-libsecret" });
        apply(cl, path.join(root, "test", "electron"), path.join(root, "default", "electron"), true, "linux");
        expect(cl.value.get(PasswordStoreSwitch)).toBe(BasicPasswordStore);
    });

    it("names the system key where no throwaway key exists", () => {
        const cl = commandLine(["remote-debugging-port"]);
        apply(cl, path.join(root, "test", "electron"), path.join(root, "default", "electron"), true, "win32");
        expect(throwawayKeySwitch("win32")).toBeNull();
        expect(cl.present.has("remote-debugging-port")).toBe(true);
        expect(lines.join("\n")).toContain("no throwaway key on this platform");
    });

    it("removes both switches on the default profile and logs why", () => {
        const profile = path.join(root, "default", "electron");
        fs.mkdirSync(profile, { recursive: true });
        const cl = commandLine(["remote-debugging-port", "remote-debugging-pipe"]);
        apply(cl, profile, profile);
        expect([...cl.present]).toEqual([]);
        expect(lines.join("\n")).toMatch(/^remote debugging: ignored \(default-profile\)/);
    });

    it("treats a link to the default profile as the default profile", () => {
        const profile = path.join(root, "default", "electron");
        fs.mkdirSync(profile, { recursive: true });
        fs.symlinkSync(path.join(root, "default"), path.join(root, "link"));
        const cl = commandLine(["remote-debugging-port"]);
        expect(apply(cl, path.join(root, "link", "electron"), profile).reason).toBe(ReasonDefaultProfile);
        expect(cl.present.size).toBe(0);
    });

    it("marks a new test profile, keeps the switch, and honours it on the next start", () => {
        const profile = path.join(root, "test", "electron");
        const cl = commandLine(["remote-debugging-port"]);
        expect(apply(cl, profile, path.join(root, "default", "electron")).reason).toBe(ReasonNewProfile);
        expect(cl.present.has("remote-debugging-port")).toBe(true);
        expect(fs.existsSync(path.join(profile, TestProfileMarkName))).toBe(true);
        const again = commandLine(["remote-debugging-port"]);
        expect(apply(again, profile, path.join(root, "default", "electron")).reason).toBe(ReasonMarkedProfile);
        expect(again.present.has("remote-debugging-port")).toBe(true);
    });

    it("removes the switch on an existing profile without the mark, and does not mark it", () => {
        const profile = path.join(root, "gold", "electron");
        fs.mkdirSync(profile, { recursive: true });
        fs.writeFileSync(path.join(profile, "Cookies"), "");
        const cl = commandLine(["remote-debugging-port"]);
        expect(apply(cl, profile, path.join(root, "default", "electron")).reason).toBe(ReasonUnmarkedProfile);
        expect(cl.present.size).toBe(0);
        expect(fs.existsSync(path.join(profile, TestProfileMarkName))).toBe(false);
    });

    it("leaves a dev build and a start without the switch alone", () => {
        const profile = path.join(root, "default", "electron");
        const dev = commandLine(["remote-debugging-port"]);
        apply(dev, profile, profile, false);
        expect(dev.present.has("remote-debugging-port")).toBe(true);
        apply(commandLine([]), profile, profile);
        expect(lines).toEqual([]);
        expect(fs.existsSync(profile)).toBe(false);
    });
});
