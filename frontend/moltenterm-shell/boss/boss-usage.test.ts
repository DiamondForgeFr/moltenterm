// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    handler: null as (event: { data: unknown }) => void,
    unsubscribe: vi.fn(),
    subscribe: vi.fn(),
}));
vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { handler: (event: { data: unknown }) => void }) => {
        m.subscribe();
        m.handler = sub.handler;
        return m.unsubscribe;
    },
}));

import { globalStore } from "@/app/store/jotaiStore";
import type { CompanionUsageInfo, UsageSnapshot } from "../companion/companion-gauges-model";
import { applyUsageReading, startUsageReadings, UsageReadingsAtom } from "./boss-usage";

function snapshot(agent: string, readat: number, percent = 10): UsageSnapshot {
    return { agent, source: "test", windows: [{ id: "w", label: "Week", usedpercent: percent }], readat };
}

function info(agent: string, gauges: CompanionUsageInfo["gauges"], snap?: UsageSnapshot): CompanionUsageInfo {
    return { blockid: "b1", agent, pageurl: "", pagename: "", gauges, snapshot: snap };
}

afterEach(() => {
    m.unsubscribe.mockReset();
    m.subscribe.mockReset();
    globalStore.set(UsageReadingsAtom, {});
});

describe("the plan usage readings the peek tells (FR-BOSS-001, AC7)", () => {
    it("keeps the latest reading per agent", () => {
        const first = applyUsageReading({}, info("claude", "enabled", snapshot("claude", 100)));
        expect(first.claude.readat).toBe(100);
        const both = applyUsageReading(first, info("codex", "enabled", snapshot("codex", 90)));
        expect(Object.keys(both).sort()).toEqual(["claude", "codex"]);
        const newer = applyUsageReading(both, info("claude", "enabled", snapshot("claude", 200, 50)));
        expect(newer.claude.readat).toBe(200);
        expect(newer.codex).toBe(both.codex);
    });

    it("ignores a reading older than the one it holds", () => {
        const held = applyUsageReading({}, info("claude", "enabled", snapshot("claude", 200)));
        expect(applyUsageReading(held, info("claude", "enabled", snapshot("claude", 100)))).toBe(held);
    });

    it("drops the reading of gauges turned off or unavailable, and keeps the object when nothing changes", () => {
        const held = applyUsageReading({}, info("claude", "enabled", snapshot("claude", 100)));
        expect(applyUsageReading(held, info("claude", "off"))).toEqual({});
        expect(applyUsageReading(held, info("claude", "unavailable"))).toEqual({});
        expect(applyUsageReading(held, info("codex", "off"))).toBe(held);
    });

    it("ignores an event without an agent", () => {
        const held = applyUsageReading({}, info("claude", "enabled", snapshot("claude", 100)));
        expect(applyUsageReading(held, info("", "enabled", snapshot("", 5)))).toBe(held);
        expect(applyUsageReading(held, null)).toBe(held);
    });

    it("listens once for every user, and stops with the last", () => {
        const stopA = startUsageReadings();
        const stopB = startUsageReadings();
        expect(m.subscribe).toHaveBeenCalledOnce();
        m.handler({ data: info("claude", "enabled", snapshot("claude", 100, 33)) });
        expect(globalStore.get(UsageReadingsAtom).claude.windows[0].usedpercent).toBe(33);
        stopA();
        stopA();
        expect(m.unsubscribe).not.toHaveBeenCalled();
        stopB();
        expect(m.unsubscribe).toHaveBeenCalledOnce();
    });
});
