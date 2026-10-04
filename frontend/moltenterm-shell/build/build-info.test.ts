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

function fakeFiles(files: Record<string, string>) {
    return (path: string) => {
        if (!(path in files)) {
            throw new Error("ENOENT");
        }
        return files[path];
    };
}

const now = new Date("2026-10-02T08:00:00Z");

const project = fakeFiles({
    "package.json": `{"name": "moltenterm", "version": "1.0.0-0"}`,
    ".molten/project.json": `{"schema": 1, "versions": {"tagprefix": "v", "firstpublic": "1.0.0"}}`,
});

describe("makeMoltentermBuildInfo", () => {
    it("reads version, branch, commit and a clean tree", () => {
        const info = makeMoltentermBuildInfo(
            {},
            fakeGit({
                "rev-parse HEAD": "a4e3b72d9f00112233445566778899aabbccddee",
                "rev-parse --abbrev-ref HEAD": "develop",
                "status --porcelain --untracked-files=no": "",
                "tag --merged HEAD -l v*": "v0.14.5\nv0.14.4",
                "rev-list --count HEAD": "812",
            }),
            now,
            project
        );
        expect(info).toEqual({
            channel: "local",
            version: "1.0.0-0",
            branch: "develop",
            commit: "a4e3b72d9f00112233445566778899aabbccddee",
            shortCommit: "a4e3b72",
            dirty: false,
            builtAt: "2026-10-02T08:00:00.000Z",
            buildId: 1790928000,
            releaseTag: "",
            changesSinceRelease: 812,
        });
    });

    it("counts the changes since the highest release the commit contains", () => {
        const info = makeMoltentermBuildInfo(
            { MOLTENTERM_BUILD_CHANNEL: "gold" },
            fakeGit({
                "rev-parse HEAD": "bf031b0aaaa",
                "rev-parse --abbrev-ref HEAD": "develop",
                "status --porcelain --untracked-files=no": "",
                "tag --merged HEAD -l v*": "v1.0.0-2\nv1.0.0-10\nv0.14.5\nv1.0.0-rc.11",
                "rev-list --count v1.0.0-10..HEAD": "3",
            }),
            now,
            project
        );
        expect(info).toMatchObject({ channel: "gold", releaseTag: "v1.0.0-10", changesSinceRelease: 3 });
    });

    it("marks a tree with uncommitted changes and takes the channel from the environment", () => {
        const info = makeMoltentermBuildInfo(
            { MOLTENTERM_BUILD_CHANNEL: "rc" },
            fakeGit({
                "rev-parse HEAD": "bf031b0aaaa",
                "rev-parse --abbrev-ref HEAD": "main",
                "status --porcelain --untracked-files=no": " M frontend/wave.ts",
            }),
            now,
            project
        );
        expect(info).toMatchObject({ channel: "rc", shortCommit: "bf031b0", dirty: true, changesSinceRelease: -1 });
    });

    it("works outside a git checkout and without the project files", () => {
        const info = makeMoltentermBuildInfo({}, fakeGit({}), now, fakeFiles({}));
        expect(info).toMatchObject({
            branch: "",
            commit: "",
            shortCommit: "",
            dirty: false,
            channel: "local",
            version: "",
            releaseTag: "",
            changesSinceRelease: -1,
        });
    });

    it("takes the build id from the gold delivery", () => {
        expect(makeMoltentermBuildInfo({ MOLTENTERM_BUILD_ID: "1790930000" }, fakeGit({}), now, project).buildId).toBe(
            1790930000
        );
        expect(makeMoltentermBuildInfo({ MOLTENTERM_BUILD_ID: "x" }, fakeGit({}), now, project).buildId).toBe(1790928000);
    });
});
