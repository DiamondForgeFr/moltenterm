// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    applyKeepAwakeState,
    cleanSleepPolicy,
    coffeeCondition,
    coffeeOf,
    coffeeSupported,
    coffeeTooltip,
    EmptyKeepAwakeState,
    formatCountdown,
    KeepAwakeAttempt,
    keepAwakeCount,
    keepAwakeSessions,
    KeepAwakeState,
    railCoffeeLabel,
    sleepPolicyChoices,
} from "./keepawake-model";

function state(partial: Partial<KeepAwakeState>): KeepAwakeState {
    return { ...EmptyKeepAwakeState, version: 1, ...partial };
}

function attempt(partial: Partial<KeepAwakeAttempt>): KeepAwakeAttempt {
    return { id: "1", blockid: "b1", tool: "caffeinate", pid: 10, since: 0, outcome: "allowed", ...partial };
}

describe("keep-awake model", () => {
    it("keeps the newer state", () => {
        const newer = state({ version: 5, hold: true });
        expect(applyKeepAwakeState(EmptyKeepAwakeState, newer)).toMatchObject({ version: 5, hold: true });
        const older = state({ version: 4 });
        expect(applyKeepAwakeState(newer, older)).toBe(newer);
        expect(applyKeepAwakeState(newer, null)).toBe(newer);
        // A state without lists still reads as empty lists.
        const bare = { version: 6, hold: false, policy: "" } as KeepAwakeState;
        expect(applyKeepAwakeState(newer, bare)).toMatchObject({ coffees: [], attempts: [], overrides: [] });
    });

    it("names the coffee bud for its state (FR-SHELL-023-AC8)", () => {
        expect(railCoffeeLabel("Notulia", false, "darwin")).toBe("Keep the Mac awake while Notulia works");
        expect(railCoffeeLabel("Notulia", true, "darwin")).toBe("Stop keeping the Mac awake for Notulia");
        expect(railCoffeeLabel("Notulia", false, "linux")).toBe("Keep the computer awake while Notulia works");
        expect(coffeeSupported("darwin")).toBe(true);
        expect(coffeeSupported("linux")).toBe(true);
        expect(coffeeSupported("win32")).toBe(false);
    });

    it("tells a coffee's condition", () => {
        const working = { workspaceid: "a", since: 0, working: true };
        const grace = { workspaceid: "a", since: 0, working: false, endsat: 120_000 };
        expect(coffeeCondition(working, 0)).toBe("until its work ends");
        expect(coffeeCondition(grace, 1_000)).toBe("ending in 1:59");
        expect(formatCountdown(10_000, 20_000)).toBe("0:00");
        expect(formatCountdown(65_500, 0)).toBe("1:06");
        expect(coffeeTooltip(working, "A", "darwin", 0)).toBe("Keeping the Mac awake until the work in A ends");
        expect(coffeeTooltip(grace, "A", "darwin", 60_000)).toContain("ending in 1:00");
    });

    it("finds a workspace's coffee", () => {
        const s = state({ coffees: [{ workspaceid: "a", since: 1, working: true }] });
        expect(coffeeOf(s, "a")?.since).toBe(1);
        expect(coffeeOf(s, "b")).toBeNull();
    });

    it("counts MoltenTerm once and each session whose block went through (FR-SHELL-022-AC7)", () => {
        const s = state({
            hold: true,
            coffees: [
                { workspaceid: "a", since: 1, working: true },
                { workspaceid: "b", since: 2, working: true },
            ],
            attempts: [
                attempt({ id: "1", blockid: "b1" }),
                attempt({ id: "2", blockid: "b1" }),
                attempt({ id: "3", blockid: "b2", outcome: "neutralised" }),
                attempt({ id: "4", blockid: "b3" }),
            ],
        });
        expect(keepAwakeCount(s)).toBe(3);
        expect(keepAwakeCount(state({}))).toBe(0);
    });

    it("lists the sessions with their blocks and overrides", () => {
        const s = state({
            attempts: [
                attempt({ id: "1", blockid: "b1", tabname: "Tab", workspacename: "WS" }),
                attempt({ id: "2", blockid: "b1" }),
            ],
            overrides: [
                { blockid: "b1", policy: "allow" },
                { blockid: "b9", policy: "letsleep", tabname: "Other" },
            ],
        });
        const sessions = keepAwakeSessions(s);
        expect(sessions.map((x) => [x.blockid, x.label, x.attempts.length, x.override?.policy])).toEqual([
            ["b1", "Tab · WS", 2, "allow"],
            ["b9", "Other", 0, "letsleep"],
        ]);
    });

    it("spells out the work rule next to Until work ends (FR-SHELL-023-AC1)", () => {
        const choices = sleepPolicyChoices("darwin");
        expect(choices.map((c) => c.policy)).toEqual(["allow", "untilworkends", "letsleep"]);
        expect(choices[1].detail).toContain("waiting for input is not work");
        expect(cleanSleepPolicy("letsleep")).toBe("letsleep");
        expect(cleanSleepPolicy("never")).toBeNull();
    });
});
