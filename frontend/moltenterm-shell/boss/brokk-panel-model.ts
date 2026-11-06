// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's panel (FR-BOSS-009, AC9, #2003): its tabs, the request a surface makes to show one, and the plan usage the
// Usage tab lists. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { GaugeRow, gaugeRows } from "../companion/companion-gauges-model";
import type { UsageReadings } from "./boss-usage";

export type PanelTab = "todo" | "notifications" | "sessions" | "downloads" | "usage";

// The tabs in the order they read (FR-BOSS-003, AC1 as amended for #2003).
export const PanelTabs: PanelTab[] = ["todo", "notifications", "sessions", "downloads", "usage"];

// A surface asks for a tab (a toast's Open, the downloads pill): seq tells two requests for the same tab apart, and
// highlight names the notifications to mark when the request is about some.
export type PanelRequest = { tab: PanelTab; seq: number; highlight: string[] };

// The panel opens on To handle when the badge counts something, otherwise on the tab used last (FR-BOSS-003, AC2).
export function openingTab(badgeCount: number, last: PanelTab): PanelTab {
    return badgeCount > 0 ? "todo" : last;
}

// The arrow keys move between tabs and wrap (tablist semantics); any other key moves nothing.
export function neighbourTab(current: PanelTab, key: string): PanelTab {
    if (key !== "ArrowRight" && key !== "ArrowLeft") {
        return null;
    }
    const at = PanelTabs.indexOf(current);
    return PanelTabs[(at + (key === "ArrowRight" ? 1 : PanelTabs.length - 1)) % PanelTabs.length];
}

export type UsageProvider = {
    // The provider's id: the agent whose reading it is.
    id: string;
    plan: string;
    rows: GaugeRow[];
    // The fullest window, to rank providers.
    fullest: number;
};

// One entry per provider that gave a reading with a window still running, the fullest first. Several agents of one
// provider share its plan: the provider takes its latest reading (FR-SHELL-027).
export function usageProviders(readings: UsageReadings, now: number): UsageProvider[] {
    const latest = new Map<string, UsageReadings[string]>();
    for (const [agent, snapshot] of Object.entries(readings ?? {})) {
        if (snapshot == null) {
            continue;
        }
        const provider = snapshot.agent || agent;
        const held = latest.get(provider);
        if (held == null || (snapshot.readat ?? 0) > (held.readat ?? 0)) {
            latest.set(provider, snapshot);
        }
    }
    const providers: UsageProvider[] = [];
    for (const [id, snapshot] of latest) {
        const rows = gaugeRows(snapshot, now);
        if (rows.length === 0) {
            continue;
        }
        providers.push({ id, plan: snapshot.plan ?? "", rows, fullest: Math.max(...rows.map((row) => row.bar)) });
    }
    return providers.sort((a, b) => b.fullest - a.fullest);
}
