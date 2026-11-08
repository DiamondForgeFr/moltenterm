// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("./workspace-project", () => ({ ProjectMetaKey: "molten:project", WorkspaceFolderMetaKey: "molten:folder" }));

import {
    applyKeepAwakeState,
    askAnswerSettings,
    automaticHoldingLine,
    AutomaticSetting,
    coffeeCondition,
    coffeeOf,
    coffeeReason,
    coffeeSupported,
    coffeeTooltip,
    EmptyKeepAwakeState,
    formatCountdown,
    formatTimeLeft,
    holdLine,
    keepAwakeActive,
    KeepAwakeAttempt,
    keepAwakeCount,
    keepAwakeCountLabel,
    keepAwakeHolds,
    keepAwakeSessions,
    KeepAwakeState,
    keepAwakeStatus,
    railCoffeeLabel,
    reasonsText,
    sessionWhere,
    TerminalRequestsSetting,
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
        const bare = { version: 6, hold: false, automatic: false } as KeepAwakeState;
        expect(applyKeepAwakeState(newer, bare)).toMatchObject({ coffees: [], attempts: [], overrides: [] });
    });

    it("names the coffee bud for its state (FR-SHELL-023-AC8)", () => {
        expect(railCoffeeLabel("Notulia", false, "darwin")).toBe("Keep this computer awake for Notulia");
        expect(railCoffeeLabel("Notulia", true, "darwin")).toBe("Stop keeping this computer awake for Notulia");
        expect(railCoffeeLabel("Notulia", false, "linux")).toBe("Keep this computer awake for Notulia");
        expect(coffeeSupported("darwin")).toBe(true);
        expect(coffeeSupported("linux")).toBe(true);
        expect(coffeeSupported("win32")).toBe(false);
    });

    it("tells that the Manual switch holds until it is turned off, whether or not work runs (FR-SHELL-023 AC14)", () => {
        const working = { workspaceid: "a", since: 0, working: true };
        const idle = { workspaceid: "a", since: 0, working: false };
        expect(coffeeCondition()).toBe("until you turn it off");
        expect(formatCountdown(10_000, 20_000)).toBe("0:00");
        expect(formatCountdown(65_500, 0)).toBe("1:06");
        expect(coffeeTooltip(working, "A")).toBe("Keeping this computer awake for A until you turn it off");
        expect(coffeeTooltip(idle, "A")).toBe("Keeping this computer awake for A until you turn it off");
    });

    it("says why the computer is kept awake (#493)", () => {
        const background = {
            workspaceid: "a",
            since: 0,
            working: true,
            reasons: ["Claude Code: background work", "Command: go test ./..."],
        };
        expect(coffeeReason(background)).toBe("Claude Code: background work, Command: go test ./...");
        expect(coffeeTooltip(background, "A")).toBe(
            "Keeping this computer awake for A until you turn it off\nNow: Claude Code: background work, Command: go test ./..."
        );
        // Once nothing runs there is no reason, even a stale one.
        const idle = { ...background, working: false };
        expect(coffeeReason(idle)).toBe("");
        expect(coffeeTooltip(idle, "A")).not.toContain("Now:");
        expect(reasonsText(undefined)).toBe("");
        const holding = state({
            automaticholding: true,
            automaticworking: true,
            automaticreasons: ["Claude Code: background work"],
        });
        expect(automaticHoldingLine(holding, 0)).toBe(
            "Holding this computer awake while work runs (Claude Code: background work)"
        );
        expect(automaticHoldingLine(state({ automaticholding: true, automaticworking: true }), 0)).toBe(
            "Holding this computer awake while work runs"
        );
        expect(automaticHoldingLine(state({ automaticholding: true, automaticendsat: 60_000 }), 0)).toBe(
            "Holding this computer awake, ending in 1:00"
        );
        expect(automaticHoldingLine(state({}), 0)).toBe("");
    });

    it("finds a workspace's coffee", () => {
        const s = state({ coffees: [{ workspaceid: "a", since: 1, working: true }] });
        expect(coffeeOf(s, "a")?.since).toBe(1);
        expect(coffeeOf(s, "b")).toBeNull();
    });

    it("counts one reason per row of the menu: terminals let through, coffees, the setting (#1780)", () => {
        const s = state({
            hold: true,
            coffees: [
                { workspaceid: "a", since: 1, working: true },
                { workspaceid: "b", since: 2, working: true },
            ],
            automaticholding: true,
            automaticworking: true,
            attempts: [
                attempt({ id: "1", blockid: "b1" }),
                attempt({ id: "2", blockid: "b1" }),
                attempt({ id: "3", blockid: "b2", outcome: "neutralised" }),
                attempt({ id: "4", blockid: "b3" }),
            ],
        });
        const holds = keepAwakeHolds(s, 0);
        expect(holds.map((h) => h.key)).toEqual(["terminal:b1", "terminal:b3", "coffee:a", "coffee:b", "work"]);
        expect(keepAwakeCount(s)).toBe(holds.length);
        expect(keepAwakeHolds(s).length).toBe(holds.length);
        expect(keepAwakeCount(state({}))).toBe(0);
        expect(keepAwakeCount(state({ attempts: [attempt({ outcome: "neutralised" })] }))).toBe(0);
        // A hold wavesrv reports without a coffee or the setting is still one reason, never zero.
        expect(keepAwakeHolds(state({ hold: true })).map((h) => h.label)).toEqual(["MoltenTerm"]);
    });

    it("counts the developer's case of #1780 as the menu lists it", () => {
        const s = state({
            hold: true,
            attempts: [
                attempt({
                    blockid: "b1",
                    tabname: "Scoping",
                    workspacename: "MoltenTerm",
                    args: ["-i", "-t", "9600"],
                    endsat: 9_600_000,
                    stoppable: true,
                }),
            ],
            coffees: [
                { workspaceid: "ws", workspacename: "MoltenTerm", since: 1, working: true, reasons: ["Léa: working"] },
            ],
            automaticholding: true,
            automaticworking: true,
            automaticreasons: ["Alexis: working", "Arthur: working"],
        });
        const lines = keepAwakeHolds(s, 0).map(holdLine);
        expect(lines).toEqual([
            "Terminal in “Scoping” · caffeinate -i -t 9600 · 2 h 40 left · MoltenTerm",
            "MoltenTerm · manual, until you turn it off: Léa: working",
            "Automatic · until the work ends: Alexis: working, Arthur: working",
        ]);
        expect(keepAwakeCountLabel(lines.length)).toBe("3 reasons keep this computer awake");
        expect(keepAwakeCountLabel(1)).toBe("1 reason keeps this computer awake");
    });

    it("offers Show on terminals and Stop only where MoltenTerm can end the hold (#1780)", () => {
        const s = state({
            attempts: [
                attempt({ id: "1", blockid: "bare", stoppable: true }),
                attempt({ id: "2", blockid: "wrapped", tool: "caffeinate", args: ["-i", "make"] }),
            ],
            coffees: [{ workspaceid: "a", since: 1, working: false }],
            automaticholding: true,
            automaticendsat: 60_000,
        });
        const holds = keepAwakeHolds(s, 0);
        expect(holds.map((h) => [h.kind, h.canStop])).toEqual([
            ["terminal", true],
            ["terminal", false],
            ["coffee", true],
            ["work", false],
        ]);
        expect(holds[0].blockid).toBe("bare");
        expect(holds[1].detail).toBe("caffeinate -i make");
        expect(holds[2].detail).toBe("manual, until you turn it off");
        expect(holds[3].detail).toBe("the work is done: ending in 1:00");
        expect(holds.find((h) => h.blockid === "bare").label).toBe("A terminal");
    });

    it("says how long a hold still lasts, rounded up", () => {
        expect(formatTimeLeft(45_000, 0)).toBe("45 s");
        expect(formatTimeLeft(61_000, 0)).toBe("2 min");
        expect(formatTimeLeft(9_600_000, 0)).toBe("2 h 40");
        expect(formatTimeLeft(3_660_000, 0)).toBe("1 h 01");
        expect(formatTimeLeft(0, 5_000)).toBe("0 s");
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

    it("holds the configuration of keep-awake in the Energy group of Preferences (FR-SHELL-023 AC15, #2089)", () => {
        const catalog = settingsCatalog("darwin").filter((e) => e.group === "Energy");
        expect(catalog.map((e) => e.key)).toEqual([
            AutomaticSetting,
            "power:graceminutes",
            "power:workagents",
            "power:workcommands",
            "power:workprojects",
            TerminalRequestsSetting,
        ]);
        const requests = catalog.find((e) => e.key === TerminalRequestsSetting);
        expect(requests.options.map((o) => o.value)).toEqual(["always", "never"]);
        expect(requests.unsetLabel).toBe("Ask the first time");
        // The setting the two modes replace stays out of the screen.
        expect(settingsCatalog("darwin").some((e) => e.key === "power:sleeppolicy")).toBe(false);
    });

    it("maps the answers of the ask-once notification to the settings that replace the policy (AC19)", () => {
        expect(askAnswerSettings("allow")).toEqual({ [TerminalRequestsSetting]: "always" });
        expect(askAnswerSettings("untilworkends")).toEqual({
            [AutomaticSetting]: true,
            [TerminalRequestsSetting]: "always",
        });
        expect(askAnswerSettings("letsleep")).toEqual({ [TerminalRequestsSetting]: "never" });
        expect(askAnswerSettings("never")).toBeNull();
    });

    it("is active only while something keeps the computer awake (FR-SHELL-103-AC1)", () => {
        expect(keepAwakeActive(state({}))).toBe(false);
        expect(keepAwakeActive(state({ attempts: [attempt({ outcome: "neutralised" })] }))).toBe(false);
        expect(keepAwakeActive(state({ attempts: [attempt({})] }))).toBe(true);
        expect(keepAwakeActive(state({ hold: true }))).toBe(true);
    });

    // #2089: the first line is the real state and its cause, whatever the Manual switch says, and the face's mark, the
    // rail's dot and the cup read the very same answer (keepAwakeActive).
    describe("the real state and its cause, before any switch (FR-BOSS-009 AC44)", () => {
        const working = { automatic: true, automaticholding: true, automaticworking: true };

        it("states the computer is kept awake by Automatic while agents work, with the switch off", () => {
            const s = state({ ...working, automaticreasons: ["Léa: working", "Juliette: working"] });
            const status = keepAwakeStatus(s, 0);
            expect(coffeeOf(s, "ws1")).toBeNull();
            expect(status.awake).toBe(true);
            expect(status.headline).toBe("This computer stays awake");
            expect(status.cause).toBe("Automatic (Léa: working, Juliette: working)");
            expect(keepAwakeActive(s)).toBe(status.awake);
        });

        it("states the computer is not kept awake when both modes are off", () => {
            const s = state({ automatic: false, requests: "never" });
            const status = keepAwakeStatus(s, 0);
            expect(status.awake).toBe(false);
            expect(status.headline).toBe("Not keeping this computer awake");
            expect(status.cause).toBe("Automatic and manual are off.");
            expect(keepAwakeActive(s)).toBe(status.awake);
        });

        it("says Automatic is on while nothing works, and that the work is done while it is in its grace", () => {
            const idle = keepAwakeStatus(state({ automatic: true }), 0);
            expect(idle).toMatchObject({ awake: false, cause: "Automatic is on, and nothing works now." });
            const grace = state({ automatic: true, automaticholding: true, automaticendsat: 90_000 });
            expect(keepAwakeStatus(grace, 30_000)).toMatchObject({
                awake: true,
                cause: "Automatic (the work is done: ending in 1:00)",
            });
        });

        it("names Manual, with its workspaces, and the terminals that asked, each beside Automatic", () => {
            const coffee = { workspaceid: "a", workspacename: "Alpha", since: 1, working: false };
            expect(keepAwakeStatus(state({ coffees: [coffee] }), 0).cause).toBe("Manual (Alpha)");
            const all = state({
                ...working,
                coffees: [coffee, { ...coffee, workspaceid: "b", workspacename: "Beta" }],
                attempts: [attempt({ blockid: "b1" }), attempt({ id: "2", blockid: "b2" })],
            });
            expect(keepAwakeStatus(all, 0).cause).toBe("Automatic · Manual (Alpha, Beta) · 2 terminals that asked");
            expect(keepAwakeStatus(state({ attempts: [attempt({})] }), 0).cause).toBe("A terminal that asked");
        });

        it("agrees with the face's mark in every case", () => {
            const cases = [
                state({}),
                state({ automatic: true }),
                state({ ...working }),
                state({ coffees: [{ workspaceid: "a", since: 1, working: false }] }),
                state({ attempts: [attempt({})] }),
                state({ attempts: [attempt({ outcome: "neutralised" })] }),
                state({ hold: true }),
            ];
            for (const s of cases) {
                expect(keepAwakeStatus(s, 0).awake).toBe(keepAwakeActive(s));
            }
        });
    });

    it("names what keeps it awake, one row per reason (FR-SHELL-103-AC2, AC4, #1780)", () => {
        const working = state({
            automaticholding: true,
            automaticworking: true,
            automaticreasons: ["Adrien: working"],
        });
        expect(keepAwakeHolds(working, 0).map(holdLine)).toEqual(["Automatic · until the work ends: Adrien: working"]);
        expect(keepAwakeHolds(state({ automaticholding: true, automaticworking: true }), 0).map(holdLine)).toEqual([
            "Automatic · until the work ends",
        ]);
        const coffee = { workspaceid: "a", workspacename: "Alpha", since: 1, working: true };
        expect(
            keepAwakeHolds(state({ coffees: [coffee, { ...coffee, workspaceid: "b", workspacename: "Beta" }] })).map(
                (h) => h.label
            )
        ).toEqual(["Alpha", "Beta"]);
    });
});
