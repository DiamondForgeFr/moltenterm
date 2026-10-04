// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    hasDefaultName,
    nextProjectOffer,
    ProjectDismissedMetaKey,
    projectOfGitFile,
    readDismissed,
    withDismissed,
} from "./project-detect";

const unlinked = { dir: "", logo: "", logoOffer: "" };
const home = "/Users/a";

describe("nextProjectOffer", () => {
    it("offers to link the project a terminal entered, in a workspace without one", () => {
        expect(nextProjectOffer(unlinked, "/Users/a/p/notulia", [], home)).toEqual({
            mode: "link",
            dir: "/Users/a/p/notulia",
        });
    });

    it("stays quiet outside projects, at home, and after Not now", () => {
        expect(nextProjectOffer(unlinked, "", [], home)).toBeNull();
        expect(nextProjectOffer(unlinked, home, [], home)).toBeNull();
        expect(nextProjectOffer(unlinked, "/p", ["/p"], home)).toBeNull();
    });

    it("offers the icon once for a linked workspace that kept its own", () => {
        expect(nextProjectOffer({ dir: "/p", logo: "", logoOffer: "" }, "/other", [], home)).toEqual({
            mode: "logo",
            dir: "/p",
        });
        expect(nextProjectOffer({ dir: "/p", logo: "", logoOffer: "/p" }, "/other", [], home)).toBeNull();
        expect(nextProjectOffer({ dir: "/p", logo: "/p/icon.png", logoOffer: "" }, "/other", [], home)).toBeNull();
    });
});

describe("helpers", () => {
    it("remembers Not now per folder", () => {
        expect(readDismissed({ [ProjectDismissedMetaKey]: ["/a", 3] })).toEqual(["/a"]);
        expect(readDismissed(null)).toEqual([]);
        expect(withDismissed(["/a"], "/b")).toEqual(["/a", "/b"]);
        expect(withDismissed(["/a"], "/a")).toEqual(["/a"]);
    });

    it("recognises names given by default", () => {
        expect(hasDefaultName("New Workspace (eb533)")).toBe(true);
        expect(hasDefaultName("Starter workspace")).toBe(true);
        expect(hasDefaultName("")).toBe(true);
        expect(hasDefaultName("Notulia")).toBe(false);
    });
});

describe("projectOfGitFile", () => {
    it("offers the main checkout of a linked worktree, not the worktree", () => {
        expect(projectOfGitFile("/w/app-fix", "gitdir: /r/app/.git/worktrees/app-fix\n")).toBe("/r/app");
        expect(projectOfGitFile("/r/app/trees/fix", "gitdir: ../../.git/worktrees/fix")).toBe("/r/app");
    });

    it("keeps the folder of a submodule, a bare repository's worktree or an unreadable file", () => {
        expect(projectOfGitFile("/r/app/vendor/lib", "gitdir: ../../.git/modules/vendor/lib")).toBe(
            "/r/app/vendor/lib"
        );
        expect(projectOfGitFile("/w/fix", "gitdir: /r/app.git/worktrees/fix")).toBe("/w/fix");
        expect(projectOfGitFile("/w/fix", null)).toBe("/w/fix");
        expect(projectOfGitFile("/w/fix", "not a git file")).toBe("/w/fix");
    });

    it("is what the offer proposes when a terminal enters a worktree", () => {
        const project = projectOfGitFile("/w/app-fix", "gitdir: /r/app/.git/worktrees/app-fix");
        const unlinked = { dir: "", logo: "", logoOffer: "" } as any;
        expect(nextProjectOffer(unlinked, project, [], "/Users/me")).toEqual({ mode: "link", dir: "/r/app" });
        expect(nextProjectOffer(unlinked, project, ["/r/app"], "/Users/me")).toBeNull();
    });
});
