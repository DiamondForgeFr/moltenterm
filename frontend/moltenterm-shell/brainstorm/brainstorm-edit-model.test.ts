// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import type { HistoryNote } from "./brainstorm-boot";
import { CameraNav, FocusRadius, projectPoint } from "./brainstorm-camera-model";
import {
    changesNote,
    developerChangeOnly,
    editKey,
    isUndoKey,
    lastOwnChange,
    outlineOrder,
    outlineStep,
    plateMenuOf,
    toldBy,
    typedText,
    undoOffer,
    untold,
    withNote,
} from "./brainstorm-edit-model";
import {
    blockProblem,
    BrainstormGraph,
    BrainstormNode,
    MaxOps,
    MaxText,
    readGraphBlock,
} from "./brainstorm-graph-model";
import { arrivalDelay, fitDistance, leaveLook, Loops } from "./brainstorm-scene-model";

// Synthetic data only: the mockup's brainstorm.
const node = (id: string, kind: string, text: string, from = "", pos: [number, number, number] = [0, 0, 0]) =>
    ({ id, kind, text, from, status: "open", turn: 1, at: 1, pos }) as BrainstormNode;

const nodes: BrainstormNode[] = [
    node("kids-video", "topic", "A safe video app for children"),
    node("ages", "question", "For which ages?", "kids-video", [300, 0, 0]),
    node("three-ten", "answer", "From 3 to 10", "ages", [540, 40, 0]),
    node("who-picks", "question", "Who picks the videos?", "kids-video", [-300, 0, 0]),
    node("parents-list", "idea", "Parents validate a list", "who-picks", [-540, 40, 0]),
    node("ref-forge", "reference", "Forge notes", "kids-video", [0, 300, 0]),
];

// A block holding one operation, as his answer writes it.
const one = (op: Record<string, unknown>) => ({ v: 1, talk: "project", ops: [op] });

// FR-BOSS-010 AC26 (#2247): the window reads Brokk's corrections with wavesrv's rules (pkg/molten/brainstorm/edit.go).
describe("the operations of the living graph in his block", () => {
    it.each([
        ["edit", { op: "edit", id: "ages", text: "Which ages?" }],
        ["remove", { op: "remove", id: "who-picks", reason: "the parents decide" }],
        ["remove without a reason", { op: "remove", id: "who-picks" }],
        ["unlink", { op: "unlink", a: "ages", b: "three-ten" }],
        ["retype", { op: "retype", id: "parents-list", kind: "decision" }],
        ["merge", { op: "merge", ids: ["three-ten"], into: "ages" }],
    ])("keeps a valid %s", (_name, op) => {
        expect(blockProblem(one(op))).toBe("");
    });

    it.each([
        ["an edit with no text", { op: "edit", id: "ages", text: " " }],
        ["an edit too long", { op: "edit", id: "ages", text: "x".repeat(MaxText + 1) }],
        ["a remove with an invalid id", { op: "remove", id: "Who Picks" }],
        ["a reason too long", { op: "remove", id: "ages", reason: "x".repeat(MaxText + 1) }],
        ["an unlink to itself", { op: "unlink", a: "ages", b: "ages" }],
        ["a retype to the topic", { op: "retype", id: "ages", kind: "topic" }],
        ["a retype to a proposal", { op: "retype", id: "ages", kind: "proposal" }],
        ["a merge of nothing", { op: "merge", ids: [], into: "ages" }],
        ["a merge into itself", { op: "merge", ids: ["ages"], into: "ages" }],
        ["a merge naming twice", { op: "merge", ids: ["three-ten", "three-ten"], into: "ages" }],
        [
            "a merge of too many",
            { op: "merge", ids: Array.from({ length: MaxOps + 1 }, (_, i) => `n${i}`), into: "ages" },
        ],
        ["a merge into an invalid id", { op: "merge", ids: ["ages"], into: "Ages" }],
    ])("drops the block with %s, naming the operation only", (_name, op) => {
        const read = readGraphBlock(`I pruned.\n\n\`\`\`brokk-graph\n${JSON.stringify(one(op))}\n\`\`\``);
        expect(read.block).toBeNull();
        expect(read.problem).toBe("invalid");
        expect(read.reason).toMatch(new RegExp(`\\(${op.op}\\)`));
        expect(read.reason).not.toMatch(/xxx|Who Picks/);
    });
});

const kindLabel = (kind: string) => t(`boss.brainstorm.kinds.${kind}`);

const note = (seq: number, by: "you" | "brokk", op: string, more: Partial<HistoryNote> = {}): HistoryNote => ({
    seq,
    at: seq,
    by,
    op,
    nodes: [{ id: "who-picks", text: "Who picks the videos?", kind: "question" }],
    undoable: true,
    ...more,
});

// AC27: the developer's changes go to Brokk with their next message, as a note before it; an undone change, one told
// already, and Brokk's own are not in it.
describe("the note of the developer's changes", () => {
    const history: HistoryNote[] = [
        note(1, "brokk", "add"),
        note(2, "you", "remove"),
        note(3, "you", "retype", {
            nodes: [{ id: "parents-list", text: "Parents validate a list", kind: "decision" }],
        }),
        note(4, "you", "edit", { told: true }),
        note(5, "you", "unlink", { undone: true }),
        note(6, "you", "link", {
            nodes: [
                { id: "ages", text: "For which ages?" },
                { id: "three-ten", text: "From 3 to 10" },
            ],
        }),
        note(7, "you", "undo", { refop: "remove", nodes: [{ id: "approved", text: "Approved channels" }] }),
        note(8, "you", "undo", { refop: "retype", nodes: [{ id: "ages", text: "For which ages?" }] }),
    ];

    it("lists the untold changes in the developer's words, with the ids Brokk knows them by", () => {
        expect(untold(history).map((n) => n.seq)).toEqual([2, 3, 6, 7, 8]);
        const got = changesNote(history, t, kindLabel);
        expect(got.seq).toBe(8);
        expect(got.text).toBe(
            "[My changes to the graph: removed “Who picks the videos?” (who-picks); " +
                "“Parents validate a list” (parents-list) is now: Decision; " +
                "linked “For which ages?” (ages) and “From 3 to 10” (three-ten); " +
                "put back “Approved channels” (approved); undid the change to “For which ages?” (ages).]"
        );
    });

    it("words an edit with the node's id and its new text", () => {
        const edit = note(1, "you", "edit", { nodes: [{ id: "ages", text: "Which ages?" }], was: "For which ages?" });
        expect(changesNote([edit], t, kindLabel).text).toBe(
            "[My changes to the graph: rewrote ages as “Which ages?”.]"
        );
    });

    it("says nothing when every change was told or undone", () => {
        expect(
            changesNote([note(1, "you", "remove", { told: true }), note(2, "brokk", "remove")], t, kindLabel)
        ).toEqual({
            text: "",
            seq: 0,
        });
        expect(changesNote(null, t, kindLabel).text).toBe("");
    });

    it("puts the note after the brainstorm's own lead and replaces the one before", () => {
        expect(withNote("", "", "[A]")).toBe("[A]");
        expect(withNote("Brainstorm:", "", "[A]")).toBe("Brainstorm: [A]");
        expect(withNote("Brainstorm: [A]", "[A]", "[A; B]")).toBe("Brainstorm: [A; B]");
        expect(withNote("Brainstorm: [A]", "[A]", "")).toBe("Brainstorm:");
        expect(withNote("[A]", "[A]", "")).toBe("");
        // A lead someone else set since keeps its words.
        expect(withNote("Brainstorm resumed: “Forge notes”.", "[A]", "[B]")).toBe(
            "Brainstorm resumed: “Forge notes”. [B]"
        );
    });

    it("knows which note went with a message: the newest it carries", () => {
        const notes = [
            { text: "[A]", seq: 2 },
            { text: "[A; B]", seq: 3 },
        ];
        expect(toldBy("Brainstorm: [A; B] And for teenagers?", notes)).toEqual({ text: "[A; B]", seq: 3 });
        expect(toldBy("[A] Go on.", notes)).toEqual({ text: "[A]", seq: 2 });
        expect(toldBy("Go on.", notes)).toBeNull();
        expect(toldBy("Go on.", [])).toBeNull();
    });
});

// AC27 and AC28: the bar offers to put back the newest removal or merge since the last state; Ctrl/⌘ + Z the
// developer's own last change, also after a reload.
describe("what Undo puts back", () => {
    it("offers the newest removal or merge since the lines seen, the developer's or Brokk's, still undoable", () => {
        const history = [
            note(1, "brokk", "add"),
            note(2, "brokk", "remove"),
            note(3, "you", "retype"),
            note(4, "brokk", "merge"),
            note(5, "you", "remove", { undoable: false }),
        ];
        expect(undoOffer(history, 1)?.seq).toBe(4);
        expect(undoOffer(history, 4)).toBeNull();
        expect(undoOffer(history.slice(0, 3), 1)?.seq).toBe(2);
        expect(undoOffer([note(6, "you", "edit")], 0)).toBeNull();
        expect(undoOffer(null, 0)).toBeNull();
    });

    it("takes the developer's last change for Ctrl/⌘ + Z, never Brokk's, and none behind a change it cannot undo", () => {
        expect(lastOwnChange([note(1, "you", "remove"), note(2, "brokk", "remove")])?.seq).toBe(1);
        expect(lastOwnChange([note(1, "you", "remove"), note(2, "you", "undo")])?.seq).toBe(1);
        expect(lastOwnChange([note(1, "you", "remove"), note(2, "you", "edit", { undone: true })])?.seq).toBe(1);
        expect(lastOwnChange([note(1, "you", "remove"), note(2, "you", "edit", { undoable: false })])).toBeNull();
        expect(lastOwnChange([note(1, "brokk", "remove")])).toBeNull();
    });

    it("reads Ctrl/⌘ + Z, not with Shift or Alt", () => {
        const key = (
            k: string,
            mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>
        ) => ({
            key: k,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            altKey: false,
            ...mods,
        });
        expect(isUndoKey(key("z", { metaKey: true }))).toBe(true);
        expect(isUndoKey(key("Z", { ctrlKey: true }))).toBe(true);
        expect(isUndoKey(key("z", { metaKey: true, shiftKey: true }))).toBe(false);
        expect(isUndoKey(key("z", { altKey: true, ctrlKey: true }))).toBe(false);
        expect(isUndoKey(key("z", {}))).toBe(false);
    });
});

// AC27: a plate's menu, and its text edited in place.
describe("a plate's menu and its text", () => {
    it("offers Edit text, Change kind, Remove and Link to… as the node allows", () => {
        expect(plateMenuOf(nodes[1], "kids-video")).toEqual({
            edit: true,
            kinds: ["question", "answer", "idea", "theme", "decision", "conclusion"],
            current: "question",
            remove: true,
            link: true,
        });
        // The centre: its title is edited, never retyped nor removed.
        expect(plateMenuOf(nodes[0], "kids-video")).toMatchObject({ edit: true, kinds: [], remove: false, link: true });
        // A reference node is MoltenTerm's own.
        expect(plateMenuOf(nodes[5], "kids-video")).toMatchObject({
            edit: false,
            kinds: [],
            remove: false,
            link: false,
        });
        expect(plateMenuOf(null, "kids-video")).toBeNull();
    });

    it("keeps one plain line of at most 160 characters, and saves on Enter, cancels on Escape", () => {
        expect(typedText("  Which\nages,\texactly? ")).toBe("Which ages, exactly?");
        expect([...typedText("é".repeat(MaxText + 20))]).toHaveLength(MaxText);
        expect(typedText("   ")).toBe("");
        expect(editKey({ key: "Enter" })).toBe("save");
        expect(editKey({ key: "Escape" })).toBe("cancel");
        expect(editKey({ key: "Enter", isComposing: true })).toBeNull();
        expect(editKey({ key: "a" })).toBeNull();
    });
});

// AC20: the outline is the graph as a tree, the centre first; the arrows walk it.
describe("the outline of the graph", () => {
    it("orders the nodes depth first, the centre first, each node's children as they came", () => {
        expect(outlineOrder(nodes, "kids-video")).toEqual([
            "kids-video",
            "ages",
            "three-ten",
            "who-picks",
            "parents-list",
            "ref-forge",
        ]);
        expect(outlineOrder([], "")).toEqual([]);
    });

    it.each([
        ["ages", "ArrowDown", "three-ten"],
        ["three-ten", "ArrowDown", "who-picks"],
        ["ages", "ArrowUp", "kids-video"],
        ["kids-video", "ArrowUp", "kids-video"],
        ["ref-forge", "ArrowDown", "ref-forge"],
        ["three-ten", "ArrowLeft", "ages"],
        ["kids-video", "ArrowLeft", "kids-video"],
        ["who-picks", "ArrowRight", "parents-list"],
        ["parents-list", "ArrowRight", "parents-list"],
        ["parents-list", "Home", "kids-video"],
        ["ages", "End", "ref-forge"],
        ["ages", "Enter", null],
    ])("from %s, %s goes to %s", (from, key, to) => {
        expect(outlineStep(nodes, "kids-video", from, key)).toBe(to);
    });
});

// AC18 (#2247): a removed plate cools and fades while its rope slackens and drops, a merge pulls it in; under reduced
// motion each is a fade alone, as motion-still-states.test.ts asks of every loop.
describe("a plate leaving the graph", () => {
    it("cools, drops and fades with its rope slackening, then goes", () => {
        const start = leaveLook(0, false);
        const mid = leaveLook(Loops.leave.ms / 2, false);
        const end = leaveLook(Loops.leave.ms, false);
        expect(start).toMatchObject({ opacity: 1, cool: 0, drop: 0, slack: 1, pull: 0, done: false });
        expect(mid.cool).toBe(1);
        expect(mid.drop).toBeGreaterThan(0);
        expect(mid.drop).toBeLessThan(end.drop);
        expect(mid.slack).toBeGreaterThan(1);
        expect(mid.opacity).toBeGreaterThan(0);
        expect(mid.opacity).toBeLessThan(1);
        expect(mid.pull).toBeCloseTo(0.5, 5);
        expect(end).toMatchObject({ pull: 1, done: true });
        expect(end.drop).toBe(Loops.leave.drop);
    });

    it("only fades in place under reduced motion, and quickly", () => {
        const mid = leaveLook(Loops.leave.fadeMs / 2, true);
        expect(mid).toMatchObject({ cool: 0, drop: 0, slack: 1, pull: 0, scale: 1, done: false });
        expect(mid.opacity).toBeCloseTo(0.5, 5);
        expect(leaveLook(Loops.leave.fadeMs, true).done).toBe(true);
    });

    it("lets the nodes of one answer arrive one by one, and all at once under reduced motion", () => {
        expect([0, 1, 2].map((k) => arrivalDelay(k, false))).toEqual([
            0,
            Loops.arrivalStep.ms,
            2 * Loops.arrivalStep.ms,
        ]);
        expect([0, 1, 2].map((k) => arrivalDelay(k, true))).toEqual([0, 0, 0]);
    });
});

// AC7 (#2247): a click on a node, or Enter on it, brings it into focus; the developer holds the camera then.
describe("a node brought into focus", () => {
    const free = { left: 300, top: 0, width: 900, height: 700 };
    const lens = { width: 1200, height: 700, free, azimuth: 0 };
    const graph = { schema: 1, rev: 1, centre: "kids-video", nodes, links: [] } as BrainstormGraph;

    it("glides to the node, in the middle of the free space, close enough to read its branch", () => {
        const nav = new CameraNav();
        nav.focusOn([-540, 40, 0], graph, lens, 1000, false);
        const goal = nav.goal(graph, 0, lens);
        expect(goal).toMatchObject({ mode: "free", glide: true });
        expect(goal.target).toEqual([-540, 40, 0]);
        expect(goal.distance).toBeCloseTo(fitDistance(FocusRadius, free, lens.height), 5);
        const at = projectPoint([-540, 40, 0], goal, lens);
        expect(at.x).toBeCloseTo(free.left + free.width / 2, 5);
        expect(at.y).toBeCloseTo(free.top + free.height / 2, 5);
    });

    it("changes the view at once under reduced motion, with one cross-fade", () => {
        const nav = new CameraNav();
        nav.focusOn([300, 0, 0], graph, lens, 1000, true);
        expect(nav.goal(graph, 0, lens).glide).toBe(false);
        expect(nav.takeJump()).toBe(true);
        expect(nav.takeJump()).toBe(false);
    });
});

// Review of #2247: whose change a new state of the graph is, read from the lines it added.
describe("whose change a new state is", () => {
    const before = [note(1, "brokk", "add"), note(2, "you", "remove")];

    it("is the developer's only when every line it added is theirs", () => {
        expect(developerChangeOnly(before, [...before, note(3, "you", "retype"), note(4, "you", "undo")])).toBe(true);
        expect(developerChangeOnly(before, [...before, note(3, "you", "retype"), note(4, "brokk", "add")])).toBe(false);
        // A block of his that added no line (a revision of its own) is his, even after a change of the developer's.
        expect(developerChangeOnly(before, before)).toBe(false);
        expect(developerChangeOnly(null, [note(1, "you", "edit")])).toBe(true);
    });
});
