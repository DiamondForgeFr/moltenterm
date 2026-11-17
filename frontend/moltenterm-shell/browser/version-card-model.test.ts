// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The version card (FR-BRW-017 AC7 to AC10, #2326): where you are, the versions of the project with the current one,
// the port and address another version opens at, the test asked or not, and the pull request's state read as the
// Integration panel reads it. Synthetic projects and branches only.

import { describe, expect, it } from "vitest";
import { EmptyAgentStates } from "../agent-state-model";
import { wordPhrase } from "../i18n/phrase";
import { cardState } from "../reviews/reviews-card-model";
import type { ReviewCheck, ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import { type CardContext, cardInputOf } from "../reviews/reviews-sections-model";
import type { UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import type { TestContextAnswer } from "./test-context-model";
import {
    agentNames,
    prGlance,
    type ProjectFacts,
    prViewOf,
    type ServedVersion,
    type ServedVersions,
    serverFor,
    stopOutcomePhrase,
    switchUrl,
    testAskOf,
    versionCardData,
    waitsForTest,
} from "./version-card-model";

const t = (key: string, vars?: Record<string, string | number>) =>
    vars == null ? key : `${key}${JSON.stringify(vars)}`;

const Now = 10 * 3_600_000;
const Dir = "/w/shop";

function reviewPr(number: number, over: Partial<ReviewPr> = {}, checks: ReviewCheck[] = []): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://example.test/acme/shop/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: { state: "success", success: checks.length, failure: 0, pending: 0, checks },
        report: { state: "present" },
        unpublished: 0,
        ...over,
    };
}

const DraftA = reviewPr(110, { branch: "feature/1-a", draft: true, ticket: 1, tickettitle: "Loader on the home page" });

const Upcoming: UpcomingAnswer = {
    dir: Dir,
    branches: [{ branch: "feature/2-b", ticket: 2, ahead: 3, title: "Basket total" }],
    agents: [
        { branch: "feature/1-a", worktree: "/w/shop-wt/a", kind: "background", signed: true, firstname: "Olivia" },
        { branch: "feature/2-b", worktree: "/w/shop-wt/b", kind: "background", signed: true, firstname: "Arthur" },
    ],
    drafts: [{ branch: "feature/1-a", ticket: 1, status: "Human Testing" }],
    humantesting: "yes",
    at: Now,
};

function ctx(upcoming: UpcomingAnswer = Upcoming): CardContext {
    return { upcoming, states: EmptyAgentStates, now: Now, boardText: (s) => s };
}

function project(answer: Partial<ReviewsAnswer> = {}, upcoming: UpcomingAnswer = Upcoming): ProjectFacts {
    return {
        dir: Dir,
        answer: { dir: Dir, state: "ok", ready: [], drafts: [DraftA], ...answer },
        ctx: ctx(upcoming),
    };
}

const VersionA: ServedVersion = {
    root: "/w/shop-wt/a",
    project: "/w/shop",
    name: "shop",
    worktree: true,
    branch: "feature/1-a",
    dirty: true,
    ticket: 1,
    pr: { number: 110, title: "PR 110", url: "u110", draft: true },
    projectdir: Dir,
    linked: true,
    servers: [
        { port: 5173, pid: 41, process: "node" },
        { port: 5174, pid: 41, process: "node" },
    ],
};

const VersionB: ServedVersion = {
    root: "/w/shop-wt/b",
    project: "/w/shop",
    name: "shop",
    worktree: true,
    branch: "feature/2-b",
    ticket: 2,
    futurepr: true,
    projectdir: Dir,
    linked: true,
    servers: [
        { port: 5180, pid: 52, process: "node" },
        { port: 5181, pid: 52, process: "node" },
        { port: 9229, pid: 53, process: "inspector" },
    ],
};

const Main: ServedVersion = {
    root: "/w/shop",
    project: "/w/shop",
    name: "shop",
    branch: "develop",
    projectdir: Dir,
    linked: true,
    servers: [{ port: 3000, pid: 60, process: "python3" }],
};

const Other: ServedVersion = {
    root: "/w/blog",
    project: "/w/blog",
    name: "blog",
    branch: "main",
    servers: [{ port: 4000, pid: 70, process: "ruby" }],
};

const Served: ServedVersions = { versions: [Main, VersionA, VersionB, Other], at: Now };

const Answer: TestContextAnswer = {
    url: "http://localhost:5174/basket?step=2#total",
    host: "localhost",
    port: 5174,
    known: true,
    pid: 41,
    process: "node",
    cwd: "/w/shop-wt/a",
    root: "/w/shop-wt/a",
    project: "/w/shop",
    name: "shop",
    worktree: true,
    branch: "feature/1-a",
    sha: "4f2a9c0d11aa",
    dirty: true,
    ticket: 1,
    pr: { number: 110, title: "PR 110", url: "u110", draft: true },
    prknown: true,
    sameproject: true,
    steps: ["Open the home page", "Wait for the loader"],
};

function input(over: Partial<Parameters<typeof versionCardData>[0]> = {}) {
    return { answer: Answer, served: Served, projects: [project()], asks: {}, now: Now, t, ...over };
}

describe("the versions of the project (AC7)", () => {
    it("shows where you are first, then the project's versions with the current one, other projects apart", () => {
        const data = versionCardData(input(), Dir);
        expect(data).toMatchObject({
            known: true,
            title: "Loader on the home page",
            ticket: 1,
            agents: ["Olivia"],
            branch: "feature/1-a",
            dirty: true,
            projectName: "shop",
        });
        expect(data.mine.map((l) => [l.branch, l.current, l.main])).toEqual([
            ["develop", false, true],
            ["feature/1-a", true, false],
            ["feature/2-b", false, false],
        ]);
        expect(data.others.map((l) => l.branch)).toEqual(["main"]);
        // Only a linked project's servers can be stopped: the others' stop would be refused, so it is not offered.
        expect(data.mine.map((l) => l.stoppable)).toEqual([true, true, true]);
        expect(data.others[0].stoppable).toBe(false);
        const b = data.mine[2];
        expect(b).toMatchObject({ title: "Basket total", agents: ["Arthur"], ticket: 2 });
        expect(b.server.port).toBe(5181);
        expect(b.url).toBe("http://localhost:5181/basket?step=2#total");
        expect(data.mine[1].server).toEqual({ port: 5174, pid: 41, process: "node" });
        expect(data.others[0].url).toBe("http://localhost:4000/");
    });

    it("shows the tab's version before wavesrv lists the servers", () => {
        const data = versionCardData(input({ served: null }), Dir);
        expect(data.mine).toHaveLength(1);
        expect(data.mine[0]).toMatchObject({ current: true, branch: "feature/1-a", server: { port: 5174, pid: 41 } });
    });

    it("keeps the project it showed once the tab's server stopped, and says why the source is unknown", () => {
        const stopped: TestContextAnswer = {
            url: Answer.url,
            host: "localhost",
            port: 5174,
            known: false,
            unknown: "noprocess",
        };
        const data = versionCardData(
            input({ answer: stopped, served: { versions: [Main, VersionB, Other], at: Now } }),
            Dir,
            "/w/shop"
        );
        expect(data.known).toBe(false);
        expect(data.reason).toContain("browser.testContext.reason.noProcess");
        expect(data.mine.map((l) => l.branch)).toEqual(["develop", "feature/2-b"]);
        expect(data.mine.some((l) => l.current)).toBe(false);
        expect(data.others.map((l) => l.branch)).toEqual(["main"]);
    });

    it("says when the servers cannot be listed", () => {
        expect(
            versionCardData(input({ served: { versions: [], unknown: "unreadable", at: Now } }), Dir).versionsUnknown
        ).toBe(true);
    });
});

describe("serverFor and switchUrl", () => {
    it("takes, among the other version's servers of the same program, the one at the tab port's rank", () => {
        expect(serverFor(VersionB, VersionA, 5173).port).toBe(5180);
        expect(serverFor(VersionB, VersionA, 5174).port).toBe(5181);
        expect(serverFor(Main, VersionA, 5174).port).toBe(3000);
        expect(serverFor({ ...VersionB, servers: [] }, VersionA, 5173)).toBeNull();
        expect(serverFor(VersionA, VersionA, 5174).port).toBe(5174);
    });

    it("keeps the path for the same project, opens another project's root", () => {
        expect(switchUrl("http://127.0.0.1:5173/a/b?x=1#y", 5180, true)).toBe("http://127.0.0.1:5180/a/b?x=1#y");
        expect(switchUrl("http://127.0.0.1:5173/a/b?x=1#y", 4000, false)).toBe("http://127.0.0.1:4000/");
        expect(switchUrl("not a url", 4000, true)).toBe("");
    });
});

describe("what to test (AC9)", () => {
    const steps = ["Open the page", "Click Start"];

    it("shows the steps when the ticket waits in Human Testing or the PR is ready for review", () => {
        expect(testAskOf({ number: 1, title: "", url: "", draft: true }, steps, true)).toEqual({
            steps,
            noSteps: false,
        });
        expect(testAskOf({ number: 1, title: "", url: "" }, steps, false)).toEqual({ steps, noSteps: false });
    });

    it("shows nothing when nothing is asked: a draft not at the developer's test, a merged PR, no PR", () => {
        expect(testAskOf({ number: 1, title: "", url: "", draft: true }, steps, false)).toBeNull();
        expect(testAskOf({ number: 1, title: "", url: "", merged: true }, steps, true)).toBeNull();
        expect(testAskOf(null, steps, false)).toBeNull();
        expect(testAskOf({ number: 1, title: "", url: "" }, [], false)).toBeNull();
    });

    it("says a test is asked without steps when the ticket waits for it", () => {
        expect(testAskOf({ number: 1, title: "", url: "", draft: true }, [], true)).toEqual({
            steps: [],
            noSteps: true,
        });
        expect(testAskOf(null, [], true)).toEqual({ steps: [], noSteps: true });
    });

    it("reads Human Testing as the Integration panel does", () => {
        expect(waitsForTest(Upcoming, "feature/1-a", Now)).toBe(true);
        expect(waitsForTest(Upcoming, "feature/2-b", Now)).toBe(false);
        expect(waitsForTest(null, "feature/1-a", Now)).toBe(false);
        expect(
            waitsForTest({ ...Upcoming, drafts: [{ branch: "feature/1-a", status: "In review" }] }, "feature/1-a", Now)
        ).toBe(false);
    });

    it("puts the PR's steps on the card only while the ticket waits for the test", () => {
        expect(versionCardData(input(), Dir).test).toEqual({ steps: Answer.steps, noSteps: false });
        const working = project(
            {},
            { ...Upcoming, drafts: [{ branch: "feature/1-a", ticket: 1, status: "In progress" }] }
        );
        expect(versionCardData(input({ projects: [working] }), Dir).test).toBeNull();
    });
});

describe("the pull request's state (AC10)", () => {
    it("is the Integration card's own state for a project of the workspace", () => {
        const view = prViewOf(VersionA, project(), {}, t);
        const card = cardState(cardInputOf(DraftA, undefined, ctx()));
        expect(view).toMatchObject({
            number: 110,
            tone: card.tone,
            sentence: wordPhrase(card.sentence),
            reviewsDir: Dir,
        });
        expect(view.sentence).not.toBe("");
    });

    it("follows the panel when the PR is ready and its CI fails", () => {
        const failing = reviewPr(110, { branch: "feature/1-a", draft: false, merge: "failing" }, [
            { name: "Backend", state: "failure" },
        ]);
        failing.ci = { state: "failure", success: 0, failure: 1, pending: 0, checks: failing.ci.checks };
        const p = project({ ready: [failing], drafts: [] }, { ...Upcoming, agents: [] });
        const card = cardState(cardInputOf(failing, undefined, p.ctx));
        expect(prViewOf(VersionA, p, {}, t)).toMatchObject({ tone: card.tone, sentence: wordPhrase(card.sentence) });
        expect(card.tone).toBe("broken");
    });

    it("says merged for a PR the panel lists as merged", () => {
        const p = project({
            drafts: [],
            merged: [{ number: 99, title: "Loader", url: "u99", branch: "feature/1-a", base: "develop", mergedat: "" }],
        });
        expect(prViewOf({ ...VersionA, pr: undefined }, p, {}, t)).toMatchObject({
            number: 99,
            tone: "merged",
            sentence: "browser.testContext.state.merged",
        });
    });

    it("reads the cached PR alone for a project the panel does not read", () => {
        const pr = { number: 7, title: "x", url: "u7" };
        expect(prGlance({ ...pr, merged: true }, t).tone).toBe("merged");
        expect(prGlance({ ...pr, ci: "failure", draft: true }, t)).toEqual({
            tone: "broken",
            sentence: "browser.testContext.state.ciFailing",
        });
        expect(prGlance({ ...pr, ci: "pending" }, t)).toEqual({
            tone: "running",
            sentence: "reviews.card.state.ciRunning",
        });
        expect(prGlance({ ...pr, draft: true }, t).sentence).toBe("browser.testContext.state.draft");
        expect(prGlance(pr, t).sentence).toBe("browser.testContext.state.ready");
        const view = prViewOf({ ...Other, pr: { ...pr, ci: "failure" } }, null, {}, t);
        expect(view).toMatchObject({ number: 7, tone: "broken" });
        expect(view.reviewsDir).toBeUndefined();
    });
});

describe("agents and stop outcomes", () => {
    it("names the agents on the branch by first name, once, never a session only passing by", () => {
        expect(
            agentNames([
                { kind: "panel", name: "Olivia", state: "working", since: 0 },
                { kind: "subagent", name: "", parentName: "Olivia", state: "background", since: 0 },
                { kind: "panel", name: "Arthur", state: "idle", since: 0, visiting: true },
                { kind: "background", name: "", state: "background", since: 0 },
            ])
        ).toEqual(["Olivia"]);
    });

    it("words what a stop did", () => {
        const data = versionCardData(input(), Dir);
        const current = data.mine[1];
        const other = data.mine[2];
        expect(stopOutcomePhrase({ stopped: [41] }, current)).toEqual({
            key: "browser.testContext.stop.doneCurrent",
            vars: { branch: "feature/1-a", port: 5174, folder: "", agent: "" },
        });
        expect(stopOutcomePhrase({ stopped: [52] }, other)).toMatchObject({ key: "browser.testContext.stop.done" });
        expect(stopOutcomePhrase({ stopped: [52], still: true }, other)).toMatchObject({
            key: "browser.testContext.stop.still",
        });
        expect(stopOutcomePhrase({ stopped: [], refused: "unknownproject", folder: "/w/x" }, other)).toMatchObject({
            key: "browser.testContext.stop.refused.unknownProject",
            vars: { folder: "/w/x" },
        });
        expect(stopOutcomePhrase({ stopped: [], refused: "agent", agent: "Claude Code" }, other)).toMatchObject({
            key: "browser.testContext.stop.refused.agent",
            vars: { agent: "Claude Code", port: 5181 },
        });
        expect(stopOutcomePhrase({ stopped: [], refused: "later" }, other)).toMatchObject({
            key: "browser.testContext.stop.refused.other",
        });
    });
});
