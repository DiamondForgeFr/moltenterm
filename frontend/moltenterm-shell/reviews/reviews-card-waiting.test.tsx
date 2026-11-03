// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// #1841 (FR-REV-022 AC10, AC18): an Integration card says what a held draft waits on, and a lead counts as on a
// branch only for the work it does there. A draft whose PR, lead comment or ticket names an open #N reads "Waiting on
// #N · title" with Go to #N, calm; once #N is done it is back to its usual state. A lead whose session only passed
// through the PR's worktree is not "on it", and its line has no time.

import { getDefaultStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTestMatrix } from "../agent-info/agent-features-fixture";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { AgentBar, MinuteClock } from "./reviews-agent-bar";
import { cardState } from "./reviews-card-model";
import type { ReviewCheck, ReviewDependency, ReviewPr } from "./reviews-model";
import { CardContext, cardInputOf } from "./reviews-sections-model";
import type { BranchAgent, UpcomingAnswer } from "./reviews-upcoming-model";

setTestMatrix();

const Now = new Date(2026, 10, 3, 15, 10).getTime();
const Clock = MinuteClock.getInstance().nowAtom;
const PreviousNow = getDefaultStore().get(Clock);

beforeEach(() => getDefaultStore().set(Clock, Now));
afterEach(() => getDefaultStore().set(Clock, PreviousNow));

const Green: ReviewCheck[] = Array.from({ length: 7 }, (_, i) => ({ name: `Check ${i + 1}`, state: "success" }));

const Holds: ReviewDependency = {
    number: 1837,
    title: "A server never reaches this computer's SSH",
    url: "https://github.com/acme/app/pull/1837",
    kind: "pr",
    state: "open",
    from: "body",
};

// #1832's PR, a draft held until PR #1837 merges, signed by Arthur.
function heldPr(over: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number: 1840,
        ticket: 1832,
        title: "Terminal output stays in its workspace",
        url: "https://github.com/acme/app/pull/1840",
        branch: "fix/1832-term-output",
        base: "develop",
        headoid: "abc",
        draft: true,
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: { state: "success", success: Green.length, failure: 0, pending: 0, checks: Green },
        report: { state: "present" },
        unpublished: 0,
        agents: [{ firstname: "Arthur", agent: "claude" }],
        waitson: [Holds],
        ...over,
    };
}

function arthur(over: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return {
        blockid: "arthur",
        agent: "claude",
        firstname: "Arthur",
        state: "working",
        since: Now - 60_000,
        version: 1,
        ...over,
    };
}

function lead(over: Partial<BranchAgent> = {}): BranchAgent {
    return {
        branch: "fix/1832-term-output",
        worktree: "/w/1832",
        kind: "panel",
        blockid: "arthur",
        started: Now - 20 * 60_000,
        ...over,
    };
}

function ctx(info: AgentStateInfo, agents: BranchAgent[]): CardContext {
    const upcoming: UpcomingAnswer = { dir: "/p", branches: [], agents, drafts: [], humantesting: "no", at: Now };
    const states = { states: info != null ? { arthur: info } : {}, versions: {} } as AgentStatesData;
    return { upcoming, states, now: Now, boardText: (s) => s };
}

function card(c: CardContext, pr = heldPr()) {
    const input = cardInputOf(pr, null, c);
    return { input, card: cardState(input) };
}

describe("a draft held until another PR merges (#1841)", () => {
    it("says what it waits on, with Go to #N, calm", () => {
        const { card: s } = card(ctx(null, []));
        expect(s.kind).toBe("waiting-on");
        expect(s.turn).toBe("agents");
        expect(s.tone).toBe("wait");
        expect(s.sentence).toEqual({
            key: "reviews.card.state.waitingOn",
            vars: { number: 1837, title: Holds.title },
        });
        expect(s.why).toEqual({ key: "reviews.card.why.waitsOn.body", vars: { number: 1837 } });
        expect(s.primary?.id).toBe("go-to-pr");
        expect(s.primary?.target).toEqual(Holds);
        expect(s.primary?.label).toEqual({ key: "reviews.card.action.goTo", vars: { number: 1837 } });
        expect([s.molten, s.works, s.motion]).toEqual([false, false, null]);
    });

    it("never reads as finished and waiting to be marked ready while it is held", () => {
        const done = arthur({ state: "done" });
        const { card: s } = card(ctx(done, [lead()]));
        expect(s.kind).toBe("waiting-on");
        expect(s.sentence).not.toMatchObject({ key: "reviews.card.state.agentDone" });
    });

    it("names the others it waits on as a fact", () => {
        const other: ReviewDependency = { number: 1844, state: "open", from: "relation", kind: "issue" };
        const { card: s } = card(ctx(null, []), heldPr({ waitson: [Holds, other] }));
        expect(s.facts.find((f) => f.id === "waits")?.text).toEqual({
            key: "reviews.card.fact.alsoWaitsOn",
            vars: { numbers: "#1844" },
        });
    });

    it("is back to its usual state once what it waits on is done", () => {
        const done = arthur({ state: "done" });
        const merged = heldPr({ waitson: [{ ...Holds, state: "merged" }] });
        expect(card(ctx(done, [lead()]), merged).card.kind).toBe("agent-finish");
        expect(card(ctx(done, [lead()]), heldPr({ waitson: undefined })).card.sentence).toEqual({
            key: "reviews.card.state.agentDone",
            vars: { name: { key: "reviews.card.name", vars: { name: "Arthur" } } },
        });
    });

    it("lets an agent at work on the branch say so first", () => {
        expect(card(ctx(arthur(), [lead()])).card.kind).toBe("agent-working");
        expect(card(ctx(arthur({ state: "waiting" }), [lead()])).card.kind).toBe("agent-waiting");
    });

    it("leaves a ready PR as it is", () => {
        expect(card(ctx(null, []), heldPr({ draft: false })).card.kind).toBe("ready");
    });
});

describe("a lead only passing through the branch (#1841)", () => {
    it("is not on a ready PR it only ran a command on", () => {
        const visiting = lead({ visiting: true, started: Now - 26 * 3_600_000 });
        const { input, card: s } = card(ctx(arthur(), [visiting]), heldPr({ draft: false, waitson: undefined }));
        expect(s.kind).toBe("ready");
        expect([s.works, s.motion]).toEqual([false, null]);
        const facts = input.agents[0];
        expect([facts.state, facts.visiting]).toEqual(["idle", true]);
        const html = renderToStaticMarkup(<AgentBar facts={facts} stacked />);
        expect(html).toMatch(/data-testid="reviews-agent-state"[^>]*>only passed through</);
        expect(html).not.toContain("df-domino-loader");
        expect(html).not.toContain('data-testid="reviews-agent-time"');
        expect(html).not.toMatch(/\b1 d\b|day/);
    });

    it("leaves a draft it only passed through to its usual state", () => {
        const visiting = lead({ visiting: true });
        const { card: s } = card(ctx(arthur(), [visiting]), heldPr({ waitson: undefined }));
        expect(s.kind).toBe("agent-finish");
        expect(s.works).toBe(false);
    });

    it("keeps a lead that works there on it, since it came", () => {
        const { input, card: s } = card(ctx(arthur(), [lead()]), heldPr({ draft: false, waitson: undefined }));
        expect(s.kind).toBe("agent-working");
        expect(input.agents[0].since).toBe(Now - 20 * 60_000);
    });
});
