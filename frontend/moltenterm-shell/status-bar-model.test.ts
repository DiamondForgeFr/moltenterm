// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    blockFolder,
    keepPaneState,
    makePaneView,
    makeStatusBarView,
    PaneState,
    statusBarFolder,
} from "./status-bar-model";

const build = {
    channel: "local",
    version: "1.0.0-0",
    branch: "develop",
    commit: "a4e3b72d9f00",
    shortCommit: "a4e3b72",
    dirty: true,
    builtAt: "2026-10-02T08:00:00.000Z",
    buildId: 1790928000,
    releaseTag: "",
    changesSinceRelease: 812,
};

function workspace(meta: Record<string, any>): Workspace {
    return { oid: "ws1", name: "Moltenterm", meta } as Workspace;
}

const linkedWs = workspace({ "molten:project": "/code/molten", "molten:folder": "/code/molten/pkg" });

describe("makeStatusBarView", () => {
    it("names a local build by its channel only: its version goes to the tooltip (#187)", () => {
        expect(makeStatusBarView(build, { isDev: false, version: "1.0.0-0" })).toMatchObject({
            channel: "local",
            channelLabel: "local build",
            badge: "local build",
            version: "1.0.0-0",
        });
    });

    it("says dev under the dev server, whatever the build says", () => {
        expect(makeStatusBarView({ ...build, channel: "public" }, { isDev: true, version: "x" }).badge).toBe("dev");
    });

    it("lets the launcher mark a gold copy", () => {
        expect(makeStatusBarView(build, { isDev: false, runtimeChannel: "gold", version: "1.0.0-0" }).badge).toBe(
            "Gold"
        );
    });

    it("shows the version of a release candidate or a public release", () => {
        const rc = { ...build, channel: "rc", version: "1.0.0-3", releaseTag: "v1.0.0-3", changesSinceRelease: 0 };
        expect(makeStatusBarView(rc, { isDev: false, version: "1.0.0-3" })).toMatchObject({
            channel: "rc",
            badge: "1.0.0-3",
        });
        expect(makeStatusBarView({ ...rc, channel: "public" }, { isDev: false, version: "1.0.0" }).badge).toBe("1.0.0");
    });

    it("keeps the version, the Wave base, the build line, the build time and the commit in the tooltip", () => {
        const view = makeStatusBarView(
            { ...build, releaseTag: "v1.0.0-2", changesSinceRelease: 3 },
            { isDev: false, runtimeChannel: "gold", version: "1.0.0-0" }
        );
        expect(view.tooltip).toBe(
            [
                "MoltenTerm 1.0.0-0, based on Wave Terminal 0.14.5",
                "Gold · build 1790928000 · 3 changes since v1.0.0-2",
                "built 2026-10-02T08:00:00.000Z",
                "commit a4e3b72 on develop (uncommitted changes)",
            ].join("\n")
        );
    });

    it("copes with a build without facts and an unknown channel", () => {
        expect(makeStatusBarView(null, { isDev: false, runtimeChannel: "weird", version: "1" })).toMatchObject({
            channel: "local",
            badge: "local build",
            tooltip: "MoltenTerm 1, based on Wave Terminal 0.14.5\nlocal build",
        });
    });
});

describe("blockFolder", () => {
    it("takes a local terminal's most recent folder", () => {
        expect(blockFolder({ view: "term", "cmd:cwd": "/code/other/src/" })).toBe("/code/other/src");
        expect(blockFolder({ view: "term", connection: "local", "cmd:cwd": "/" })).toBe("/");
    });

    it("has none for other views, remote terminals and terminals that did not report", () => {
        expect(blockFolder({ view: "web", "cmd:cwd": "/code" })).toBe("");
        expect(blockFolder({ view: "sysinfo" })).toBe("");
        expect(blockFolder({ view: "term", connection: "user@host", "cmd:cwd": "/srv" })).toBe("");
        expect(blockFolder({ view: "term" })).toBe("");
        expect(blockFolder({ view: "term", "cmd:cwd": "~/code" })).toBe("");
        expect(blockFolder(null)).toBe("");
    });
});

describe("statusBarFolder", () => {
    it("follows the focused terminal", () => {
        expect(statusBarFolder({ view: "term", "cmd:cwd": "/code/other" }, linkedWs)).toEqual({
            folder: "/code/other",
            fromPane: true,
        });
    });

    it("falls back to the workspace's folder for a pane without one", () => {
        expect(statusBarFolder({ view: "web" }, linkedWs)).toEqual({ folder: "/code/molten/pkg", fromPane: false });
        expect(statusBarFolder(null, linkedWs).folder).toBe("/code/molten/pkg");
    });

    it("falls back to the linked project when the workspace folder is outside it or unset", () => {
        expect(statusBarFolder(null, workspace({ "molten:project": "/code/molten" })).folder).toBe("/code/molten");
        expect(
            statusBarFolder(null, workspace({ "molten:project": "/code/molten", "molten:folder": "/tmp" })).folder
        ).toBe("/code/molten");
    });

    it("has nothing for a workspace without folder or project", () => {
        expect(statusBarFolder({ view: "web" }, workspace({})).folder).toBe("");
    });
});

const devState: PaneState = {
    dir: "/code/molten/.claude/worktrees/a",
    root: "/code/molten/.claude/worktrees/a",
    project: "/code/molten",
    name: "moltenterm",
    branch: "feature/108-status",
    sha: "4f2a9c0d11",
    upstream: "origin/feature/108-status",
    ahead: 2,
    behind: 0,
    dirty: true,
    ci: "failure",
    pr: { number: 112, title: "Status bar", url: "https://github.com/x/y/pull/112" },
};

describe("makePaneView", () => {
    it("shows the pane's project, branch, markers, CI verdict and pull request", () => {
        const view = makePaneView(devState.dir, devState, linkedWs);
        expect(view).toMatchObject({
            linked: true,
            projectName: "moltenterm",
            branch: "feature/108-status",
            ahead: 2,
            dirty: true,
            pr: { number: 112 },
        });
        expect(view.ci).toMatchObject({ status: "failure", label: "CI failed" });
        expect(view.branchTitle).toBe(
            "feature/108-status at 4f2a9c0\n2 ahead, 0 behind origin/feature/108-status\nuncommitted changes\nOpen the Project tab"
        );
    });

    it("names another repository after itself, not after the workspace", () => {
        const other: PaneState = {
            dir: "/code/other",
            root: "/code/other",
            project: "/code/other",
            name: "other",
            branch: "main",
            sha: "1",
        };
        const view = makePaneView("/code/other", other, linkedWs);
        expect(view).toMatchObject({ linked: false, projectName: "other", branch: "main", ci: null, pr: null });
    });

    it("shows a detached head by its commit and counts commits no remote has", () => {
        const view = makePaneView(
            "/r",
            { dir: "/r", root: "/r", project: "/r", detached: true, sha: "abcdef1234", ahead: 3 },
            workspace({})
        );
        expect(view.branch).toBe("detached at abcdef1");
        expect(view.branchTitle).toBe(
            "detached at abcdef1\non no branch\n3 commits on no remote\nOpen the Project tab"
        );
    });

    it("names the branch a detached head stands for, with its pull request (#961)", () => {
        const pr = { number: 109, title: "Loader", url: "u109" };
        const view = makePaneView(
            "/r",
            {
                dir: "/r",
                root: "/r",
                project: "/r",
                detached: true,
                sha: "abcdef1234",
                detachedbranch: "feature/109-loader",
                prknown: true,
                pr,
            },
            workspace({})
        );
        expect(view.branch).toBe("detached at feature/109-loader");
        expect(view.branchTitle).toBe("detached at abcdef1\nOpen the Project tab");
        expect(view.pr).toEqual(pr);
    });

    it("says a branch has no pull request yet only when the open ones are known (#961)", () => {
        const state: PaneState = { dir: "/r", root: "/r", project: "/r", branch: "feature/7-x", sha: "abcdef1234" };
        expect(makePaneView("/r", { ...state, prknown: true }, workspace({})).branchTitle).toBe(
            "feature/7-x at abcdef1\nNo pull request yet\nOpen the Project tab"
        );
        expect(makePaneView("/r", state, workspace({})).branchTitle).toBe(
            "feature/7-x at abcdef1\nOpen the Project tab"
        );
        const onNoBranch = makePaneView(
            "/r",
            { dir: "/r", root: "/r", project: "/r", detached: true, sha: "abcdef1234", prknown: true },
            workspace({})
        );
        expect(onNoBranch.branchTitle).toBe("detached at abcdef1\non no branch\nOpen the Project tab");
    });

    it("says which repository below the folder it describes (#961)", () => {
        const view = makePaneView(
            "/p",
            {
                dir: "/p",
                root: "/p/diamondforge",
                project: "/p/diamondforge",
                name: "diamondforge",
                branch: "develop",
                sha: "abcdef1234",
                below: true,
            },
            workspace({})
        );
        expect(view.projectName).toBe("diamondforge");
        expect(view.branch).toBe("develop");
        expect(view.projectTitle).toBe("diamondforge\nRepository in the subfolder diamondforge\n/p");
    });

    it("shows the workspace project while the answer is on its way", () => {
        expect(makePaneView("/code/molten/pkg", null, linkedWs)).toMatchObject({
            linked: true,
            projectName: "molten",
            branch: "",
            ahead: 0,
            dirty: false,
            ci: null,
        });
    });

    it("hides the verdict of a project without local CI", () => {
        expect(makePaneView("/r", { dir: "/r", root: "/r", branch: "main", sha: "1" }, workspace({})).ci).toBeNull();
    });

    it("says nothing of CI until a run exists on this code (FR-SHELL-055 AC5)", () => {
        const state = { dir: "/r", root: "/r", branch: "main", sha: "1", ci: "missing" };
        expect(makePaneView("/r", state, workspace({})).ci).toBeNull();
        expect(makePaneView("/r", { ...state, ci: "running" }, workspace({})).ci).toMatchObject({
            label: "CI running",
        });
    });
});

describe("keepPaneState", () => {
    it("keeps the answer while the pane moves inside the same tree", () => {
        expect(keepPaneState(devState, devState.dir + "/frontend")).toBe(devState);
    });

    it("drops it for another tree or no folder", () => {
        expect(keepPaneState(devState, "/code/other")).toBeNull();
        expect(keepPaneState(devState, "")).toBeNull();
        expect(keepPaneState(null, "/code/other")).toBeNull();
    });
});
