// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    handler: null as (event: { data: unknown }) => void,
    unsubscribe: vi.fn(),
    subscribe: vi.fn(),
    rpc: vi.fn(),
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: m.rpc } }));
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
import {
    applyUnreadable,
    applyUsageReading,
    CompanionUsageGlobalCommand,
    startUsageReadings,
    UsageReadingsAtom,
    UsageUnreadableAtom,
} from "./boss-usage";

function snapshot(agent: string, readat: number, percent = 10): UsageSnapshot {
    return { agent, source: "test", windows: [{ id: "w", label: "Week", usedpercent: percent }], readat };
}

function info(agent: string, gauges: CompanionUsageInfo["gauges"], snap?: UsageSnapshot): CompanionUsageInfo {
    return { blockid: "b1", agent, pageurl: "", pagename: "", gauges, snapshot: snap };
}

function globalInfo(agent: string, gauges: CompanionUsageInfo["gauges"], snap?: UsageSnapshot, reason?: string) {
    return { ...info(agent, gauges, snap), blockid: "", global: true, reason } as CompanionUsageInfo;
}

afterEach(() => {
    m.unsubscribe.mockReset();
    m.subscribe.mockReset();
    m.rpc.mockReset();
    globalStore.set(UsageReadingsAtom, {});
    globalStore.set(UsageUnreadableAtom, {});
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

    it("drops the reading of gauges turned off, and keeps the object when nothing changes", () => {
        const held = applyUsageReading({}, info("claude", "enabled", snapshot("claude", 100)));
        expect(applyUsageReading(held, info("claude", "off"))).toEqual({});
        expect(applyUsageReading(held, info("codex", "off"))).toBe(held);
    });

    // #2074: one terminal's read failing does not take the plan's reading away.
    it("keeps the reading when a terminal's read is unavailable", () => {
        const held = applyUsageReading({}, globalInfo("codex", "enabled", snapshot("codex", 100)));
        expect(applyUsageReading(held, info("codex", "unavailable"))).toBe(held);
    });

    it("marks an agent unreadable only from its global reading, and clears it with a reading or gauges off", () => {
        const marked = applyUnreadable({}, globalInfo("codex", "unavailable", undefined, "expired"));
        expect(marked).toEqual({ codex: "expired" });
        expect(applyUnreadable({}, info("codex", "unavailable"))).toEqual({});
        expect(applyUnreadable(marked, info("codex", "enabled", snapshot("codex", 5)))).toEqual({});
        expect(applyUnreadable(marked, info("codex", "off"))).toEqual({});
        expect(applyUnreadable(marked, info("claude", "enabled", snapshot("claude", 5)))).toBe(marked);
    });

    it("asks once for the global readings when the readings start", async () => {
        m.rpc.mockResolvedValue([globalInfo("codex", "enabled", snapshot("codex", 100, 9))]);
        const stop = startUsageReadings();
        expect(m.rpc).toHaveBeenCalledOnce();
        expect(m.rpc.mock.calls[0][0]).toBe(CompanionUsageGlobalCommand);
        await vi.waitFor(() => expect(globalStore.get(UsageReadingsAtom).codex?.windows[0].usedpercent).toBe(9));
        m.handler({ data: globalInfo("claude", "unavailable", undefined, "failed") });
        expect(globalStore.get(UsageUnreadableAtom)).toEqual({ claude: "failed" });
        stop();
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
