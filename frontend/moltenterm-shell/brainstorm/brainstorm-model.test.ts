// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import type { MoltentermNotification } from "../notifications-model";
import {
    answerStep,
    breaksThrough,
    EmptyTally,
    newlyCrashed,
    sidebarOnClose,
    sidebarOnOpen,
    tallied,
} from "./brainstorm-model";

function entry(over: Partial<MoltentermNotification>): MoltentermNotification {
    return { id: "n1", source: "build", title: "x", kind: "info", time: 1, updated: 1, read: false, ...over };
}

function agents(states: Record<string, string>): AgentStatesData {
    const rtn: AgentStatesData = { states: {}, versions: {} };
    for (const [blockid, state] of Object.entries(states)) {
        rtn.states[blockid] = { blockid, state: state as any, firstname: `Agent ${blockid}`, version: 1 };
    }
    return rtn;
}

const opening = '```brokk-graph\n{"v":1,"talk":"project","ops":[{"op":"centre","id":"c","text":"An idea"}]}\n```';
const growing =
    '```brokk-graph\n{"v":1,"talk":"project","ops":[{"op":"add","id":"q","kind":"question","text":"Why?","from":"c"}]}\n```';

// FR-BOSS-010 AC3 (#2246): only what cannot wait breaks through, everything else waits and is counted once.
describe("the pause", () => {
    it("lets through a run refused for trust and an agent that crashed, nothing else", () => {
        expect(breaksThrough(entry({ source: "trust", kind: "warning" }))).toBe(true);
        expect(breaksThrough(entry({ source: "agent", kind: "error" }))).toBe(true);
        expect(breaksThrough(entry({ source: "sessions", kind: "error" }))).toBe(true);
        expect(breaksThrough(entry({ source: "build", kind: "error" }))).toBe(false);
        expect(breaksThrough(entry({ source: "agent", kind: "warning" }))).toBe(false);
        expect(breaksThrough(entry({ source: "trust", read: true }))).toBe(false);
        expect(breaksThrough(entry({ source: "trust", resolved: 5 }))).toBe(false);
    });

    it("sees an agent going into error, once", () => {
        expect(newlyCrashed(agents({ a: "working", b: "error" }), agents({ a: "error", b: "error" }))).toEqual(["a"]);
        expect(newlyCrashed(agents({ a: "error" }), agents({ a: "error" }))).toEqual([]);
        expect(newlyCrashed(agents({}), agents({ c: "error" }))).toEqual(["c"]);
    });

    it("counts each arrival once, and nothing that was there before the mode", () => {
        const seen = new Map([["old", 1]]);
        let tally = tallied(EmptyTally, [entry({ id: "old" }), entry({ id: "a", updated: 2 })], seen);
        expect([...tally.ids]).toEqual(["a"]);
        tally = tallied(
            tally,
            [entry({ id: "a", updated: 3 }), entry({ id: "b" }), entry({ id: "c", read: true })],
            seen
        );
        expect([...tally.ids].sort()).toEqual(["a", "b"]);
        expect(tallied(tally, [entry({ id: "a" })], seen)).toBe(tally);
    });
});

describe("the sidebar (AC2)", () => {
    it("slides in when it was docked, and comes back only if the mode slid it and it is still in", () => {
        expect(sidebarOnOpen(true, false)).toBe("slide");
        expect(sidebarOnOpen(true, true)).toBe("stay");
        expect(sidebarOnOpen(false, false)).toBe("stay");
        expect(sidebarOnClose(true, true)).toBe("restore");
        // The developer showed it during the mode: their toggle wins.
        expect(sidebarOnClose(true, false)).toBe("stay");
        expect(sidebarOnClose(false, true)).toBe("stay");
    });
});

describe("which readings of his answer go to wavesrv (AC2, AC4, AC7)", () => {
    const base = { turn: 7, final: false, open: false, allowed: true };

    it("sends nothing on a release channel", () => {
        expect(answerStep({ ...base, markdown: `Go.\n\n${opening}`, allowed: false })).toEqual({ kind: "wait" });
    });

    it("opens the mode with an answer that puts a central idea, as soon as its block is complete", () => {
        const step = answerStep({ ...base, markdown: `Let's put it on the anvil.\n\n${opening}` });
        expect(step.kind).toBe("turn");
        if (step.kind === "turn") {
            expect(step.text).toBe("Let's put it on the anvil.");
            expect(step.block.ops[0].op).toBe("centre");
            expect(step.key).toMatch(/^7:g/);
        }
        expect(answerStep({ ...base, markdown: "Let's put it on the anvil.\n\n```brokk-graph\n{" }).kind).toBe("wait");
    });

    it("leaves a normal exchange alone outside the mode", () => {
        expect(answerStep({ ...base, markdown: "Ten past two.", final: true }).kind).toBe("wait");
        expect(answerStep({ ...base, markdown: `More.\n\n${growing}`, final: true }).kind).toBe("wait");
    });

    it("keeps the words of every turn of the mode, once his answer is complete", () => {
        expect(answerStep({ ...base, open: true, markdown: "Hm, let me think" }).kind).toBe("wait");
        const step = answerStep({ ...base, open: true, final: true, markdown: "Noted." });
        expect(step).toMatchObject({ kind: "turn", text: "Noted.", block: null, dropped: "" });
    });

    it("keeps the words of a turn whose block was dropped, and says why without its content", () => {
        const step = answerStep({
            ...base,
            open: true,
            final: true,
            markdown: "Noted.\n\n```brokk-graph\n{secret\n```",
        });
        expect(step).toMatchObject({ kind: "turn", text: "Noted.", block: null, dropped: "not JSON" });
    });

    it("names an answer the same way at every reading, so it is applied once", () => {
        const a = answerStep({ ...base, open: true, markdown: `More.\n\n${growing}` });
        const b = answerStep({ ...base, open: true, final: true, markdown: `More.\n\n${growing}` });
        expect(a.kind === "turn" && b.kind === "turn" && a.key === b.key).toBe(true);
    });
});
