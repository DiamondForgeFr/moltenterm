// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import {
    errorKeys,
    expressionAfterAnswer,
    LongWaitMs,
    longWaits,
    mergedCount,
    newFailure,
    rose,
    stillWaiting,
} from "./brokk-expression-model";

function agents(...infos: Partial<AgentStateInfo>[]): AgentStatesData {
    const states: Record<string, AgentStateInfo> = {};
    for (const info of infos) {
        states[info.blockid] = { version: 1, ...info } as AgentStateInfo;
    }
    return { states, versions: {} };
}

describe("a frown when an agent fails (FR-BOSS-007, AC3)", () => {
    it("keys a failure by its block and the time it began, and ignores the other states", () => {
        const data = agents(
            { blockid: "a", state: "error", since: 100 },
            { blockid: "b", state: "working", since: 100 },
            { blockid: "c", state: "waiting", since: 100 }
        );
        expect([...errorKeys(data)]).toEqual(["a:100"]);
        expect(errorKeys(null).size).toBe(0);
    });

    it("tells a failure that was not there at the last reading", () => {
        const none = errorKeys(agents());
        const one = errorKeys(agents({ blockid: "a", state: "error", since: 100 }));
        const two = errorKeys(
            agents({ blockid: "a", state: "error", since: 100 }, { blockid: "b", state: "error", since: 200 })
        );
        expect(newFailure(none, one)).toBe(true);
        expect(newFailure(one, two)).toBe(true);
        expect(newFailure(two, two)).toBe(false);
        expect(newFailure(two, one)).toBe(false);
    });

    it("tells a block that fails again after it recovered", () => {
        const first = errorKeys(agents({ blockid: "a", state: "error", since: 100 }));
        const again = errorKeys(agents({ blockid: "a", state: "error", since: 900 }));
        expect(newFailure(first, again)).toBe(true);
    });

    it("tells nothing at the first reading: an agent that failed before the window opened is not news", () => {
        expect(newFailure(null, errorKeys(agents({ blockid: "a", state: "error", since: 100 })))).toBe(false);
    });
});

describe("a doubtful look after a long wait (AC3)", () => {
    const now = 10_000_000;

    it("tells a wait that crossed the limit, once", () => {
        const data = agents({ blockid: "a", state: "waiting", since: now - LongWaitMs });
        const first = longWaits(data, now, new Set());
        expect(first.due).toEqual([`a:${now - LongWaitMs}`]);
        expect(longWaits(data, now, new Set(first.due)).due).toEqual([]);
    });

    it("says when the next wait crosses the limit, the nearest one", () => {
        const data = agents(
            { blockid: "a", state: "waiting", since: now - 1000 },
            { blockid: "b", state: "waiting", since: now - 5000 },
            { blockid: "c", state: "working", since: now - LongWaitMs * 2 }
        );
        const waits = longWaits(data, now, new Set());
        expect(waits.due).toEqual([]);
        expect(waits.nextAt).toBe(now - 5000 + LongWaitMs);
    });

    it("has no next time when nobody waits, or the wait has no start", () => {
        expect(longWaits(agents(), now, new Set()).nextAt).toBeNull();
        expect(longWaits(agents({ blockid: "a", state: "waiting" }), now, new Set()).nextAt).toBeNull();
        expect(longWaits(null, now, new Set()).due).toEqual([]);
    });

    it("forgets the waits that ended, so that a block that waits again is told again", () => {
        const waiting = agents({ blockid: "a", state: "waiting", since: 100 });
        const told = new Set(["a:100", "gone:5"]);
        expect([...stillWaiting(waiting, told)]).toEqual(["a:100"]);
        expect(stillWaiting(agents({ blockid: "a", state: "working", since: 100 }), told).size).toBe(0);
    });
});

describe("a smile when a pull request merges", () => {
    it("counts the pull requests merged, in every project", () => {
        expect(mergedCount({ "/a": { merged: [1, 2] }, "/b": { merged: [3] }, "/c": {} })).toBe(3);
        expect(mergedCount({})).toBe(0);
        expect(mergedCount(null)).toBe(0);
    });

    it("tells a rise since the last reading, and none at the first", () => {
        expect(rose(null, 3)).toBe(false);
        expect(rose(0, 1)).toBe(true);
        expect(rose(2, 2)).toBe(false);
        expect(rose(3, 1)).toBe(false);
    });
});

describe("what the developer's answer tells him", () => {
    it("smiles at a hand-off approved, once or always", () => {
        expect(expressionAfterAnswer({ kind: "handoff", decision: "once" })).toBe("smile");
        expect(expressionAfterAnswer({ kind: "handoff", decision: "always" })).toBe("smile");
    });

    it("says nothing of a hand-off refused or dismissed", () => {
        expect(expressionAfterAnswer({ kind: "handoff", decision: "block" })).toBeNull();
        expect(expressionAfterAnswer({ kind: "handoff", decision: "dismiss" })).toBeNull();
    });

    it("nods at an answer given to an agent", () => {
        expect(expressionAfterAnswer({ kind: "answer" })).toBe("nod");
    });

    it("says nothing of the other buttons", () => {
        for (const kind of ["rerun", "done", "later", "goto", "integration", "external", "open", "brief"]) {
            expect(expressionAfterAnswer({ kind })).toBeNull();
        }
    });
});
