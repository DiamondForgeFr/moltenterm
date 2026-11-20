// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The zones of the annotate mode and the agent they are proposed to (FR-BRW-017 AC12 to AC14, #2327). Synthetic
// projects, branches and agents only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { EmptyAgentStates } from "../agent-state-model";
import type { LeadFacts, ReviewPr } from "../reviews/reviews-model";
import type { AgentBarFacts, UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import {
    addZone,
    annotateRequest,
    annotateTargetOf,
    attachRef,
    cancelEdit,
    clearAll,
    commentKeyAction,
    commitComment,
    addressKey,
    discardPage,
    editZone,
    emptyState,
    eraseZone,
    excerptOf,
    fieldPlacement,
    layerKeyAction,
    linkChip,
    linksOf,
    MaxCommentChars,
    MaxLinksPerZone,
    MaxRefs,
    MaxRefsPerZone,
    markViews,
    MaxZones,
    pagesOf,
    recipientsOf,
    refCount,
    removeRef,
    resolveRecipient,
    sameAddress,
    setComment,
    zoneNumber,
    zonesOfPage,
    zonesWire,
    type AnnotateState,
    type Placed,
    type RecipientInput,
} from "./annotate-model";
import type { TestContextAnswer } from "./test-context-model";
import type { ProjectFacts } from "./version-card-model";

// The fixtures wavesrv's own test reads (TestAnnotateLinksSplitAsTheWindowDoes): read while the file is collected.
const Fixtures: { name: string; comment: string; hosts: string[] }[] = JSON.parse(
    readFileSync(new URL("../../../pkg/molten/mission/testdata/annotate-links.json", import.meta.url), "utf8")
);

const Stage = { w: 1000, h: 600 };
const Page = "http://localhost:5173/shop";
// A mark as the page's overlay reports it: a rectangle in page coordinates on an element of the page.
const Box: Placed = {
    kind: "zone",
    address: Page,
    anchor: {
        box: { x: 100, y: 1200, w: 300, h: 150 },
        selector: "main > .card:nth-of-type(2)",
        rel: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
        fixed: false,
        path: null,
    },
};

function drawn(...comments: string[]): AnnotateState {
    let state = emptyState();
    comments.forEach((comment, i) => {
        state = addZone(state, { ...Box, anchor: { ...Box.anchor, box: { ...Box.anchor.box, x: 50 * (i + 1) } } });
        state = setComment(state, state.editing.id, comment);
        state = commitComment(state, state.editing.id);
    });
    return state;
}

describe("placing a mark", () => {
    it("keeps the mark's kind, its anchor and the page it is on", () => {
        const state = addZone(emptyState(), Box);
        expect(state.zones[0]).toMatchObject({ kind: "zone", address: Page, comment: "", refs: [] });
        expect(state.zones[0].anchor).toEqual(Box.anchor);
    });

    it("places nothing without an anchor", () => {
        expect(addZone(emptyState(), null).zones).toEqual([]);
        expect(addZone(emptyState(), { ...Box, anchor: null }).zones).toEqual([]);
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
        expect(zonesWire(state.zones).map((z) => z.comment)).toEqual(["two", "three"]);
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

describe("the pages the comments are on (FR-BRW-017 AC27)", () => {
    const Other = "http://localhost:5173/cart";
    const mixed = (): AnnotateState => {
        let state = drawn("one", "two");
        state = addZone(state, { ...Box, address: Other });
        return commitComment(setComment(state, state.editing.id, "three"), state.editing.id);
    };

    it("takes two addresses for one page when only their fragment differs", () => {
        expect(addressKey(`${Page}#reviews`)).toBe(Page);
        expect(sameAddress(`${Page}#a`, `${Page}#b`)).toBe(true);
        expect(sameAddress(`${Page}?tab=1`, `${Page}?tab=2`)).toBe(false);
        expect(sameAddress(Page, Other)).toBe(false);
    });

    it("lists the pages in the order they were first commented, with how many comments each holds", () => {
        expect(pagesOf(mixed().zones)).toEqual([
            { address: Page, count: 2 },
            { address: Other, count: 1 },
        ]);
        expect(zonesOfPage(mixed().zones, `${Page}#top`).map((z) => z.comment)).toEqual(["one", "two"]);
    });

    it("draws on the page shown the marks of its own comments, numbered as the report numbers them", () => {
        const state = mixed();
        expect(markViews(state, Page).map((m) => [m.id, m.n])).toEqual([
            [state.zones[0].id, 1],
            [state.zones[1].id, 2],
        ]);
        expect(markViews(state, Other).map((m) => m.n)).toEqual([3]);
        expect(markViews(state, "http://localhost:5173/none")).toEqual([]);
    });

    it("marks the comment being edited as the active one", () => {
        const state = mixed();
        expect(markViews(state, Page).map((m) => m.active)).toEqual([false, false]);
        const open = editZone(state, state.zones[0].id);
        expect(markViews(open, Page).map((m) => m.active)).toEqual([true, false]);
    });

    it("drops the comments of a page when the developer discards them, and only those", () => {
        const next = discardPage(mixed(), Page);
        expect(next.zones.map((z) => z.comment)).toEqual(["three"]);
        expect(pagesOf(next.zones)).toEqual([{ address: Other, count: 1 }]);
    });

    it("closes the field of a comment that goes with its page", () => {
        let state = addZone(emptyState(), Box);
        expect(discardPage(state, Page).editing).toBeNull();
        state = addZone(commitComment(state, state.zones[0].id), { ...Box, address: Other });
        expect(discardPage(state, Page).editing?.id).toBe(state.zones[1].id);
    });

    it("reads the first line of a comment for a list, cut when long", () => {
        expect(excerptOf("  first line\nsecond  ")).toBe("first line");
        expect(excerptOf("")).toBe("");
        expect(excerptOf("x".repeat(100), 10)).toBe("xxxxxxxxx…");
    });
});

describe("the comment field's place", () => {
    const field = { w: 288, h: 150 };
    const inside = (p: { x: number; y: number }) =>
        p.x >= 0 && p.y >= 0 && p.x + field.w <= Stage.w && p.y + field.h <= Stage.h;

    it("is beside the mark, on its right when there is room", () => {
        const at = fieldPlacement({ x: 100, y: 120, w: 200, h: 120 }, Stage, field);
        expect(at.x).toBeGreaterThan(300);
        expect(at.y).toBe(120);
    });

    it("goes to the left, then under or over the mark, when the right has no room, and stays in the stage", () => {
        const right = fieldPlacement({ x: 700, y: 120, w: 250, h: 120 }, Stage, field);
        expect(right.x + field.w).toBeLessThanOrEqual(700);
        const wide = fieldPlacement({ x: 20, y: 60, w: 960, h: 180 }, Stage, field);
        expect(wide.y).toBeGreaterThan(240);
        const low = fieldPlacement({ x: 20, y: 420, w: 960, h: 170 }, Stage, field);
        expect(low.y + field.h).toBeLessThanOrEqual(420);
        for (const at of [right, wide, low]) {
            expect(inside(at)).toBe(true);
        }
    });

    it("stays in the stage for a mark that scrolled out of the page's view", () => {
        for (const box of [
            { x: 100, y: -900, w: 200, h: 120 },
            { x: 100, y: 5000, w: 200, h: 120 },
            { x: -400, y: 100, w: 100, h: 50 },
        ]) {
            expect(inside(fieldPlacement(box, Stage, field))).toBe(true);
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
    return {
        blockid,
        firstname,
        project,
        workspaceid: Ws,
        agent: "claude",
        version: 1,
        state: "idle",
        ...extra,
    } as AgentStateInfo;
}

const Dir = "/w/shop";
const Ws = "ws-1";
const States: AgentStateInfo[] = [
    live("b-camille", "Camille", Dir, { started: 10 }),
    live("b-hugo", "Hugo", Dir, { started: 5 }),
    live("b-ines", "Ines", "/w/other", { started: 1 }),
    live("b-brokk", "Brokk", Dir, { own: true }),
    live("b-gone", "Gone", Dir, { cleared: true }),
    live("b-noname", "", Dir),
];

function input(extra: Partial<RecipientInput> = {}): RecipientInput {
    return {
        workspaceId: Ws,
        worktree: true,
        projectDir: Dir,
        onBranch: [],
        prLead: null,
        states: States,
        locks: [],
        ...extra,
    };
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

// Activity is per workspace (only Brokk crosses them) and, when one is known, per project.
describe("only the agents of the window's workspace and project are offered", () => {
    const elsewhere = [
        live("b-lea", "Lea", Dir, { workspaceid: "ws-2", started: 0 }),
        live("b-marc", "Marc", "/w/blog", { workspaceid: "ws-2", started: 0 }),
        live("b-none", "Nils", Dir, { workspaceid: undefined, started: 0 }),
    ];

    it("leaves out an agent of another workspace, even of the same project folder, however old its session", () => {
        const list = recipientsOf(input({ states: [...elsewhere, ...States] }));
        expect(list.map((r) => r.name)).toEqual(["Hugo", "Camille"]);
    });

    it("never names an agent of another workspace as the one on the branch, the sub-agent's owner, the signer or the lock", () => {
        const stranger = live("b-lea", "Lea", Dir, { workspaceid: "ws-2" });
        const sub = { kind: "subagent", name: "", parentBlockId: "b-lea", parentName: "Lea" } as AgentBarFacts;
        const list = recipientsOf(
            input({
                states: [stranger],
                onBranch: [panel("Lea", "b-lea"), sub],
                prLead: { name: "Lea", blockId: "b-lea", source: "signature" },
                locks: [{ name: "Lea", project: Dir }],
            })
        );
        expect(list).toEqual([]);
    });

    it("offers the workspace's agents when no project folder is known (a page served from nowhere, a workspace with no project)", () => {
        const list = recipientsOf(
            input({ projectDir: "", states: [...elsewhere, live("b-ines", "Ines", "/w/other"), ...States] })
        );
        expect(list.map((r) => r.name).sort()).toEqual(["Camille", "Hugo", "Ines"]);
        expect(list.every((r) => r.why === "project" && r.lead)).toBe(true);
    });

    it("offers nobody when the window's workspace is not known", () => {
        expect(recipientsOf(input({ workspaceId: "" }))).toEqual([]);
        expect(recipientsOf(input({ workspaceId: "", projectDir: "" }))).toEqual([]);
    });
});

describe("the agent the developer picked", () => {
    const list = recipientsOf(input());

    it("is the one proposed until the developer picks another", () => {
        expect(resolveRecipient(list, null)).toEqual({ chosen: list[0], lost: "" });
        const camille = list.find((r) => r.name === "Camille");
        expect(resolveRecipient(list, { blockId: camille.blockId, name: "Camille" })).toEqual({
            chosen: camille,
            lost: "",
        });
        expect(resolveRecipient([], null)).toEqual({ chosen: null, lost: "" });
    });

    it("is never replaced by another when it goes: nothing is chosen, and the review says who went", () => {
        const gone = { blockId: "b-camille", name: "Camille" };
        const rest = list.filter((r) => r.blockId !== "b-camille");
        expect(rest.length).toBeGreaterThan(0);
        expect(resolveRecipient(rest, gone)).toEqual({ chosen: null, lost: "Camille" });
        expect(resolveRecipient([], gone)).toEqual({ chosen: null, lost: "Camille" });
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
            workspaceId: Ws,
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
            workspaceId: Ws,
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
            workspaceId: Ws,
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
            workspaceId: Ws,
            workspaceDir: Dir,
            projects: [],
            asks: {},
            states: EmptyAgentStates,
            locks: [],
        });
        expect(target.recipients).toEqual([]);
    });
});

// The images a comment can carry (FR-BRW-017 AC21): attached to a zone, at most four a zone and eight a report.
describe("reference images", () => {
    const Img = (n: number) => `data:image/png;base64,AAAA${n}`;

    it("attaches an image to the open zone, each with its own id, and removes only the one asked", () => {
        let state = addZone(emptyState(), Box);
        const id = state.zones[0].id;
        state = attachRef(state, id, Img(1)).state;
        state = attachRef(state, id, Img(2)).state;
        const [a, b] = state.zones[0].refs;
        expect(a.id).not.toBe(b.id);
        expect(state.zones[0].refs.map((r) => r.dataUrl)).toEqual([Img(1), Img(2)]);
        state = removeRef(state, id, a.id);
        expect(state.zones[0].refs).toEqual([b]);
        expect(removeRef(state, 99, b.id)).toEqual(state);
    });

    it("holds at most four images in a zone, and says so without adding a fifth", () => {
        let state = addZone(emptyState(), Box);
        const id = state.zones[0].id;
        for (let i = 0; i < MaxRefsPerZone; i++) {
            state = attachRef(state, id, Img(i)).state;
        }
        const fifth = attachRef(state, id, Img(9));
        expect(fifth.refused).toBe("zone");
        expect(fifth.state).toBe(state);
        expect(state.zones[0].refs).toHaveLength(MaxRefsPerZone);
    });

    it("holds at most eight images in a report, across its zones", () => {
        let state = emptyState();
        for (let z = 0; z < 3; z++) {
            state = commitComment(addZone(state, Box), state.nextId);
        }
        const ids = state.zones.map((zone) => zone.id);
        for (let i = 0; i < MaxRefs; i++) {
            const attached = attachRef(state, ids[Math.floor(i / MaxRefsPerZone)], Img(i));
            expect(attached.refused).toBe("");
            state = attached.state;
        }
        expect(refCount(state)).toBe(MaxRefs);
        const ninth = attachRef(state, ids[2], Img(9));
        expect(ninth.refused).toBe("report");
        expect(ninth.state).toBe(state);
    });

    it("attaches nothing to a zone that is not there, and nothing empty", () => {
        const state = addZone(emptyState(), Box);
        expect(attachRef(state, 99, Img(1))).toEqual({ state, refused: "" });
        expect(attachRef(state, state.zones[0].id, "")).toEqual({ state, refused: "" });
    });

    it("takes a zone's images with it when the zone is erased or everything is cleared", () => {
        let state = addZone(emptyState(), Box);
        state = attachRef(state, state.zones[0].id, Img(1)).state;
        state = commitComment(state, state.zones[0].id);
        state = addZone(state, Box);
        state = attachRef(state, state.zones[1].id, Img(2)).state;
        expect(refCount(state)).toBe(2);
        state = eraseZone(state, state.zones[0].id);
        expect(refCount(state)).toBe(1);
        expect(refCount(clearAll(state))).toBe(0);
    });

    it("keeps a new zone that holds an image, though its comment is empty, when Escape closes its field", () => {
        let state = addZone(emptyState(), Box);
        const id = state.zones[0].id;
        state = attachRef(state, id, Img(1)).state;
        const next = cancelEdit(state, id);
        expect(next.zones).toHaveLength(1);
        expect(next.editing).toBeNull();
        expect(cancelEdit(addZone(emptyState(), Box), 1).zones).toEqual([]);
    });

    it("sends the images with the comments, and only their count for a preview", () => {
        let state = drawn("one", "two");
        state = attachRef(state, state.zones[1].id, Img(1)).state;
        state = attachRef(state, state.zones[1].id, Img(2)).state;
        const mark = { kind: "zone", address: Page, selector: "main > .card:nth-of-type(2)" };
        expect(zonesWire(state.zones)).toEqual([
            { comment: "one", ...mark },
            { comment: "two", ...mark, images: [Img(1), Img(2)] },
        ]);
        expect(zonesWire(state.zones, true)).toEqual([
            { comment: "one", ...mark },
            { comment: "two", ...mark, imagecount: 2 },
        ]);
    });

    it("sends the picture taken of each comment's place, and only that there is one for a preview", () => {
        const state = drawn("one", "two");
        const captures = { [state.zones[0].id]: "data:image/png;base64,CCCC" };
        expect(zonesWire(state.zones, false, captures).map((z) => [z.capture, z.captured])).toEqual([
            ["data:image/png;base64,CCCC", undefined],
            [undefined, undefined],
        ]);
        expect(zonesWire(state.zones, true, captures).map((z) => [z.capture, z.captured])).toEqual([
            [undefined, true],
            [undefined, undefined],
        ]);
    });

    it("names the page a comment is on without its fragment, and leaves out a selector that is empty", () => {
        let state = addZone(emptyState(), {
            ...Box,
            address: `${Page}#reviews`,
            anchor: { ...Box.anchor, selector: "", rel: null },
        });
        state = commitComment(state, state.editing.id);
        expect(zonesWire(state.zones)).toEqual([{ comment: "", kind: "zone", address: Page }]);
    });
});

// A link in a comment (FR-BRW-017 AC22): wavesrv finds the same ones (TestAnnotateLinks) and lists them in the brief.
describe("links in a comment", () => {
    const hosts = (comment: string) => linksOf(comment).map((l) => l.host);

    it("recognises http and https addresses, typed or pasted, once each and in order, with their host name", () => {
        expect(hosts("see https://example.test/a and http://example.test:8080/b")).toEqual([
            "example.test",
            "example.test:8080",
        ]);
        expect(hosts("twice https://example.test/a https://example.test/a")).toEqual(["example.test"]);
        expect(hosts("(like https://example.test/a).")).toEqual(["example.test"]);
        expect(linksOf("https://en.example.test/wiki/Go_(language) works")[0].href).toBe(
            "https://en.example.test/wiki/Go_(language)"
        );
        expect(hosts("HTTPS://Example.test/A, nice!")).toEqual(["example.test"]);
    });

    it("never makes a link of another scheme, or of an address with no host", () => {
        for (const comment of [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "ftp://example.test/a",
            "mailto:someone@example.test",
            "chrome://settings",
            "http:///nohost",
            "https://",
            "xhttps://example.test/a",
            "no link here, only example.test/a",
        ]) {
            expect([comment, linksOf(comment)]).toEqual([comment, []]);
        }
    });

    it("leaves out the user, the password and the fragment an address carries", () => {
        expect(linksOf("https://user:secret@example.test/p?q=1#frag")).toEqual([
            { href: "https://example.test/p?q=1", host: "example.test" },
        ]);
    });

    it("holds at most five links a zone", () => {
        const many = Array.from({ length: 9 }, (_, i) => `https://example.test/${i}`).join(" ");
        expect(linksOf(many)).toHaveLength(MaxLinksPerZone);
    });

    it("splits a comment as wavesrv does, Unicode spaces and invisible characters included (the same fixtures)", () => {
        expect(Fixtures.length).toBeGreaterThanOrEqual(15);
        for (const c of Fixtures) {
            expect([c.name, hosts(c.comment)]).toEqual([c.name, c.hosts]);
        }
    });
});

describe("a link the review shows", () => {
    it("is a chip of an address wavesrv listed, with its host name, whatever it looks like", () => {
        expect(linkChip("https://a.test:8080/x?p=1")).toEqual({
            href: "https://a.test:8080/x?p=1",
            host: "a.test:8080",
        });
        expect(linkChip("not an address")).toEqual({ href: "not an address", host: "not an address" });
    });
});

describe("what wavesrv is asked", () => {
    const target = {
        address: Answer.url,
        root: "/w/shop-wt/a",
        dir: Dir,
        branch: "feature/1-a",
        workspaceId: Ws,
        recipients: [],
    };
    const zones = drawn("  The title is cut.  ", "").zones;
    const to = { blockId: "b-camille", name: "Camille", agent: "claude", why: "pr" as const, lead: true };

    it("sends the zones' comments in order, trimmed, with the recipient and its role, and the images only to keep them", () => {
        const captures = { [zones[0].id]: "data:image/png;base64,CCCC" };
        const preview = annotateRequest("preview", target, zones, {
            to,
            overview: "data:image/png;base64,AAAA",
            captures,
        });
        const mark = { kind: "zone", address: Page, selector: "main > .card:nth-of-type(2)" };
        expect(preview).toEqual({
            action: "preview",
            address: Answer.url,
            root: "/w/shop-wt/a",
            branch: "feature/1-a",
            workspaceid: Ws,
            hasoverview: true,
            zones: [
                { comment: "The title is cut.", ...mark, captured: true },
                { comment: "", ...mark },
            ],
            to: { blockid: "b-camille", firstname: "Camille", agent: "claude", lead: true },
        });
        const send = annotateRequest("send", target, zones, {
            to,
            overview: "data:image/png;base64,AAAA",
            captures,
            title: "T",
            captureTitle: "C {zone}",
        });
        expect(send).toMatchObject({
            action: "send",
            overview: "data:image/png;base64,AAAA",
            title: "T",
            capturetitle: "C {zone}",
        });
        expect(send.zones[0].capture).toBe("data:image/png;base64,CCCC");
        expect(send.hasoverview).toBeUndefined();
    });

    it("sends no overview when the page gave none", () => {
        const send = annotateRequest("send", target, zones, { to, title: "T" });
        expect(send.overview).toBeUndefined();
        expect(annotateRequest("preview", target, zones, {}).hasoverview).toBe(false);
    });

    it("names the project's folder when the page has no checkout", () => {
        const req = annotateRequest("copy", { ...target, root: "" }, zones, { overview: "i", title: "T" });
        expect(req.root).toBeUndefined();
        expect(req.dir).toBe(Dir);
        expect(req.to).toBeUndefined();
    });
});
