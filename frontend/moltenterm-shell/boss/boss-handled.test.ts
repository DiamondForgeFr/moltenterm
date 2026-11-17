// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    checkRowHandled,
    EmptyHandled,
    episodeOf,
    HandledKeepMs,
    handledText,
    markRowHandled,
    mergeHandled,
    readHandled,
    sameHandled,
    unmarkRowHandled,
} from "./boss-handled";

const T = new Date(2026, 10, 6, 14, 0, 0).getTime();
const Day = 24 * 60 * 60 * 1000;

const wait = { key: "agent:b1", since: 1000, tone: "waiting" };

describe("the rows settled or ignored (FR-BOSS-009, AC16, #2026)", () => {
    it("hides a row for the episode it was marked on, and brings it back when the fact is new", () => {
        const marked = markRowHandled(EmptyHandled, wait, T);
        expect(checkRowHandled(marked, wait)).toBe(true);
        expect(checkRowHandled(marked, { ...wait, since: 2000 })).toBe(false);
        expect(checkRowHandled(marked, { ...wait, tone: "error" })).toBe(false);
        expect(checkRowHandled(marked, { ...wait, key: "agent:b2" })).toBe(false);
        expect(episodeOf(wait)).toBe("1000:waiting");
    });

    it("hides a row that has no start time as long as it has none", () => {
        const row = { key: "ci:/p:1", since: 0, tone: "error" };
        const marked = markRowHandled(EmptyHandled, row, T);
        expect(checkRowHandled(marked, row)).toBe(true);
        expect(checkRowHandled(marked, { ...row, since: 5 })).toBe(false);
    });

    it("reads what the storage holds, and anything odd as nothing", () => {
        const marked = markRowHandled(EmptyHandled, wait, T);
        expect(readHandled(handledText(marked), T)).toEqual(marked);
        expect(readHandled("not json", T)).toBe(EmptyHandled);
        expect(readHandled(null, T)).toBe(EmptyHandled);
        expect(readHandled("[1,2]", T)).toBe(EmptyHandled);
        expect(readHandled(JSON.stringify({ a: { episode: 3, at: T }, b: { episode: "x" } }), T)).toEqual({});
    });

    it("forgets a mark after a month, so that the shared record does not grow for ever", () => {
        const marked = markRowHandled(EmptyHandled, wait, T);
        expect(readHandled(handledText(marked), T + HandledKeepMs - 1)).toEqual(marked);
        expect(readHandled(handledText(marked), T + HandledKeepMs)).toEqual({});
        const later = markRowHandled(marked, { ...wait, key: "agent:b2" }, T + 40 * Day);
        expect(Object.keys(later)).toEqual(["agent:b2"]);
    });

    it("merges what another window wrote: per row the later mark, the same object when nothing is added", () => {
        const mine = markRowHandled(EmptyHandled, wait, T);
        const theirs = markRowHandled(EmptyHandled, { key: "ci:/p:2", since: 7, tone: "error" }, T + 1);
        const both = mergeHandled(mine, theirs, T + 2);
        expect(Object.keys(both).sort()).toEqual(["agent:b1", "ci:/p:2"]);
        expect(mergeHandled(both, mine, T + 3)).toBe(both);
        const newer = markRowHandled(EmptyHandled, { ...wait, since: 1500 }, T + 10);
        expect(mergeHandled(both, newer, T + 11)["agent:b1"].episode).toBe("1500:waiting");
        expect(sameHandled(both, { ...both })).toBe(true);
    });
});

describe("giving a row back, the undo of an archive (#2195)", () => {
    it("shows the row again, whatever episode it was marked for", () => {
        const marked = markRowHandled(EmptyHandled, wait, T);
        const back = unmarkRowHandled(marked, wait.key, T + 5);
        expect(checkRowHandled(back, wait)).toBe(false);
        expect(checkRowHandled(back, { ...wait, since: 2000 })).toBe(false);
        // A later wait is marked as any other.
        expect(checkRowHandled(markRowHandled(back, wait, T + 6), wait)).toBe(true);
    });

    it("wins over the mark it undoes in every window, even in the very same millisecond", () => {
        const marked = markRowHandled(EmptyHandled, wait, T);
        const back = unmarkRowHandled(marked, wait.key, T);
        expect(back[wait.key].at).toBeGreaterThan(marked[wait.key].at);
        const merged = mergeHandled(marked, back, T + 1);
        expect(checkRowHandled(merged, wait)).toBe(false);
        expect(checkRowHandled(mergeHandled(back, marked, T + 1), wait)).toBe(false);
    });

    it("survives the storage and is forgotten after a month like any mark", () => {
        const back = unmarkRowHandled(markRowHandled(EmptyHandled, wait, T), wait.key, T + 1);
        expect(readHandled(handledText(back), T + 2)).toEqual(back);
        expect(readHandled(handledText(back), T + 1 + HandledKeepMs)).toEqual({});
    });
});
