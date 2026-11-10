// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-REV-035 (#2174): the window holds the responsibility chain wavesrv keeps, read at start and again on each
// molten:agentchain event.

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChain, AgentChainCommand, AgentChainEvent, AgentChainRouteId } from "./agent-chain-store";

const m = vi.hoisted(() => ({
    handlers: [] as ((event: { data: unknown }) => void)[],
    edges: [] as { lead: string; sub: string }[],
    calls: [] as { command: string; route: string }[],
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { eventType: string; handler: (event: { data: unknown }) => void }) => {
        if (sub.eventType === "molten:agentchain") {
            m.handlers.push(sub.handler);
        }
        return () => {};
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: (command: string, _data: unknown, opts: { route: string }) => {
            m.calls.push({ command, route: opts.route });
            return Promise.resolve({ edges: [...m.edges] });
        },
    },
}));
vi.mock("@/util/util", () => ({
    fireAndForget: (f: () => Promise<void>) => {
        void f();
    },
}));

async function settled() {
    await vi.waitFor(() => expect(AgentChain.getInstance().inFlight).toBe(false));
}

describe("the responsibility chain in the window", () => {
    beforeEach(() => {
        AgentChain.resetInstance();
        m.handlers.length = 0;
        m.calls.length = 0;
        m.edges = [];
    });

    it("reads the links at start, from the handoff route", async () => {
        m.edges = [{ lead: "Flore", sub: "Hugo" }];
        const chain = AgentChain.getInstance();
        await settled();
        expect(globalStore.get(chain.edgesAtom)).toEqual([{ lead: "Flore", sub: "Hugo" }]);
        expect(m.calls[0]).toEqual({ command: AgentChainCommand, route: AgentChainRouteId });
        expect(AgentChainEvent).toBe("molten:agentchain");
    });

    it("reads them again when a link is added", async () => {
        const chain = AgentChain.getInstance();
        await settled();
        expect(globalStore.get(chain.edgesAtom)).toEqual([]);
        m.edges = [
            { lead: "Flore", sub: "Hugo" },
            { lead: "Hugo", sub: "Léa" },
        ];
        m.handlers[0]({ data: null });
        await vi.waitFor(() => expect(globalStore.get(chain.edgesAtom)).toHaveLength(2));
    });
});
