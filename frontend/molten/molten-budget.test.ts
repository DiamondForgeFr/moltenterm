// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { translate } from "../moltenterm-shell/i18n/i18n-core";
import {
    budgetReasonText,
    judgeBudget,
    modIdForScript,
    MoltenBudgetMemoryMB,
    MoltenBudgetMinSpanMs,
    MoltenBudgetWindowMs,
    MoltenModMeter,
} from "./molten-budget";

function makeMeter() {
    const clock = { t: 0 };
    const meter = new MoltenModMeter(() => clock.t);
    // A callback that keeps the CPU for ms.
    const busy = (ms: number, idle = true) =>
        meter.measure(() => {
            clock.t += ms;
        }, idle);
    return { clock, meter, busy };
}

describe("MoltenModMeter", () => {
    it("counts script time and idle CPU over the window", () => {
        const { clock, meter, busy } = makeMeter();
        for (let i = 0; i < 30; i++) {
            clock.t += 950;
            busy(50);
        }
        expect(meter.scriptMs).toBe(1500);
        expect(meter.cpuPct(clock.t)).toBeCloseTo(5, 5);
        expect(meter.usage(clock.t)).toMatchObject({ cpupct: 5, over: true });
        expect(meter.usage(clock.t).reason).toContain("5.0 % CPU while idle over the last 30 s (budget 2 %)");
    });

    it("does not count a command the user ran as idle CPU", () => {
        const { clock, meter, busy } = makeMeter();
        clock.t = MoltenBudgetWindowMs;
        busy(5000, false);
        expect(meter.scriptMs).toBe(5000);
        expect(meter.cpuPct(clock.t)).toBe(0);
        expect(meter.usage(clock.t).over).toBe(false);
    });

    it("does not judge a mod younger than the minimum span", () => {
        const { clock, meter, busy } = makeMeter();
        busy(500);
        expect(meter.cpuPct(clock.t)).toBeNull();
        clock.t = MoltenBudgetMinSpanMs;
        expect(meter.cpuPct(clock.t)).toBeCloseTo(5, 5);
    });

    it("forgets work older than the window", () => {
        const { clock, meter, busy } = makeMeter();
        clock.t = 20000;
        busy(3000);
        expect(meter.usage(clock.t).over).toBe(true);
        clock.t += MoltenBudgetWindowMs;
        expect(meter.cpuPct(clock.t)).toBe(0);
        expect(meter.usage(clock.t).over).toBe(false);
    });

    it("takes the larger of host-measured and long-frame time, never their sum", () => {
        const { clock, meter, busy } = makeMeter();
        clock.t = MoltenBudgetWindowMs;
        busy(300);
        meter.addLongFrameScript(300, clock.t);
        expect(meter.cpuPct(clock.t)).toBeCloseTo(1, 5);
        meter.addLongFrameScript(600, clock.t);
        expect(meter.cpuPct(clock.t)).toBeCloseTo(3, 5);
    });

    it("judges the memory of the activation", () => {
        expect(judgeBudget(0.5, MoltenBudgetMemoryMB + 5)).toBe("25 MB of memory at activation (budget 20 MB)");
        expect(judgeBudget(0.5, 3)).toBeNull();
        expect(judgeBudget(null, null)).toBeNull();
    });
});

describe("modIdForScript", () => {
    it("finds the mod from its blob URL or its molten-mod source name", () => {
        const owners = new Map([["blob:file:///abc", "heavy"]]);
        expect(modIdForScript("blob:file:///abc", owners)).toBe("heavy");
        expect(modIdForScript("molten-mod://copy-box/main.js", owners)).toBe("copy-box");
        expect(modIdForScript("file:///app/index.js", owners)).toBeNull();
        expect(modIdForScript("", owners)).toBeNull();
    });
});

describe("budget reason in the interface language (#656)", () => {
    const fr = (key: string, vars?: Record<string, string>) => translate("fr", key, vars);
    const en = (key: string, vars?: Record<string, string>) => translate("en", key, vars);
    const over = { activatems: 1, scriptms: 1, cpupct: 3.5, timers: 0, heapmb: 25, over: true, reason: "English" };

    it("words both overruns", () => {
        expect(budgetReasonText(over, fr)).toBe(
            "3.5 % de CPU au repos sur les 30 dernières s (budget 2 %) ; 25 Mo de mémoire à l'activation (budget 20 Mo)"
        );
        expect(budgetReasonText(over, en)).toBe(
            "3.5 % CPU while idle over the last 30 s (budget 2 %); 25 MB of memory at activation (budget 20 MB)"
        );
    });

    it("writes its numbers in the interface language's notation (#741)", () => {
        expect(budgetReasonText({ ...over, heapmb: 25.25 }, fr, "fr")).toBe(
            "3,5 % de CPU au repos sur les 30 dernières s (budget 2 %) ; 25,3 Mo de mémoire à l'activation (budget 20 Mo)"
        );
    });

    it("says nothing for a mod within its budget", () => {
        expect(budgetReasonText({ ...over, over: false }, fr)).toBe("");
        expect(budgetReasonText(null, fr)).toBe("");
    });
});
