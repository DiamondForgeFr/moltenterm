// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { UsageReadings } from "./boss-usage";
import { neighbourTab, openingTab, PanelTabs, usageProviders } from "./brokk-panel-model";

const Now = new Date(2026, 10, 6, 10, 0, 0).getTime();

describe("the panel's tabs (FR-BOSS-009, AC9; FR-BOSS-003 as amended)", () => {
    it("lists To handle, Notifications, Sessions, Downloads and Usage, in that order", () => {
        expect(PanelTabs).toEqual(["todo", "notifications", "sessions", "downloads", "usage"]);
    });

    it("opens on To handle when the badge counts something, otherwise on the tab used last", () => {
        expect(openingTab(2, "sessions")).toBe("todo");
        expect(openingTab(0, "usage")).toBe("usage");
    });

    it("moves between tabs with the arrow keys and wraps", () => {
        expect(neighbourTab("todo", "ArrowRight")).toBe("notifications");
        expect(neighbourTab("usage", "ArrowRight")).toBe("todo");
        expect(neighbourTab("todo", "ArrowLeft")).toBe("usage");
        expect(neighbourTab("sessions", "ArrowLeft")).toBe("notifications");
        expect(neighbourTab("sessions", "Enter")).toBeNull();
    });
});

describe("the Usage tab lists the plan usage of every provider (FR-BOSS-006)", () => {
    function reading(agent: string, percents: number[], readat = Now, plan = ""): UsageReadings[string] {
        return {
            agent,
            source: "test",
            plan,
            readat,
            windows: percents.map((usedpercent, i) => ({ id: `w${i}`, label: `Window ${i}`, usedpercent })),
        };
    }

    it("puts the fullest provider first, with its plan and one row per running window", () => {
        const providers = usageProviders(
            { codex: reading("codex", [20, 35]), claude: reading("claude", [10, 80], Now, "Max") },
            Now
        );
        expect(providers.map((p) => p.id)).toEqual(["claude", "codex"]);
        expect(providers[0].plan).toBe("Max");
        expect(providers[0].rows).toHaveLength(2);
        expect(providers[0].fullest).toBe(80);
    });

    it("leaves out a provider with no running window, and says nothing without any reading", () => {
        expect(usageProviders({ claude: reading("claude", []) }, Now)).toEqual([]);
        expect(usageProviders({}, Now)).toEqual([]);
        expect(usageProviders(undefined, Now)).toEqual([]);
    });

    it("takes one reading per provider: the latest", () => {
        const providers = usageProviders(
            { a: reading("claude", [90], Now - 5000), b: reading("claude", [15], Now) },
            Now
        );
        expect(providers).toHaveLength(1);
        expect(providers[0].fullest).toBe(15);
    });
});
