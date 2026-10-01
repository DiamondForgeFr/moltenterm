// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { makeMoltentermBuildInfo } from "./build-info";

function fakeGit(answers: Record<string, string>) {
    return (args: string[]) => {
        const key = args.join(" ");
        if (!(key in answers)) {
            throw new Error("not a git repository");
        }
        return answers[key];
    };
}

const now = new Date("2026-10-02T08:00:00Z");

describe("makeMoltentermBuildInfo", () => {
    it("reads branch, commit and a clean tree", () => {
        const info = makeMoltentermBuildInfo(
            {},
            fakeGit({
                "rev-parse HEAD": "a4e3b72d9f00112233445566778899aabbccddee",
                "rev-parse --abbrev-ref HEAD": "develop",
                "status --porcelain --untracked-files=no": "",
            }),
            now
        );
        expect(info).toEqual({
            channel: "local",
            branch: "develop",
            commit: "a4e3b72d9f00112233445566778899aabbccddee",
            shortCommit: "a4e3b72",
            dirty: false,
            builtAt: "2026-10-02T08:00:00.000Z",
        });
    });

    it("marks a tree with uncommitted changes and takes the channel from the environment", () => {
        const info = makeMoltentermBuildInfo(
            { MOLTENTERM_BUILD_CHANNEL: "release" },
            fakeGit({
                "rev-parse HEAD": "bf031b0aaaa",
                "rev-parse --abbrev-ref HEAD": "main",
                "status --porcelain --untracked-files=no": " M frontend/wave.ts",
            }),
            now
        );
        expect(info).toMatchObject({ channel: "release", shortCommit: "bf031b0", dirty: true });
    });

    it("works outside a git checkout", () => {
        const info = makeMoltentermBuildInfo({}, fakeGit({}), now);
        expect(info).toMatchObject({ branch: "", commit: "", shortCommit: "", dirty: false, channel: "local" });
    });
});
