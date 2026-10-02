// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { makeStatusBarView } from "./status-bar-model";

const build = {
    channel: "local",
    branch: "develop",
    commit: "a4e3b72d9f00",
    shortCommit: "a4e3b72",
    dirty: true,
    builtAt: "2026-10-02T08:00:00.000Z",
    buildId: 1790928000,
};

describe("makeStatusBarView", () => {
    it("shows a local build with its branch, commit and dirty mark", () => {
        expect(makeStatusBarView(build, { isDev: false, version: "0.14.5" })).toMatchObject({
            channel: "local",
            channelLabel: "local build",
            branch: "develop",
            shortCommit: "a4e3b72",
            dirty: true,
            version: "0.14.5",
        });
    });

    it("says dev under the dev server, whatever the build says", () => {
        expect(makeStatusBarView({ ...build, channel: "release" }, { isDev: true, version: "x" }).channel).toBe("dev");
    });

    it("lets the launcher mark a gold copy", () => {
        expect(makeStatusBarView(build, { isDev: false, runtimeChannel: "gold", version: "x" }).channelLabel).toBe(
            "Gold"
        );
    });

    it("shows only the version for a release", () => {
        expect(makeStatusBarView({ ...build, channel: "release" }, { isDev: false, version: "1.0.0" })).toMatchObject({
            branch: "",
            shortCommit: "",
            dirty: false,
        });
    });

    it("puts the build time and the full commit in the tooltip", () => {
        const view = makeStatusBarView(build, { isDev: false, version: "0.14.5" });
        expect(view.tooltip).toBe(
            "Moltenterm 0.14.5\nbuilt 2026-10-02T08:00:00.000Z\ncommit a4e3b72d9f00 (uncommitted changes)"
        );
    });

    it("copes with a build without facts and an unknown channel", () => {
        expect(makeStatusBarView(null, { isDev: false, runtimeChannel: "weird", version: "1" })).toMatchObject({
            channel: "local",
            branch: "",
        });
    });
});
