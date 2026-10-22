// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import {
    emptyLaunchRecipe,
    launchBackOffered,
    launchIsOf,
    LaunchPlan,
    launchPlanLines,
    launchRecipeDraft,
    launchRecipeProblem,
    launchRecipeUrl,
    LaunchState,
    launchStatusText,
    launchStepTitle,
    launchTargetOfBranch,
    launchTargetOfPr,
    launchUrlToOpen,
    parsePort,
} from "./reviews-launch-model";
import type { ReviewPr } from "./reviews-model";

function state(extra: Partial<LaunchState> = {}): LaunchState {
    return {
        dir: "/p",
        id: "l1",
        target: { kind: "pr", number: 12, branch: "feature/12-x" },
        servedir: "/p",
        state: "running",
        steps: [
            { id: "checkout", kind: "checkout", state: "done" },
            { id: "prepare-install", kind: "prepare", state: "done" },
            { id: "prepare-migrate-api", kind: "prepare", state: "done" },
            { id: "server-web", kind: "server", port: 5173, state: "done" },
        ],
        url: "http://localhost:5173",
        startedat: 1,
        ...extra,
    };
}

const pr = {
    number: 12,
    branch: "feature/12-x",
    title: "PR title",
    tickettitle: "Ticket title",
    headoid: "abc",
} as ReviewPr;

describe("launch targets (FR-REV-031 AC1)", () => {
    it("names a PR card, an Upcoming card and the running version's own card", () => {
        expect(launchTargetOfPr(pr)).toEqual({
            kind: "pr",
            number: 12,
            branch: "feature/12-x",
            title: "Ticket title",
            headoid: "abc",
        });
        const branch = launchTargetOfBranch({ branch: "feature/13-y", ticket: 13, ahead: 1, title: "Y" });
        expect(branch).toEqual({ kind: "branch", branch: "feature/13-y", title: "Y" });
        expect(launchIsOf(state(), launchTargetOfPr(pr))).toBe(true);
        expect(launchIsOf(state(), { kind: "pr", number: 13, branch: "feature/13-y" })).toBe(false);
        expect(launchIsOf(state(), branch)).toBe(false);
        expect(launchIsOf(state({ target: { kind: "branch", branch: "feature/13-y" } }), branch)).toBe(true);
        expect(launchIsOf(null, branch)).toBe(false);
    });
});

describe("launch bar text (FR-REV-031 AC5)", () => {
    it("names each step, with the known ones worded", () => {
        expect(launchStepTitle(t, { id: "checkout", kind: "checkout", state: "done" })).toBe("Check out");
        expect(launchStepTitle(t, { id: "prepare-install", kind: "prepare", state: "done" })).toBe(
            "Install dependencies"
        );
        expect(launchStepTitle(t, { id: "prepare-migrate-api", kind: "prepare", state: "done" })).toBe("Migrate api");
        expect(launchStepTitle(t, { id: "prepare-seed", kind: "prepare", state: "done" })).toBe("seed");
        expect(launchStepTitle(t, { id: "server-web", kind: "server", port: 5173, state: "done" })).toBe(
            "web server (:5173)"
        );
        expect(launchStepTitle(t, { id: "server-web", kind: "server", title: "Web app", state: "done" })).toBe(
            "Web app"
        );
    });

    it("says what runs, what starts and which step failed", () => {
        expect(launchStatusText(t, state())).toBe("PR #12 is running here");
        const starting = state({
            state: "starting",
            steps: [{ id: "prepare-migrate-api", kind: "prepare", state: "running" }],
        });
        expect(launchStatusText(t, starting)).toBe("Starting PR #12: Migrate api…");
        const failed = state({
            state: "failed",
            steps: [{ id: "prepare-migrate-api", kind: "prepare", state: "failed" }],
        });
        expect(launchStatusText(t, failed)).toBe("PR #12: Migrate api failed");
        expect(launchStatusText(t, state({ target: { kind: "trunk", branch: "develop" } }))).toBe(
            "develop is running here"
        );
    });
});

describe("Back to the trunk (FR-REV-031 AC6)", () => {
    it("is offered once the launched PR is merged, never while it starts", () => {
        expect(launchBackOffered(state(), [11])).toBe(false);
        expect(launchBackOffered(state(), [12])).toBe(true);
        expect(launchBackOffered(state({ state: "failed" }), [12])).toBe(true);
        expect(launchBackOffered(state({ state: "starting" }), [12])).toBe(false);
        expect(launchBackOffered(state({ target: { kind: "branch", branch: "feature/12-x" } }), [12])).toBe(false);
        expect(launchBackOffered(null, [12])).toBe(false);
    });
});

function plan(extra: Partial<LaunchPlan> = {}): LaunchPlan {
    return {
        dir: "/p",
        servedir: "/p",
        branch: "develop",
        commit: "abc1234",
        dirty: [],
        dirtycount: 0,
        holders: [],
        recipe: {
            where: "main",
            prepare: [
                { id: "install", run: "npm install" },
                { id: "migrate-api", run: "npm run db:update:dev -w apps/api" },
            ],
            servers: [
                { id: "api", run: "npm run dev -w apps/api", port: 3500 },
                { id: "web", run: "npm run dev -w apps/web", port: 5173 },
            ],
            url: "http://localhost:5173",
        },
        ...extra,
    };
}

describe("launch confirmation (FR-REV-031 AC2, AC3)", () => {
    const target = launchTargetOfPr(pr);

    it("names the switch, the steps and the page", () => {
        const lines = launchPlanLines(t, plan(), target).map((line) => line.text);
        expect(lines).toEqual([
            "Switches /p from develop to PR #12, detached at its head.",
            "Then runs: Install dependencies, Migrate api.",
            "Starts: api server (:3500), web server (:5173).",
            "Opens http://localhost:5173 in the browser once ready.",
        ]);
    });

    it("names the running version and the processes it stops first", () => {
        const running = state({ target: { kind: "branch", branch: "feature/9-z" } });
        const lines = launchPlanLines(
            t,
            plan({ running, holders: [{ port: 3500, pid: 42, name: "node" }, { port: 5173 }] }),
            target
        );
        expect(lines.slice(0, 3).map((line) => [line.text, line.tone])).toEqual([
            ["Stops the running version: feature/9-z.", "warning"],
            ["Stops node (process 42) listening on port 3500.", "warning"],
            ["Port 5173 is busy and its process is unknown: the launch may fail.", "warning"],
        ]);
    });

    it("says a worktree is served as it is, a detached checkout by its commit, and the trunk is pulled", () => {
        expect(launchPlanLines(t, plan({ worktree: true, servedir: "/wt" }), target)[0].text).toBe(
            "Serves the branch's worktree /wt as it is."
        );
        expect(launchPlanLines(t, plan({ branch: "" }), target)[0].text).toBe(
            "Switches /p from the detached commit abc1234 to PR #12, detached at its head."
        );
        expect(launchPlanLines(t, plan(), { kind: "trunk" }, "develop")[0].text).toBe(
            "Checks out develop in /p and pulls it."
        );
    });
});

describe("launch recipe dialog (FR-REV-031 AC4)", () => {
    it("starts from the saved recipe, else the proposal, else an empty server", () => {
        const saved = plan().recipe;
        expect(launchRecipeDraft({ dir: "/p", saved, proposal: emptyLaunchRecipe() }).servers).toHaveLength(2);
        expect(launchRecipeDraft({ dir: "/p", proposal: saved, proposalfrom: "detected" }).prepare[1].run).toBe(
            "npm run db:update:dev -w apps/api"
        );
        expect(launchRecipeDraft({ dir: "/p" })).toEqual(emptyLaunchRecipe());
    });

    it("refuses what wavesrv would refuse", () => {
        expect(launchRecipeProblem(t, emptyLaunchRecipe())).toBe("Add at least one server with its command.");
        const recipe = plan().recipe;
        expect(launchRecipeProblem(t, recipe)).toBe("");
        expect(launchRecipeProblem(t, { ...recipe, servers: [{ id: "a", run: "x", port: 70000 }] })).toBe(
            "70000 is not a port (1 to 65535)."
        );
        expect(launchRecipeProblem(t, { ...recipe, servers: [{ id: "a", run: "x", port: NaN }] })).toBe(
            "NaN is not a port (1 to 65535)."
        );
        expect(
            launchRecipeProblem(t, {
                ...recipe,
                servers: [
                    { id: "a", run: "x", port: 80 },
                    { id: "b", run: "y", port: 80 },
                ],
            })
        ).toBe("Port 80 is used twice.");
        expect(launchRecipeProblem(t, { ...recipe, prepare: [{ id: "a", run: "x", cwd: "../other" }] })).toBe(
            "The folder ../other leaves the project."
        );
        expect(launchRecipeProblem(t, { ...recipe, url: "localhost:5173" })).toBe(
            "The page must start with http:// or https://."
        );
    });

    it("reads ports and the page to open", () => {
        expect(parsePort(" 3500 ")).toBe(3500);
        expect(parsePort("")).toBeUndefined();
        expect(parsePort("abc")).toBeNaN();
        expect(
            launchRecipeUrl({
                prepare: [],
                servers: [
                    { id: "a", run: "x" },
                    { id: "b", run: "y", port: 3000 },
                ],
            })
        ).toBe("http://localhost:3000");
    });
});

describe("opening the browser (FR-REV-031 AC1)", () => {
    it("opens a launch this window started, once it runs, and only once", () => {
        const asked = new Set(["l1"]);
        expect(launchUrlToOpen(state({ state: "starting" }), asked, new Set())).toBe("");
        expect(launchUrlToOpen(state(), asked, new Set())).toBe("http://localhost:5173");
        expect(launchUrlToOpen(state(), asked, new Set(["l1"]))).toBe("");
        expect(launchUrlToOpen(state(), new Set(), new Set())).toBe("");
    });
});
