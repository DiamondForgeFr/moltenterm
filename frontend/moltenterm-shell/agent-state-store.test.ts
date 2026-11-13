// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Each view of a workspace keeps its own copy of the agent states (#1950). A view cut off from the events (its
// websocket reconnected and its subscription was refused, or it was down while agents moved on) showed an older agent
// list than its neighbours until it closed. It now reads them again when it comes to the front, and after a reconnect
// (#1949).

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { workspaceAgents } from "./sidebar/sidebar-agents-model";
import { reconnectHandler } from "./ws-resubscribe";

const m = vi.hoisted(() => ({
    eventHandlers: [] as ((event: { data: unknown }) => void)[],
    server: new Map<string, unknown>(),
    // A snapshot held until the test lets it go; null answers at once.
    hold: null as { release: () => void } | null,
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { handler: (event: { data: unknown }) => void }) => {
        m.eventHandlers.push(sub.handler);
        return () => {};
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: () => {
            const snapshot = [...m.server.values()];
            if (m.hold == null) {
                return Promise.resolve(snapshot);
            }
            return new Promise((resolve) => {
                m.hold.release = () => resolve(snapshot);
            });
        },
    },
}));
vi.mock("@/util/util", () => ({
    fireAndForget: (f: () => Promise<void>) => {
        void f();
    },
}));

const WorkspaceId = "ws-moltenterm";
let version = 0;

type View = { states: AgentStates; onEvent: (event: { data: unknown }) => void };

function agent(blockid: string, firstname: string, state: AgentStateInfo["state"]): AgentStateInfo {
    return {
        blockid,
        firstname,
        state,
        version: ++version,
        agent: "claude",
        agentname: "Claude Code",
        workspaceid: WorkspaceId,
        tabid: "tab-" + firstname,
    };
}

// What wavesrv publishes, to the views that still follow the events.
function publish(info: AgentStateInfo, ...followers: View[]) {
    if (info.cleared) {
        m.server.delete(info.blockid);
    } else {
        m.server.set(info.blockid, info);
    }
    for (const view of followers) {
        view.onEvent({ data: info });
    }
}

// A tab view: its own renderer, so its own store and subscription.
function openView(): View {
    (AgentStates as unknown as { instance: AgentStates }).instance = null;
    const states = AgentStates.getInstance();
    return { states, onEvent: m.eventHandlers.at(-1) };
}

// Sorted: these tests check which agents a view holds, not the sidebar's order (#2296).
function names(view: View): string[] {
    return workspaceAgents(globalStore.get(view.states.dataAtom), WorkspaceId)
        .map((s) => `${s.firstname}:${s.state}`)
        .sort();
}

function bringToFront() {
    (document as unknown as { visibilityState: string }).visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
}

// The snapshot's answer and what it sets run in later turns of the event loop, not after a delay.
async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

beforeEach(() => {
    m.eventHandlers.length = 0;
    m.server.clear();
    m.hold = null;
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "hidden" }));
});

describe("agent states of a view cut off from the events (#1950)", () => {
    it("shows the agents that started or changed while the view stayed hidden once it comes to the front", async () => {
        publish(agent("b-arthur", "Arthur", "working"));
        publish(agent("b-lea", "Lea", "idle"));
        publish(agent("b-rose", "Rose", "working"));
        const cadrage = openView();
        await settle();
        const securite = openView();
        await settle();
        expect(names(cadrage)).toEqual(["Arthur:working", "Lea:idle", "Rose:working"]);

        // Cadrage stays hidden and no longer follows the events.
        publish(agent("b-victoire", "Victoire", "working"), securite);
        publish(agent("b-amelie", "Amelie", "waiting"), securite);
        publish({ blockid: "b-rose", version: ++version, cleared: true }, securite);
        expect(names(cadrage)).toEqual(["Arthur:working", "Lea:idle", "Rose:working"]);

        bringToFront();
        await settle();
        expect(names(cadrage)).toEqual(["Amelie:waiting", "Arthur:working", "Lea:idle", "Victoire:working"]);
        expect(names(cadrage)).toEqual(names(securite));
    });

    it("catches up once it follows its events again after a reconnect", async () => {
        publish(agent("b-arthur", "Arthur", "working"));
        const view = openView();
        await settle();

        publish(agent("b-arthur", "Arthur", "waiting"));
        publish(agent("b-victoire", "Victoire", "working"));
        reconnectHandler(
            () => {},
            () => {}
        )();
        await settle();
        expect(names(view)).toEqual(["Arthur:waiting", "Victoire:working"]);
    });

    it("a view recreated by the tab view budget shows the agents of the moment", async () => {
        publish(agent("b-arthur", "Arthur", "working"));
        const before = openView();
        await settle();
        publish(agent("b-amelie", "Amelie", "waiting"), before);

        const recreated = openView();
        await settle();
        expect(names(recreated)).toEqual(["Amelie:waiting", "Arthur:working"]);
        expect(names(recreated)).toEqual(names(before));
    });

    it("keeps what an event brought while the snapshot travelled", async () => {
        publish(agent("b-arthur", "Arthur", "working"));
        const view = openView();
        await settle();

        // The snapshot is taken before Victoire starts; her event reaches the view before the answer does.
        m.hold = { release: null };
        bringToFront();
        view.onEvent({ data: agent("b-victoire", "Victoire", "working") });
        m.hold.release();
        await settle();
        expect(names(view)).toEqual(["Arthur:working", "Victoire:working"]);
    });

    it("an older snapshot never brings back an agent an event cleared", async () => {
        publish(agent("b-arthur", "Arthur", "working"));
        const view = openView();
        await settle();

        // The snapshot was taken while Arthur still ran; the event that cleared him reaches the view first.
        m.hold = { release: null };
        bringToFront();
        publish({ blockid: "b-arthur", version: ++version, cleared: true }, view);
        m.hold.release();
        await settle();
        expect(names(view)).toEqual([]);
    });
});
