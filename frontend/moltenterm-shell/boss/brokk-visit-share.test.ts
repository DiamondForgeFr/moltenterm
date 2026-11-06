// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { EmptyVisits, VisitState } from "./brokk-visit";
import type { BrokkEvent } from "./brokk-visit-events";
import {
    adoptInto,
    EmptyShared,
    forgetIn,
    ForgottenRank,
    mergeShared,
    publishOf,
    readShared,
    sameShared,
    SharedVisit,
    sharedText,
    ToldKeepMs,
} from "./brokk-visit-share";

const T = 1_000_000_000_000;

function event(key: string): BrokkEvent {
    return { key, kind: "blocked", since: T - 600_000 };
}

function visits(extra: Partial<VisitState> = {}): VisitState {
    return {
        ...EmptyVisits,
        events: { a: { event: event("a"), source: "rows" }, b: { event: event("b"), source: "rows" } },
        ...extra,
    };
}

describe("what the views share of Brokk's visits (#2002)", () => {
    it("reads back what it wrote", () => {
        const shared: SharedVisit = { laterUntil: T + 5000, told: { a: { rank: 2, at: T } } };
        expect(readShared(sharedText(shared), T)).toEqual(shared);
    });

    it("reads anything odd as empty", () => {
        for (const raw of [null, undefined, "", "{", "[]", "3", 3, { told: 3 }]) {
            expect(sameShared(readShared(raw, T), EmptyShared), String(raw)).toBe(true);
        }
    });

    it("drops a mark that is not a rank from -1 to 3, and a mark older than a day", () => {
        const raw = {
            laterUntil: -5,
            told: {
                ok: { rank: 3, at: T },
                forgotten: { rank: -1, at: T },
                low: { rank: -2, at: T },
                high: { rank: 4, at: T },
                text: { rank: "2", at: T },
                old: { rank: 1, at: T - ToldKeepMs },
            },
        };
        expect(readShared(raw, T)).toEqual({
            laterUntil: 0,
            told: { ok: { rank: 3, at: T }, forgotten: { rank: ForgottenRank, at: T } },
        });
    });

    it("merges to the later delay and, per event, the later mark, the graver one at the same moment", () => {
        const a: SharedVisit = { laterUntil: T + 1000, told: { x: { rank: 1, at: T }, y: { rank: 3, at: T } } };
        const b: SharedVisit = { laterUntil: T + 2000, told: { x: { rank: 2, at: T }, y: { rank: 0, at: T } } };
        const merged = mergeShared(a, b, T);
        expect(merged.laterUntil).toBe(T + 2000);
        expect(merged.told.x.rank).toBe(2);
        expect(merged.told.y.rank).toBe(3);
        const newer = mergeShared(a, { laterUntil: 0, told: { y: { rank: 1, at: T + 5 } } }, T);
        expect(newer.told.y).toEqual({ rank: 1, at: T + 5 });
    });

    it("forgets what was told of an event that ended, and a copy that still holds the old mark does not bring it back", () => {
        const told: SharedVisit = { laterUntil: 0, told: { a: { rank: 2, at: T } } };
        const forgotten = forgetIn(told, ["a", "unknown"], T + 10);
        expect(forgotten.told.a).toEqual({ rank: ForgottenRank, at: T + 10 });
        expect(forgotten.told.unknown).toBeUndefined();
        expect(forgetIn(forgotten, ["a"], T + 20)).toBe(forgotten);
        expect(forgetIn(told, ["unknown"], T)).toBe(told);
        // The stale copy, merged either way, loses to the later word.
        expect(mergeShared(told, forgotten, T + 30).told.a.rank).toBe(ForgottenRank);
        expect(mergeShared(forgotten, told, T + 30).told.a.rank).toBe(ForgottenRank);
        // Told again afterwards, it counts again.
        const again = mergeShared(forgotten, { laterUntil: 0, told: { a: { rank: 2, at: T + 40 } } }, T + 50);
        expect(again.told.a.rank).toBe(2);
    });

    it("tells nothing of a forgotten event to a view that holds it", () => {
        const state = visits({ told: {} });
        const forgotten: SharedVisit = { laterUntil: 0, told: { a: { rank: ForgottenRank, at: T } } };
        expect(adoptInto(state, forgotten, T)).toBe(state);
    });

    it("keeps the very same record when the other adds nothing, and drops a delay that is over", () => {
        const a: SharedVisit = { laterUntil: T + 1000, told: { x: { rank: 2, at: T } } };
        expect(mergeShared(a, EmptyShared, T)).toBe(a);
        expect(mergeShared(a, a, T)).toBe(a);
        expect(mergeShared(a, EmptyShared, T + 1000).laterUntil).toBe(0);
    });

    it("publishes this view's delay and the marks of the events it holds, and nothing it does not hold", () => {
        const state = visits({ laterUntil: T + 9000, told: { a: 2, gone: 3 } });
        expect(publishOf(EmptyShared, state, T)).toEqual({ laterUntil: T + 9000, told: { a: { rank: 2, at: T } } });
    });

    it("publishes the very same record when it has nothing to add, whatever the time", () => {
        const shared: SharedVisit = { laterUntil: 0, told: { a: { rank: 2, at: T } } };
        expect(publishOf(shared, visits({ told: { a: 2 } }), T + 5)).toBe(shared);
        expect(publishOf(shared, visits({ told: { a: 1 } }), T + 5)).toBe(shared);
    });

    it("publishes a graver mark of an event, and tells again one that was forgotten", () => {
        const shared: SharedVisit = { laterUntil: 0, told: { a: { rank: 2, at: T } } };
        expect(publishOf(shared, visits({ told: { a: 3 } }), T + 5).told.a).toEqual({ rank: 3, at: T + 5 });
        const forgotten: SharedVisit = { laterUntil: 0, told: { a: { rank: ForgottenRank, at: T } } };
        expect(publishOf(forgotten, visits({ told: { a: 2 } }), T + 5).told.a).toEqual({ rank: 2, at: T + 5 });
    });

    it("takes a delay started elsewhere, folding the scene that is up", () => {
        const up = visits({ shown: true });
        const taken = adoptInto(up, { laterUntil: T + 5000, told: {} }, T);
        expect(taken.laterUntil).toBe(T + 5000);
        expect(taken.shown).toBe(false);
    });

    it("does not take a delay that is over, nor a shorter one", () => {
        const up = visits({ shown: true, laterUntil: T + 9000 });
        expect(adoptInto(up, { laterUntil: T + 5000, told: {} }, T)).toBe(up);
        const idle = visits();
        expect(adoptInto(idle, { laterUntil: T - 1, told: {} }, T)).toBe(idle);
    });

    it("takes the graver mark of the events it holds, and ignores the marks of events it does not", () => {
        const state = visits({ told: { a: 1 } });
        const taken = adoptInto(state, { laterUntil: 0, told: { a: { rank: 2, at: T }, z: { rank: 3, at: T } } }, T);
        expect(taken.told).toEqual({ a: 2 });
        expect(adoptInto(taken, { laterUntil: 0, told: { a: { rank: 2, at: T } } }, T)).toBe(taken);
    });
});
