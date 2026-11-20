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
import { AgentStatesRoute, AgentUseCommand } from "../agent-state-model";
import type { CompanionUsageInfo, UsageSnapshot } from "../companion/companion-gauges-model";
import {
    applyUnreadable,
    applyUsageReading,
    askUsageUse,
    CompanionUsageGlobalCommand,
    startUsageReadings,
    UsageReadingsAtom,
    UsageUnreadableAtom,
    UsageUseAtom,
} from "./boss-usage";
import { readUseSummary, refreshUsageUse } from "./boss-usage-use";

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
    globalStore.set(UsageUseAtom, null);
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

    it("keeps a cold-start Kimi reading when Codex is unavailable", async () => {
        m.rpc.mockResolvedValue([
            globalInfo("codex", "unavailable", undefined, "expired"),
            globalInfo("kimi", "enabled", snapshot("kimi", 100, 60)),
        ]);
        const stop = startUsageReadings();
        await vi.waitFor(() => expect(globalStore.get(UsageReadingsAtom).kimi?.windows[0].usedpercent).toBe(60));
        expect(globalStore.get(UsageUnreadableAtom)).toEqual({ codex: "expired" });
        stop();
    });

    it("clears a held Kimi reading and unreadable marker when its gauges turn off", () => {
        const readings = applyUsageReading({}, globalInfo("kimi", "enabled", snapshot("kimi", 100, 60)));
        const unreadable = applyUnreadable({}, globalInfo("kimi", "unavailable", undefined, "signedout"));
        const off = globalInfo("kimi", "off");
        expect(applyUsageReading(readings, off)).toEqual({});
        expect(applyUnreadable(unreadable, off)).toEqual({});
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

// #2341: what each agent was used over the last 7 days comes from wavesrv, over the agent states route.
describe("the use of each agent over 7 days (FR-BOSS-009, AC93 and AC94)", () => {
    it("keeps the numbers wavesrv gave, and drops what is not a number", () => {
        const use = readUseSummary({
            at: 5,
            agents: {
                claude: { workms: 90000, sessions: 2, lastat: 1700 },
                codex: { workms: -4, sessions: "x", lastat: null } as any,
            },
        });
        expect(use).toEqual({
            claude: { workms: 90000, sessions: 2, lastat: 1700 },
            codex: { workms: 0, sessions: 0, lastat: 0 },
        });
    });

    it("says nothing for an answer that holds no agents", () => {
        expect(readUseSummary(null)).toBeNull();
        expect(readUseSummary({ at: 1 } as any)).toBeNull();
        expect(readUseSummary({ at: 1, agents: null } as any)).toBeNull();
        expect(readUseSummary({ at: 1, agents: {} })).toEqual({});
    });

    it("asks the agent states route and keeps the answer", async () => {
        expect(globalStore.get(UsageUseAtom)).toBeNull();
        m.rpc.mockResolvedValue({ at: 9, agents: { claude: { workms: 5, sessions: 1, lastat: 3 } } });
        await refreshUsageUse();
        expect(m.rpc).toHaveBeenCalledOnce();
        expect(m.rpc.mock.calls[0][0]).toBe(AgentUseCommand);
        expect(m.rpc.mock.calls[0][2].route).toBe(AgentStatesRoute);
        expect(globalStore.get(UsageUseAtom)).toEqual({ claude: { workms: 5, sessions: 1, lastat: 3 } });
    });

    // The code that asks loads on demand (NFR-PERF-003): the way in loads it, then asks.
    it("is asked through the way in that loads it on demand", async () => {
        m.rpc.mockResolvedValue({ at: 9, agents: { codex: { workms: 7, sessions: 2, lastat: 4 } } });
        await askUsageUse();
        expect(m.rpc.mock.calls[0][0]).toBe(AgentUseCommand);
        expect(globalStore.get(UsageUseAtom)).toEqual({ codex: { workms: 7, sessions: 2, lastat: 4 } });
    });

    it("keeps what it held when the answer fails or is empty", async () => {
        m.rpc.mockResolvedValue({ at: 9, agents: {} });
        await refreshUsageUse();
        expect(globalStore.get(UsageUseAtom)).toEqual({});
        m.rpc.mockRejectedValue(new Error("no route"));
        await refreshUsageUse();
        expect(globalStore.get(UsageUseAtom)).toEqual({});
        m.rpc.mockResolvedValue(undefined);
        await refreshUsageUse();
        expect(globalStore.get(UsageUseAtom)).toEqual({});
    });

    it("is not asked when the readings start: the group asks when it opens", () => {
        m.rpc.mockResolvedValue([]);
        const stop = startUsageReadings();
        expect(m.rpc.mock.calls.map((c) => c[0])).toEqual([CompanionUsageGlobalCommand]);
        stop();
    });
});
