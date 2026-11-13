// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-BOSS-009, AC26 (#2033): Brokk's own session is no agent of a workspace. wavesrv flags its state (`own`); the store
// keeps it apart from the data every list reads, so that the sidebar's agents, the rail's marks and the counts never
// show it, while the ring on his face still reads its state.

import { globalStore } from "@/app/store/jotaiStore";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    agentStatesOfWorkspace,
    mostUrgentAgentState,
    splitOwnStates,
    workingAgentCount,
    type AgentStateInfo,
} from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { attentionAgents } from "./boss/boss-overview";
import { brokkWorking } from "./boss/brokk-watch";
import { workspaceAgents } from "./sidebar/sidebar-agents-model";

const m = vi.hoisted(() => ({
    eventHandlers: [] as ((event: { data: unknown }) => void)[],
    server: new Map<string, unknown>(),
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { handler: (event: { data: unknown }) => void }) => {
        m.eventHandlers.push(sub.handler);
        return () => {};
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { wshRpcCall: () => Promise.resolve([...m.server.values()]) },
}));
vi.mock("@/util/util", () => ({
    fireAndForget: (f: () => Promise<void>) => {
        void f();
    },
}));

const WorkspaceId = "ws-moltenterm";
const BrokkBlock = "b-brokk";
let version = 0;

function agent(blockid: string, firstname: string, state: AgentStateInfo["state"], own = false): AgentStateInfo {
    return {
        blockid,
        firstname,
        state,
        version: ++version,
        agent: "claude",
        agentname: "Claude Code",
        workspaceid: WorkspaceId,
        tabid: "tab-" + firstname,
        ...(own ? { own: true } : {}),
    };
}

function openView(): { states: AgentStates; onEvent: (event: { data: unknown }) => void } {
    (AgentStates as unknown as { instance: AgentStates }).instance = null;
    const states = AgentStates.getInstance();
    return { states, onEvent: m.eventHandlers.at(-1) };
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

beforeEach(() => {
    m.eventHandlers.length = 0;
    m.server.clear();
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "hidden" }));
});

describe("the data every list of agents reads never holds Brokk's session", () => {
    it("keeps him out of the sidebar's agents, whether his state came in an event or in the first snapshot", async () => {
        m.server.set(BrokkBlock, agent(BrokkBlock, "Fanny", "working", true));
        m.server.set("b-lea", agent("b-lea", "Lea", "idle"));
        const view = openView();
        await settle();
        view.onEvent({ data: agent("b-rose", "Rose", "working") });
        view.onEvent({ data: agent(BrokkBlock, "Fanny", "done", true) });

        const data = globalStore.get(view.states.dataAtom);
        expect(
            workspaceAgents(data, WorkspaceId)
                .map((a) => a.firstname)
                .sort()
        ).toEqual(["Lea", "Rose"]);
        expect(data.states[BrokkBlock]).toBeUndefined();
    });

    it("keeps him out of the Agents-needing-you rows, the rail's marks and the counts of agents at work", async () => {
        const view = openView();
        await settle();
        view.onEvent({ data: agent(BrokkBlock, "Fanny", "waiting", true) });
        view.onEvent({ data: agent("b-rose", "Rose", "working") });

        const data = globalStore.get(view.states.dataAtom);
        expect(attentionAgents(data)).toEqual([]);
        expect(workingAgentCount(agentStatesOfWorkspace(data, WorkspaceId))).toBe(1);
        expect(mostUrgentAgentState(agentStatesOfWorkspace(data, WorkspaceId))?.firstname).toBe("Rose");
        expect(globalStore.get(view.states.workspaceWorkingAtom(WorkspaceId))).toBe(1);
        expect(globalStore.get(view.states.workspaceAtom(WorkspaceId))?.firstname).toBe("Rose");
    });

    it("has no mark on a workspace where only his session works", async () => {
        const view = openView();
        await settle();
        view.onEvent({ data: agent(BrokkBlock, "Fanny", "working", true) });
        expect(globalStore.get(view.states.workspaceWorkingAtom(WorkspaceId))).toBe(0);
        expect(globalStore.get(view.states.workspaceAtom(WorkspaceId))).toBeNull();
    });

    it("takes him out when a state that came before its location already put him in the data", async () => {
        const view = openView();
        await settle();
        view.onEvent({ data: { ...agent(BrokkBlock, "Fanny", "idle"), workspaceid: undefined } });
        expect(globalStore.get(view.states.dataAtom).states[BrokkBlock]).toBeDefined();
        view.onEvent({ data: agent(BrokkBlock, "Fanny", "idle", true) });
        expect(globalStore.get(view.states.dataAtom).states[BrokkBlock]).toBeUndefined();
        expect(globalStore.get(view.states.ownDataAtom).states[BrokkBlock]?.state).toBe("idle");
    });

    it("keeps him out after a reconnect reads the states again", async () => {
        const view = openView();
        await settle();
        view.onEvent({ data: agent("b-rose", "Rose", "working") });
        view.onEvent({ data: agent(BrokkBlock, "Fanny", "working", true) });
        m.server.set("b-rose", agent("b-rose", "Rose", "working"));
        m.server.set(BrokkBlock, agent(BrokkBlock, "Fanny", "done", true));

        view.states.loadSnapshot(true);
        await settle();
        expect(Object.keys(globalStore.get(view.states.dataAtom).states)).toEqual(["b-rose"]);
        expect(globalStore.get(view.states.ownDataAtom).states[BrokkBlock]?.state).toBe("done");
    });
});

describe("the state of his session stays readable for his face and his terminal", () => {
    it("keeps it apart, where the ring on his face reads it", async () => {
        const view = openView();
        await settle();
        view.onEvent({ data: agent(BrokkBlock, "Fanny", "working", true) });
        expect(brokkWorking(globalStore.get(view.states.ownDataAtom), BrokkBlock)).toBe(true);
        view.onEvent({ data: agent(BrokkBlock, "Fanny", "done", true) });
        expect(brokkWorking(globalStore.get(view.states.ownDataAtom), BrokkBlock)).toBe(false);
        const hub = readFileSync(join(__dirname, "boss", "brokk-hub-store.ts"), "utf8");
        expect(hub).toContain("brokkWorking(get(agents.ownDataAtom), get(this.sessionBlockAtom))");
    });

    it("lets his own terminal show as a terminal that runs an agent when the developer opens it", async () => {
        const view = openView();
        await settle();
        view.onEvent({ data: agent(BrokkBlock, "Fanny", "working", true) });
        expect(globalStore.get(view.states.blockAtom(BrokkBlock))?.state).toBe("working");
    });

    it("ends it with the end of his session, which does not say it was his", async () => {
        const view = openView();
        await settle();
        view.onEvent({ data: agent(BrokkBlock, "Fanny", "working", true) });
        view.onEvent({ data: { blockid: BrokkBlock, version: ++version, cleared: true } });
        expect(globalStore.get(view.states.ownDataAtom).states[BrokkBlock]).toBeUndefined();
        expect(globalStore.get(view.states.blockAtom(BrokkBlock))).toBeNull();
    });
});

describe("splitting the states", () => {
    const empty = { states: {}, versions: {} };

    it("sends his states to his side and everything else to the shared side", () => {
        const split = splitOwnStates(
            [agent("a", "A", "working"), agent(BrokkBlock, "F", "working", true)],
            empty,
            empty
        );
        expect(split.shared.map((i) => i.blockid)).toEqual(["a"]);
        expect(split.own.map((i) => i.blockid)).toEqual([BrokkBlock]);
    });

    it("sends the end of a block he held to both sides, and the end of any other block to the shared side only", () => {
        const own = { states: {}, versions: { [BrokkBlock]: 3 } };
        const split = splitOwnStates(
            [
                { blockid: BrokkBlock, version: 9, cleared: true },
                { blockid: "a", version: 10, cleared: true },
            ],
            empty,
            own
        );
        expect(split.shared.map((i) => i.blockid)).toEqual([BrokkBlock, "a"]);
        expect(split.own.map((i) => i.blockid)).toEqual([BrokkBlock]);
    });
});
