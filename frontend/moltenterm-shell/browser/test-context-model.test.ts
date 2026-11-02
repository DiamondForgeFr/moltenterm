// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { LaunchState } from "../reviews/reviews-launch-model";
import {
    branchText,
    chipView,
    detailRows,
    launchServesTarget,
    localAppTarget,
    prStateText,
    reasonText,
    reviewsTarget,
    targetKey,
    TestContextAnswer,
} from "./test-context-model";

const t = (key: string, vars?: Record<string, string | number>) =>
    vars == null ? key : `${key}${JSON.stringify(vars)}`;

const prBranch: TestContextAnswer = {
    url: "http://localhost:5173/",
    host: "localhost",
    port: 5173,
    known: true,
    pid: 812,
    process: "node",
    cwd: "/w/diamondforge/apps/web",
    root: "/w/diamondforge",
    project: "/w/diamondforge",
    name: "diamondforge",
    branch: "feature/109-suite-domino-loader",
    detached: true,
    sha: "4f2a9c0d11aa",
    dirty: true,
    ticket: 109,
    pr: { number: 110, title: "Domino loader", url: "https://github.com/o/r/pull/110", draft: true, ci: "failure" },
    prknown: true,
    sameproject: true,
};

describe("localAppTarget (FR-BRW-017)", () => {
    it("takes pages served on this computer, with the scheme's port by default", () => {
        expect(localAppTarget("http://localhost:5173/app?x=1")).toEqual({ host: "localhost", port: 5173 });
        expect(localAppTarget("http://127.0.0.1:3500")).toEqual({ host: "127.0.0.1", port: 3500 });
        expect(localAppTarget("http://[::1]:8080/")).toEqual({ host: "::1", port: 8080 });
        expect(localAppTarget("https://web.app.localhost/")).toEqual({ host: "web.app.localhost", port: 443 });
        expect(localAppTarget("http://notulia.test")).toEqual({ host: "notulia.test", port: 80 });
    });

    it("leaves every other page alone", () => {
        for (const url of [
            "https://github.com/o/r",
            "http://192.168.1.4:3000",
            "about:blank",
            "file:///x",
            "",
            "nope",
        ]) {
            expect(localAppTarget(url)).toBeNull();
        }
    });

    it("asks once per server, whatever the page", () => {
        expect(targetKey(localAppTarget("http://localhost:5173/a"))).toBe(
            targetKey(localAppTarget("http://localhost:5173/b"))
        );
        expect(targetKey(null)).toBe("");
    });
});

describe("chipView", () => {
    it("shows the branch and PR, the detached HEAD at its branch", () => {
        const view = chipView(prBranch, t);
        expect(view.tone).toBe("pr");
        expect(view.label).toBe('browser.testContext.detachedAt{"at":"feature/109-suite-domino-loader"} · #110');
    });

    it("says future PR for a branch without one, and source unknown with the reason", () => {
        const future = chipView({ ...prBranch, detached: false, pr: undefined, futurepr: true }, t);
        expect(future).toMatchObject({
            tone: "future",
            label: "feature/109-suite-domino-loader · browser.testContext.futurePr",
        });
        const unknown = chipView({ url: "", host: "localhost", port: 4000, known: false, unknown: "noprocess" }, t);
        expect(unknown.tone).toBe("unknown");
        expect(unknown.label).toBe("browser.testContext.unknown");
        expect(unknown.title).toContain("browser.testContext.reason.noProcess");
        expect(chipView(null, t)).toBeNull();
    });

    it("names a detached commit no branch points to by its short SHA", () => {
        expect(branchText({ ...prBranch, branch: "", detached: true }, t)).toBe(
            'browser.testContext.detachedAt{"at":"4f2a9c0"}'
        );
    });
});

describe("details", () => {
    it("lists the folder or worktree, branch, commit with its changes and the serving process", () => {
        const rows = detailRows({ ...prBranch, worktree: true }, t);
        expect(rows.map((r) => r.label)).toEqual([
            "browser.testContext.worktree",
            "browser.testContext.branch",
            "browser.testContext.commit",
            "browser.testContext.served",
        ]);
        expect(rows[0]).toMatchObject({ value: "diamondforge", title: "/w/diamondforge" });
        expect(rows[2].value).toBe('browser.testContext.commitDirty{"sha":"4f2a9c0"}');
    });

    it("says the PR's state, or why there is none", () => {
        expect(prStateText(prBranch, t)).toBe("browser.testContext.prDraft");
        expect(prStateText({ ...prBranch, pr: { ...prBranch.pr, draft: false } }, t)).toBe(
            "browser.testContext.prReady"
        );
        expect(prStateText({ ...prBranch, pr: undefined, futurepr: true }, t)).toBe("browser.testContext.futurePrHint");
        expect(prStateText({ ...prBranch, pr: undefined, prknown: false }, t)).toBe("browser.testContext.prUnknown");
        expect(prStateText({ ...prBranch, pr: undefined }, t)).toBe("browser.testContext.noPr");
    });

    it("explains each unknown source", () => {
        const base = { url: "", host: "localhost", port: 1, known: false };
        expect(reasonText({ ...base, unknown: "notlocal" }, t)).toBe("browser.testContext.reason.notLocal");
        expect(reasonText({ ...base, unknown: "nofolder", pid: 3 }, t)).toContain('"process":"3"');
        expect(reasonText({ ...base, unknown: "norepo", cwd: "/srv" }, t)).toContain("/srv");
    });
});

describe("reviewsTarget", () => {
    it("opens the PR's card, or a future PR's Upcoming entry, in the workspace's project only", () => {
        expect(reviewsTarget(prBranch, "/w/diamondforge")).toEqual({ dir: "/w/diamondforge", number: 110 });
        expect(reviewsTarget({ ...prBranch, pr: undefined, futurepr: true }, "/w/diamondforge")).toEqual({
            dir: "/w/diamondforge",
            branch: "feature/109-suite-domino-loader",
        });
        expect(reviewsTarget({ ...prBranch, pr: undefined, futurepr: true, ticket: 0 }, "/w/diamondforge")).toBeNull();
        expect(reviewsTarget({ ...prBranch, sameproject: false }, "/w/other")).toBeNull();
        expect(reviewsTarget({ ...prBranch, pr: undefined }, "/w/diamondforge")).toBeNull();
    });
});

describe("a Reviews Launch on the tab's port (#1003)", () => {
    const running = {
        dir: "/w/shop",
        id: "l1",
        target: { kind: "pr", number: 110, branch: "feature/109-loader" },
        servedir: "/w/shop",
        state: "running",
        steps: [{ id: "server-web", kind: "server", port: 5103, state: "running" }],
        url: "http://localhost:5103",
        startedat: 1,
    } as LaunchState;

    it("asks again once the launched version serves the tab", () => {
        expect(launchServesTarget(running, "localhost:5103")).toBe(true);
        expect(launchServesTarget({ ...running, url: "http://127.0.0.1:5173" }, "localhost:5103")).toBe(true);
    });

    it("ignores a launch still starting, another port, or no launch", () => {
        expect(launchServesTarget({ ...running, state: "starting" }, "localhost:5103")).toBe(false);
        expect(launchServesTarget(running, "localhost:3000")).toBe(false);
        expect(launchServesTarget(null, "localhost:5103")).toBe(false);
    });
});
