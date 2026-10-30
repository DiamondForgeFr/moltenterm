// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("./workspace-project", () => ({ ProjectMetaKey: "molten:project", WorkspaceFolderMetaKey: "molten:folder" }));

import {
    applyKeepAwakeState,
    cleanSleepPolicy,
    coffeeCondition,
    coffeeOf,
    coffeeReason,
    coffeeSupported,
    coffeeTooltip,
    EmptyKeepAwakeState,
    formatCountdown,
    keepAwakeActive,
    KeepAwakeAttempt,
    keepAwakeCount,
    keepAwakeIndicatorLabel,
    keepAwakeReasons,
    keepAwakeSessions,
    KeepAwakeState,
    policyHoldingLine,
    railCoffeeLabel,
    reasonsText,
    sessionWhere,
    SleepPolicySetting,
    sleepPolicyDetail,
    sleepPolicyLabel,
} from "./keepawake-model";
import { settingsCatalog } from "./settings/settings-catalog";

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
        expect(railCoffeeLabel("Notulia", false, "darwin")).toBe("Keep this computer awake while Notulia works");
        expect(railCoffeeLabel("Notulia", true, "darwin")).toBe("Stop keeping this computer awake for Notulia");
        expect(railCoffeeLabel("Notulia", false, "linux")).toBe("Keep this computer awake while Notulia works");
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
        expect(coffeeTooltip(working, "A", "darwin", 0)).toBe("Keeping this computer awake until the work in A ends");
        expect(coffeeTooltip(grace, "A", "darwin", 60_000)).toContain("ending in 1:00");
    });

    it("says why the computer is kept awake (#493)", () => {
        const background = {
            workspaceid: "a",
            since: 0,
            working: true,
            reasons: ["Claude Code: background work", "Command: go test ./..."],
        };
        expect(coffeeReason(background)).toBe("Claude Code: background work, Command: go test ./...");
        expect(coffeeTooltip(background, "A", "darwin", 0)).toBe(
            "Keeping this computer awake until the work in A ends\nNow: Claude Code: background work, Command: go test ./..."
        );
        // In its grace nothing runs: no reason, even a stale one.
        const grace = { ...background, working: false, endsat: 120_000 };
        expect(coffeeReason(grace)).toBe("");
        expect(coffeeTooltip(grace, "A", "darwin", 0)).not.toContain("Now:");
        expect(reasonsText(undefined)).toBe("");
        const holding = state({
            policyholding: true,
            policyworking: true,
            policyreasons: ["Claude Code: background work"],
        });
        expect(policyHoldingLine(holding, "darwin", 0)).toBe(
            "Holding this computer awake while work runs (Claude Code: background work)"
        );
        expect(policyHoldingLine(state({ policyholding: true, policyworking: true }), "linux", 0)).toBe(
            "Holding this computer awake while work runs"
        );
        expect(policyHoldingLine(state({ policyholding: true, policyendsat: 60_000 }), "darwin", 0)).toBe(
            "Holding this computer awake, ending in 1:00"
        );
        expect(policyHoldingLine(state({}), "darwin", 0)).toBe("");
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

    it("names a default view never renamed by its name, not its key (#1311)", () => {
        const s = state({
            attempts: [attempt({ id: "1", blockid: "b1", tabname: "workspaceViews.names.integration" })],
        });
        expect(keepAwakeSessions(s)[0].label).toBe("Integration");
        expect(
            sessionWhere({
                workspaceid: "ws",
                blockid: "b1",
                tabname: "workspaceViews.names.scoping",
                agent: "claude",
                agentname: "Claude Code",
                approved: true,
            })
        ).toContain("Scoping");
    });

    it("spells out the work rule next to Until work ends (FR-SHELL-023-AC1)", () => {
        const detail = sleepPolicyDetail("untilworkends");
        expect(detail).toContain("still busy with background subagents or commands after its turn");
        expect(detail).toContain("waiting for input with nothing running is not work");
        expect(sleepPolicyDetail("allow")).toBe("A terminal that asks to stay awake is always heard.");
        expect(cleanSleepPolicy("letsleep")).toBe("letsleep");
        expect(cleanSleepPolicy("never")).toBeNull();
    });

    it("words the four options once: the indicator and the menu read Preferences' labels (FR-SHELL-103-AC3)", () => {
        const entry = settingsCatalog("darwin").find((e) => e.key === SleepPolicySetting);
        expect(entry.group).toBe("Energy");
        for (const option of entry.options) {
            expect(sleepPolicyLabel(option.value)).toBe(option.label);
        }
        expect(sleepPolicyLabel("")).toBe(entry.unsetLabel);
        expect(entry.options.map((o) => o.value)).toEqual(["allow", "untilworkends", "letsleep"]);
    });

    it("is active only while something keeps the computer awake (FR-SHELL-103-AC1)", () => {
        expect(keepAwakeActive(state({}))).toBe(false);
        expect(keepAwakeActive(state({ attempts: [attempt({ outcome: "neutralised" })] }))).toBe(false);
        expect(keepAwakeActive(state({ attempts: [attempt({})] }))).toBe(true);
        expect(keepAwakeActive(state({ hold: true }))).toBe(true);
    });

    it("names what keeps it awake, with plurals (FR-SHELL-103-AC2, AC4)", () => {
        const coffee = { workspaceid: "a", workspacename: "Alpha", since: 1, working: true };
        expect(keepAwakeReasons(state({ attempts: [attempt({})] }))).toEqual(["a terminal asked to stay awake"]);
        expect(
            keepAwakeReasons(
                state({
                    hold: true,
                    attempts: [attempt({ id: "1", blockid: "b1" }), attempt({ id: "2", blockid: "b2" })],
                    coffees: [coffee],
                    policyholding: true,
                })
            )
        ).toEqual(["2 terminals asked to stay awake", "kept awake by you in Alpha", "work is running"]);
        expect(keepAwakeReasons(state({ coffees: [coffee, { ...coffee, workspaceid: "b" }] }))).toEqual([
            "kept awake by you in 2 workspaces",
        ]);
        const s = state({ attempts: [attempt({})] });
        expect(keepAwakeIndicatorLabel(s)).toBe("Keeping this computer awake: a terminal asked to stay awake");
    });
});
