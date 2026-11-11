// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { MoltentermWaveBaseVersion } from "@/util/moltenterm-identity";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gateChannel, resolveBuildChannel } from "./build-channel";
import type { MoltentermBuildInfo } from "./build-info";
import { brainstormAllowed, brainstormReplayAllowed, BuildChannel, makeBuildIdentity } from "./build-identity";

// FR-BOSS-010 AC1 (#2246): Brokk's thought in 3D on gold, dev and local builds only; its scripted replay on dev and local.
describe("the brainstorm gate", () => {
    it.each<[BuildChannel, boolean, boolean]>([
        ["gold", true, false],
        ["dev", true, true],
        ["local", true, true],
        ["rc", false, false],
        ["public", false, false],
    ])("%s: brainstorm %s, replay %s", (channel, start, replay) => {
        expect(brainstormAllowed(channel)).toBe(start);
        expect(brainstormReplayAllowed(channel)).toBe(replay);
    });

    it("names a build after the launcher's channel, as its badge and its updates did", () => {
        expect(resolveBuildChannel({ isDev: true, runtimeChannel: "public", buildChannel: "public" })).toBe("dev");
        expect(resolveBuildChannel({ isDev: false, runtimeChannel: "gold", buildChannel: "public" })).toBe("gold");
        expect(resolveBuildChannel({ isDev: false, buildChannel: "rc" })).toBe("rc");
        expect(resolveBuildChannel({ isDev: false, buildChannel: "nightly" })).toBe("local");
        expect(resolveBuildChannel({ isDev: false })).toBe("local");
    });

    // The gate never widens: a release launched as a gold stays shut, and an unknown name opens nothing. Must match
    // pkg/molten/buildchannel TestGateChannelNeverWidensARelease.
    it.each<[boolean, string, string, string, boolean]>([
        [false, "public", "gold", "public", false],
        [false, "rc", "dev", "rc", false],
        [false, "public", "anything", "public", false],
        [false, "nightly", "", "unknown", false],
        [false, "gold", "anything", "unknown", false],
        [false, "gold", "", "gold", true],
        [false, "local", "", "local", true],
        [false, "", "", "local", true],
        [false, "local", "gold", "gold", true],
        [false, "local", "dev", "dev", true],
        [false, "gold", "dev", "gold", true],
        [false, "gold", "local", "gold", true],
        [false, "gold", "public", "public", false],
        [false, "gold", "rc", "rc", false],
        [true, "public", "", "dev", true],
    ])("gates dev=%s baked %s launcher %s as %s (allowed %s)", (isDev, buildChannel, runtimeChannel, want, allowed) => {
        const gate = gateChannel({ isDev, buildChannel, runtimeChannel });
        expect(gate).toBe(want);
        expect(brainstormAllowed(gate)).toBe(allowed);
    });

    it("never opens the replay of a gold, whatever the launcher says", () => {
        for (const runtimeChannel of ["", "gold", "dev", "local", "rc", "public", "anything"]) {
            expect(brainstormReplayAllowed(gateChannel({ isDev: false, buildChannel: "gold", runtimeChannel }))).toBe(
                false
            );
        }
    });
});

const gold: MoltentermBuildInfo = {
    channel: "gold",
    version: "1.0.0-0",
    branch: "develop",
    commit: "a4e3b72d9f00112233",
    shortCommit: "a4e3b72",
    dirty: false,
    builtAt: "2026-10-02T08:00:00.000Z",
    buildId: 1790928000,
    releaseTag: "",
    changesSinceRelease: 812,
};

describe("makeBuildIdentity", () => {
    it("names a gold by its channel, build and commit, before any release", () => {
        expect(makeBuildIdentity(gold, { isDev: false })).toEqual({
            channel: "gold",
            channelLabel: "Gold",
            version: "1.0.0-0",
            badge: "Gold",
            buildLine: "Gold · build 1790928000 · no release yet",
            commitLine: "commit a4e3b72 on develop",
            waveBase: "0.14.5",
        });
    });

    it("counts the changes since the last release the build contains", () => {
        const after = { ...gold, releaseTag: "v1.0.0-2" };
        expect(makeBuildIdentity({ ...after, changesSinceRelease: 1 }, { isDev: false }).buildLine).toBe(
            "Gold · build 1790928000 · 1 change since v1.0.0-2"
        );
        expect(makeBuildIdentity({ ...after, changesSinceRelease: 0 }, { isDev: false }).buildLine).toBe(
            "Gold · build 1790928000 · exactly v1.0.0-2"
        );
        expect(makeBuildIdentity({ ...after, changesSinceRelease: -1 }, { isDev: false }).buildLine).toBe(
            "Gold · build 1790928000 · after v1.0.0-2"
        );
    });

    it("prefers the version wavesrv reports, and shows it in the badge of a release", () => {
        const rc = { ...gold, channel: "rc", version: "1.0.0-3", releaseTag: "v1.0.0-3", changesSinceRelease: 0 };
        expect(makeBuildIdentity(rc, { isDev: false, version: "1.0.0-3" })).toMatchObject({
            channel: "rc",
            badge: "1.0.0-3",
            buildLine: "release candidate · build 1790928000 · exactly v1.0.0-3",
        });
        expect(makeBuildIdentity(gold, { isDev: false, version: "1.0.0-1" }).version).toBe("1.0.0-1");
    });

    it("says dev under the dev server and marks uncommitted changes", () => {
        expect(makeBuildIdentity({ ...gold, dirty: true }, { isDev: true })).toMatchObject({
            channel: "dev",
            badge: "dev",
            commitLine: "commit a4e3b72 on develop (uncommitted changes)",
        });
    });
});

describe("the Wave base", () => {
    it("is the release UPSTREAM.md says Moltenterm is merged on", () => {
        const upstream = readFileSync(resolve(__dirname, "../../../UPSTREAM.md"), "utf8");
        const m = /## Current base[\s\S]*?\n\| v(\d+\.\d+\.\d+)\s/.exec(upstream);
        expect(m?.[1]).toBe(MoltentermWaveBaseVersion);
    });
});
