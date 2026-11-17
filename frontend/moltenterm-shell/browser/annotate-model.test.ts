// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The zones of the annotate mode and the agent they are proposed to (FR-BRW-017 AC12 to AC14, #2327). Synthetic
// projects, branches and agents only.

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { EmptyAgentStates } from "../agent-state-model";
import type { LeadFacts, ReviewPr } from "../reviews/reviews-model";
import type { AgentBarFacts, UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import {
    addZone,
    annotateRequest,
    annotateTargetOf,
    cancelEdit,
    clearAll,
    commentKeyAction,
    commitComment,
    dragRect,
    editZone,
    emptyState,
    eraseZone,
    fieldPlacement,
    gestureOf,
    layerKeyAction,
    MaxCommentChars,
    MaxZones,
    MinZonePx,
    recipientsOf,
    setComment,
    zoneAt,
    zoneNumber,
    zonesWire,
    type AnnotateState,
    type RecipientInput,
} from "./annotate-model";
import type { TestContextAnswer } from "./test-context-model";
import type { ProjectFacts } from "./version-card-model";

const Stage = { w: 1000, h: 600 };
const Box = { x: 0.1, y: 0.2, w: 0.3, h: 0.25 };

function drawn(...comments: string[]): AnnotateState {
    let state = emptyState();
    comments.forEach((comment, i) => {
        state = addZone(state, { ...Box, x: 0.05 * (i + 1) });
        state = setComment(state, state.editing.id, comment);
        state = commitComment(state, state.editing.id);
    });
    return state;
}

describe("drawing a zone", () => {
    it("makes a rectangle of the stage's fractions from two points, whichever way it is dragged", () => {
        expect(dragRect({ x: 100, y: 120 }, { x: 400, y: 270 }, Stage)).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.25 });
        expect(dragRect({ x: 400, y: 270 }, { x: 100, y: 120 }, Stage)).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.25 });
    });

    it("keeps the rectangle inside the stage", () => {
        const rect = dragRect({ x: 900, y: 500 }, { x: 1300, y: 900 }, Stage);
        expect(rect.x + rect.w).toBeCloseTo(1);
        expect(rect.y + rect.h).toBeCloseTo(1);
        const before = dragRect({ x: -50, y: -20 }, { x: 100, y: 60 }, Stage);
        expect(before.x).toBe(0);
        expect(before.y).toBe(0);
    });

    it("takes a drag shorter than a few pixels, in either direction, for a click", () => {
        expect(dragRect({ x: 10, y: 10 }, { x: 10 + MinZonePx - 1, y: 300 }, Stage)).toBeNull();
        expect(dragRect({ x: 10, y: 10 }, { x: 300, y: 10 + MinZonePx - 1 }, Stage)).toBeNull();
        expect(dragRect({ x: 10, y: 10 }, { x: 10 + MinZonePx, y: 10 + MinZonePx }, Stage)).not.toBeNull();
        expect(dragRect({ x: 10, y: 10 }, { x: 300, y: 300 }, { w: 0, h: 0 })).toBeNull();
    });

    it("opens the comment field of the new zone, numbered after the others", () => {
        const first = addZone(emptyState(), Box);
        expect(first.zones).toHaveLength(1);
        expect(first.editing).toEqual({ id: first.zones[0].id, fresh: true });
        const second = addZone(commitComment(first, first.zones[0].id), Box);
        expect(second.zones.map((z) => zoneNumber(second, z.id))).toEqual([1, 2]);
        expect(second.editing.id).toBe(second.zones[1].id);
    });

    it("holds at most the zones one report holds", () => {
        let state = emptyState();
        for (let i = 0; i < MaxZones + 3; i++) {
            state = commitComment(addZone(state, Box), state.editing?.id ?? 0);
        }
        expect(state.zones).toHaveLength(MaxZones);
    });
});

describe("the comment of a zone", () => {
    it("is typed in the open field, cut at the limit, and validated by Enter, which lets the next zone be drawn", () => {
        let state = addZone(emptyState(), Box);
        const id = state.editing.id;
        state = setComment(state, id, "x".repeat(MaxCommentChars + 50));
        expect(state.zones[0].comment).toHaveLength(MaxCommentChars);
        state = commitComment(state, id);
        expect(state.editing).toBeNull();
        expect(state.zones).toHaveLength(1);
    });

    it("drops a new zone whose comment is still empty on Escape", () => {
        const state = addZone(emptyState(), Box);
        const next = cancelEdit(state, state.editing.id);
        expect(next.zones).toEqual([]);
        expect(next.editing).toBeNull();
        expect(cancelEdit(setComment(state, state.editing.id, "   "), state.editing.id).zones).toEqual([]);
    });

    it("never loses what was typed to Escape: a new zone with text, and an edited one, keep it", () => {
        let state = addZone(emptyState(), Box);
        state = setComment(state, state.editing.id, "The title is cut.");
        state = cancelEdit(state, state.editing.id);
        expect(state.zones.map((z) => z.comment)).toEqual(["The title is cut."]);
        expect(state.editing).toBeNull();
        const edited = cancelEdit(editZone(state, state.zones[0].id), state.zones[0].id);
        expect(edited.zones[0].comment).toBe("The title is cut.");
    });

    it("keeps an empty comment validated by Enter: the zone alone says what to look at", () => {
        const state = addZone(emptyState(), Box);
        const next = commitComment(state, state.editing.id);
        expect(next.zones).toHaveLength(1);
    });

    it("reopens a zone to edit it, whichever it is", () => {
        const state = drawn("one", "two");
        const next = editZone(state, state.zones[0].id);
        expect(next.editing).toEqual({ id: state.zones[0].id, fresh: false });
        expect(editZone(state, 999)).toBe(state);
    });
});

describe("erasing zones", () => {
    it("renumbers the zones left, so the report always counts from 1", () => {
        let state = drawn("one", "two", "three");
        state = eraseZone(state, state.zones[0].id);
        expect(state.zones.map((z) => [zoneNumber(state, z.id), z.comment])).toEqual([
            [1, "two"],
            [2, "three"],
        ]);
        expect(zonesWire(state.zones)).toEqual([{ comment: "two" }, { comment: "three" }]);
    });

    it("closes the field of the zone erased, and only that one", () => {
        const state = drawn("one", "two");
        const editing = editZone(state, state.zones[1].id);
        expect(eraseZone(editing, state.zones[1].id).editing).toBeNull();
        expect(eraseZone(editing, state.zones[0].id).editing).toEqual(editing.editing);
    });

    it("clears every zone at once, field included", () => {
        const state = editZone(drawn("one", "two"), 1);
        const next = clearAll(state);
        expect(next.zones).toEqual([]);
        expect(next.editing).toBeNull();
        expect(addZone(next, Box).zones).toHaveLength(1);
    });
});

describe("a press and a release on the stage", () => {
    const state = drawn("one", "two");

    it("draws a zone when dragged, even from inside another one", () => {
        const g = gestureOf({ x: 120, y: 150 }, { x: 600, y: 400 }, Stage, state.zones);
        expect(g.kind).toBe("draw");
    });

    it("edits the zone clicked, the smaller of two on top of each other", () => {
        const inner = addZone(state, { x: 0.06, y: 0.21, w: 0.04, h: 0.05 });
        const g = gestureOf({ x: 70, y: 140 }, { x: 72, y: 141 }, Stage, inner.zones);
        expect(g).toEqual({ kind: "edit", id: inner.zones[2].id });
        expect(zoneAt(inner.zones, { x: 0.07, y: 0.22 }).id).toBe(inner.zones[2].id);
    });

    it("does nothing on a click outside every zone, or on a drag too thin to be one", () => {
        expect(gestureOf({ x: 900, y: 550 }, { x: 901, y: 551 }, Stage, state.zones).kind).toBe("none");
        expect(gestureOf({ x: 120, y: 150 }, { x: 420, y: 152 }, Stage, state.zones).kind).toBe("none");
    });
});

describe("the comment field's place", () => {
    const field = { w: 288, h: 150 };
    const inside = (p: { x: number; y: number }) =>
        p.x >= 0 && p.y >= 0 && p.x + field.w <= Stage.w && p.y + field.h <= Stage.h;

    it("is beside the zone, on its right when there is room", () => {
        const at = fieldPlacement({ x: 0.1, y: 0.2, w: 0.2, h: 0.2 }, Stage, field);
        expect(at.x).toBeGreaterThan(0.3 * Stage.w);
        expect(at.y).toBe(0.2 * Stage.h);
    });

    it("goes to the left, then under or over the zone, when the right has no room, and stays in the stage", () => {
        const right = fieldPlacement({ x: 0.7, y: 0.2, w: 0.25, h: 0.2 }, Stage, field);
        expect(right.x + field.w).toBeLessThanOrEqual(0.7 * Stage.w);
        const wide = fieldPlacement({ x: 0.02, y: 0.1, w: 0.96, h: 0.3 }, Stage, field);
        expect(wide.y).toBeGreaterThan(0.4 * Stage.h);
        const low = fieldPlacement({ x: 0.02, y: 0.7, w: 0.96, h: 0.28 }, Stage, field);
        expect(low.y + field.h).toBeLessThanOrEqual(0.7 * Stage.h);
        for (const at of [right, wide, low]) {
            expect(inside(at)).toBe(true);
        }
    });
});

describe("the keys", () => {
    it("validates on Enter, adds a line on Shift+Enter and closes on Escape in a comment field", () => {
        expect(commentKeyAction({ key: "Enter", shiftKey: false })).toBe("commit");
        expect(commentKeyAction({ key: "Enter", shiftKey: true })).toBe("newline");
        expect(commentKeyAction({ key: "Escape", shiftKey: false })).toBe("cancel");
        expect(commentKeyAction({ key: "a", shiftKey: false })).toBeNull();
    });

    it("leaves the Enter that confirms an input method's composition alone", () => {
        expect(commentKeyAction({ key: "Enter", shiftKey: false, isComposing: true })).toBeNull();
    });

    it("leaves on Escape at once with no zone, asks first with some, keeps on the second Escape, goes back from the review", () => {
        expect(layerKeyAction("Escape", { review: false, leaveAsk: false, zones: 0 })).toBe("leave");
        expect(layerKeyAction("Escape", { review: false, leaveAsk: false, zones: 2 })).toBe("ask-leave");
        expect(layerKeyAction("Escape", { review: false, leaveAsk: true, zones: 2 })).toBe("keep");
        expect(layerKeyAction("Escape", { review: true, leaveAsk: false, zones: 2 })).toBe("back");
        expect(layerKeyAction("a", { review: false, leaveAsk: false, zones: 2 })).toBeNull();
    });
});

function panel(name: string, blockId: string, extra: Partial<AgentBarFacts> = {}): AgentBarFacts {
    return { kind: "panel", blockId, name, state: "working", since: 0, ...extra } as AgentBarFacts;
}

function live(blockid: string, firstname: string, project: string, extra: Partial<AgentStateInfo> = {}) {
    return { blockid, firstname, project, agent: "claude", version: 1, state: "idle", ...extra } as AgentStateInfo;
}

const Dir = "/w/shop";
const States: AgentStateInfo[] = [
    live("b-camille", "Camille", Dir, { started: 10 }),
    live("b-hugo", "Hugo", Dir, { started: 5 }),
    live("b-ines", "Ines", "/w/other", { started: 1 }),
    live("b-brokk", "Brokk", Dir, { own: true }),
    live("b-gone", "Gone", Dir, { cleared: true }),
    live("b-noname", "", Dir),
];

function input(extra: Partial<RecipientInput> = {}): RecipientInput {
    return { worktree: true, projectDir: Dir, onBranch: [], prLead: null, states: States, locks: [], ...extra };
}

describe("the agent the zones are proposed to (FR-BRW-017 AC14)", () => {
    it("is the agent working on the version's worktree, by first name, and the one to fix", () => {
        const list = recipientsOf(input({ onBranch: [panel("Camille", "b-camille")] }));
        expect(list[0]).toMatchObject({ blockId: "b-camille", name: "Camille", why: "works", lead: false });
    });

    it("is the project's lead when no agent works on the worktree: it owns the sub-agent that does", () => {
        const sub = { kind: "subagent", name: "", parentBlockId: "b-hugo", parentName: "Hugo" } as AgentBarFacts;
        const list = recipientsOf(input({ onBranch: [sub] }));
        expect(list[0]).toMatchObject({ blockId: "b-hugo", why: "owns", lead: true });
    });

    it("goes by the pull request's signature, then a locked name, then the project's agents, oldest session first", () => {
        const signed: LeadFacts = { name: "camille", source: "signature" };
        expect(recipientsOf(input({ prLead: signed }))[0]).toMatchObject({
            blockId: "b-camille",
            why: "pr",
            lead: true,
        });
        const locks = [{ name: "Camille", project: Dir }];
        expect(recipientsOf(input({ locks }))[0]).toMatchObject({ blockId: "b-camille", why: "locked", lead: true });
        const project = recipientsOf(input());
        expect(project.map((r) => [r.name, r.why, r.lead])).toEqual([
            ["Hugo", "project", true],
            ["Camille", "project", true],
        ]);
    });

    it("ranks the owner of the sub-agent before the pull request's signer, before the locked name", () => {
        const sub = { kind: "subagent", name: "", parentBlockId: "b-hugo" } as AgentBarFacts;
        const list = recipientsOf(
            input({
                onBranch: [sub],
                prLead: { name: "Camille", source: "signature" },
                locks: [{ name: "Camille", project: Dir }],
            })
        );
        expect(list.map((r) => [r.name, r.why])).toEqual([
            ["Hugo", "owns"],
            ["Camille", "pr"],
        ]);
    });

    it("leaves the project's lead the version served from the main checkout, even for an agent on its branch", () => {
        const list = recipientsOf(input({ worktree: false, onBranch: [panel("Camille", "b-camille")] }));
        expect(list[0]).toMatchObject({ blockId: "b-camille", why: "project", lead: true });
    });

    it("lists each agent once, in the order of its first reason, for the picker", () => {
        const list = recipientsOf(
            input({
                onBranch: [panel("Camille", "b-camille"), panel("Camille", "b-camille")],
                prLead: { name: "Camille", blockId: "b-camille", source: "signature" },
            })
        );
        expect(list.map((r) => [r.name, r.why])).toEqual([
            ["Camille", "works"],
            ["Hugo", "project"],
        ]);
    });

    it("names no agent of another project, Brokk, an ended session or one with no first name", () => {
        const names = recipientsOf(input()).map((r) => r.name);
        expect(names).not.toContain("Ines");
        expect(names).not.toContain("Brokk");
        expect(names).not.toContain("Gone");
        expect(names).toHaveLength(2);
    });

    it("skips a session only passing through the worktree, and offers nobody when no agent runs", () => {
        const visiting = recipientsOf(input({ onBranch: [panel("Camille", "b-camille", { visiting: true })] }));
        expect(visiting[0].why).toBe("project");
        expect(recipientsOf(input({ states: [] }))).toEqual([]);
    });
});

const Answer: TestContextAnswer = {
    url: "http://localhost:5173/some/path?x=1",
    host: "localhost",
    port: 5173,
    known: true,
    root: "/w/shop-wt/a",
    project: Dir,
    name: "shop",
    worktree: true,
    branch: "feature/1-a",
    ticket: 1,
    sameproject: true,
};

const Pr: ReviewPr = {
    number: 110,
    title: "Loader",
    url: "https://example.test/acme/shop/pull/110",
    branch: "feature/1-a",
    base: "develop",
    draft: true,
    ticket: 1,
    tickettitle: "Loader on the home page",
    createdat: "",
    updatedat: "",
    merge: "clean",
    ci: { state: "success", success: 0, failure: 0, pending: 0, checks: [] },
    report: { state: "present" },
    unpublished: 0,
};

function states(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((i) => [i.blockid, i])), versions: {} };
}

function project(upcoming: UpcomingAnswer, agents: AgentStatesData): ProjectFacts {
    return {
        dir: Dir,
        answer: { dir: Dir, state: "ok", ready: [], drafts: [Pr] },
        ctx: { upcoming, states: agents, now: 0, boardText: (s) => s },
    };
}

describe("where the page's zones go from (FR-BRW-017 AC12)", () => {
    const camille = live("b-camille", "Camille", Dir, { started: 1 });
    const hugo = live("b-hugo", "Hugo", Dir, { started: 0 });

    it("names the checkout, the branch and the agent working on it", () => {
        const agents = states(camille, hugo);
        const upcoming: UpcomingAnswer = {
            dir: Dir,
            branches: [],
            agents: [
                {
                    kind: "panel",
                    blockid: "b-camille",
                    branch: "feature/1-a",
                    agent: "claude",
                    firstname: "Camille",
                } as UpcomingAnswer["agents"][number],
            ],
            drafts: [],
            at: 0,
        } as UpcomingAnswer;
        const target = annotateTargetOf({
            url: Answer.url,
            answer: Answer,
            workspaceDir: Dir,
            projects: [project(upcoming, agents)],
            asks: {},
            states: agents,
            locks: [],
        });
        expect(target).toMatchObject({ address: Answer.url, root: "/w/shop-wt/a", branch: "feature/1-a", dir: Dir });
        expect(target.recipients.map((r) => r.name)).toEqual(expect.arrayContaining(["Camille", "Hugo"]));
        expect(target.recipients[0]).toMatchObject({ name: "Camille", why: "works", lead: false });
    });

    it("proposes the project's lead for a page served from no checkout, and names no checkout", () => {
        const agents = states(camille, hugo);
        const target = annotateTargetOf({
            url: "https://example.test/docs",
            answer: null,
            workspaceDir: Dir,
            projects: [],
            asks: {},
            states: agents,
            locks: [],
        });
        expect(target).toMatchObject({ address: "https://example.test/docs", root: "", branch: "", dir: Dir });
        expect(target.recipients.map((r) => [r.name, r.why])).toEqual([
            ["Hugo", "project"],
            ["Camille", "project"],
        ]);
    });

    it("uses the checkout's own project for a version of another project, whose agents are that project's", () => {
        const other = live("b-ines", "Ines", "/w/blog", { started: 1 });
        const agents = states(camille, other);
        const target = annotateTargetOf({
            url: Answer.url,
            answer: { ...Answer, sameproject: false, project: "/w/blog", root: "/w/blog-wt/x", branch: "feature/3-c" },
            workspaceDir: Dir,
            projects: [],
            asks: {},
            states: agents,
            locks: [],
        });
        expect(target.dir).toBe("/w/blog");
        expect(target.recipients.map((r) => r.name)).toEqual(["Ines"]);
    });

    it("reads the empty stores as no agent", () => {
        const target = annotateTargetOf({
            url: Answer.url,
            answer: Answer,
            workspaceDir: Dir,
            projects: [],
            asks: {},
            states: EmptyAgentStates,
            locks: [],
        });
        expect(target.recipients).toEqual([]);
    });
});

describe("what wavesrv is asked", () => {
    const target = { address: Answer.url, root: "/w/shop-wt/a", dir: Dir, branch: "feature/1-a", recipients: [] };
    const zones = drawn("  The title is cut.  ", "").zones;
    const to = { blockId: "b-camille", name: "Camille", agent: "claude", why: "pr" as const, lead: true };

    it("sends the zones' comments in order, trimmed, with the recipient and its role, and the image only to keep it", () => {
        const preview = annotateRequest("preview", target, zones, { to, image: "data:image/png;base64,AAAA" });
        expect(preview).toEqual({
            action: "preview",
            address: Answer.url,
            root: "/w/shop-wt/a",
            branch: "feature/1-a",
            zones: [{ comment: "The title is cut." }, { comment: "" }],
            to: { blockid: "b-camille", firstname: "Camille", agent: "claude", lead: true },
        });
        const send = annotateRequest("send", target, zones, { to, image: "data:image/png;base64,AAAA", title: "T" });
        expect(send).toMatchObject({ action: "send", image: "data:image/png;base64,AAAA", title: "T" });
    });

    it("names the project's folder when the page has no checkout", () => {
        const req = annotateRequest("copy", { ...target, root: "" }, zones, { image: "i", title: "T" });
        expect(req.root).toBeUndefined();
        expect(req.dir).toBe(Dir);
        expect(req.to).toBeUndefined();
    });
});
