// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-CONT-014 (#2324): the window holds the first names locked for a project, read at start and again on each
// molten:agentnamelocks event, and asks wavesrv to lock and unlock them.

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    AgentNameLockCommand,
    AgentNameLocksCommand,
    AgentNameLocksEvent,
    AgentNameUnlockCommand,
} from "./agent-name-locks-model";
import { AgentNameLocks, lockAgentName, unlockAgentName } from "./agent-name-locks-store";
import { AgentStatesRoute } from "./agent-state-model";

const m = vi.hoisted(() => ({
    handlers: [] as ((event: { data: unknown }) => void)[],
    locks: [] as { name: string; project: string }[],
    calls: [] as { command: string; route: string; data: unknown }[],
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { eventType: string; handler: (event: { data: unknown }) => void }) => {
        if (sub.eventType === "molten:agentnamelocks") {
            m.handlers.push(sub.handler);
        }
        return () => {};
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: (command: string, data: unknown, opts: { route: string }) => {
            m.calls.push({ command, route: opts.route, data });
            if (command === "moltenagentnamelocks") {
                return Promise.resolve({ locks: [...m.locks] });
            }
            return Promise.resolve({ status: "locked", name: "Flore" });
        },
    },
}));
vi.mock("@/util/util", () => ({
    fireAndForget: (f: () => Promise<void>) => {
        void f();
    },
}));

async function settled() {
    await vi.waitFor(() => expect(AgentNameLocks.getInstance().inFlight).toBe(false));
}

describe("the locked first names in the window", () => {
    beforeEach(() => {
        AgentNameLocks.resetInstance();
        m.handlers.length = 0;
        m.calls.length = 0;
        m.locks = [];
    });

    it("reads the locks at start, from the agent states route", async () => {
        m.locks = [{ name: "Flore", project: "/projects/alpha" }];
        const locks = AgentNameLocks.getInstance();
        await settled();
        expect(globalStore.get(locks.locksAtom)).toEqual([{ name: "Flore", project: "/projects/alpha" }]);
        expect(m.calls[0]).toMatchObject({ command: AgentNameLocksCommand, route: AgentStatesRoute });
        expect(AgentNameLocksEvent).toBe("molten:agentnamelocks");
    });

    it("reads them again when they change", async () => {
        const locks = AgentNameLocks.getInstance();
        await settled();
        expect(globalStore.get(locks.locksAtom)).toEqual([]);
        m.locks = [
            { name: "Flore", project: "/projects/alpha" },
            { name: "Rose", project: "/projects/alpha" },
        ];
        m.handlers[0]({ data: null });
        await vi.waitFor(() => expect(globalStore.get(locks.locksAtom)).toHaveLength(2));
    });

    it("asks to lock the name of a terminal's agent, never naming the name itself", async () => {
        await lockAgentName("block-1", false);
        await lockAgentName("block-1", true);
        expect(m.calls).toEqual([
            { command: AgentNameLockCommand, route: AgentStatesRoute, data: { blockid: "block-1", move: false } },
            { command: AgentNameLockCommand, route: AgentStatesRoute, data: { blockid: "block-1", move: true } },
        ]);
    });

    it("asks to unlock a name", async () => {
        await unlockAgentName("Flore");
        expect(m.calls).toEqual([
            { command: AgentNameUnlockCommand, route: AgentStatesRoute, data: { name: "Flore" } },
        ]);
    });
});
