// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sidebar's agents keep a stable order (FR-SHELL-084, #2296): focus, activity and state never move an agent; the
// developer orders the agents within a project, by drag or Move up / Move down, saved in the workspace's meta; a new
// agent goes to the end of its project. Synthetic agents and projects only.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { Provider } from "jotai";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));
vi.mock("@/app/store/wshclientapi", async () => ({ RpcApi: (await import("./agent-note-fake")).fakeWorkspaces.rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: { getInstance: () => ({ showContextMenu: () => {} }) },
}));

import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { fakeWorkspaces as fake } from "./agent-note-fake";
import { agentRowMenuItems, AgentsSection } from "./sidebar-agents";
import { workspaceAgents } from "./sidebar-agents-model";
import {
    AgentOrderMetaKey,
    arrivalOrder,
    canMove,
    MaxSavedOrder,
    moveBy,
    moveWithin,
    orderAgents,
    readAgentOrder,
    savedAfterMove,
} from "./sidebar-agents-order";
import { AgentOrderModel } from "./sidebar-agents-order-store";
import type { WorkspaceProjectEntry } from "./workspace-projects";

const Alpha: WorkspaceProjectEntry = { id: "pa", type: "alpha", dir: "/synthetic/alpha", branch: "" };
const Beta: WorkspaceProjectEntry = { id: "pb", type: "beta", dir: "/synthetic/beta", branch: "" };

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
    fake.bind(WOS);
});

beforeEach(() => {
    fake.reset();
    fake.seed("ws1");
    AgentOrderModel.resetInstance();
});

afterEach(() => {
    AgentOrderModel.resetInstance();
});

function agent(blockid: string, firstname: string, extra: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return {
        blockid,
        tabid: `tab-${blockid}`,
        workspaceid: "ws1",
        agent: "claude",
        agentname: "Claude Code",
        firstname,
        state: "idle",
        version: 1,
        ...extra,
    } as AgentStateInfo;
}

function seedFolder(blockId: string, folder: string) {
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("block", blockId)));
    WOS.setObjectValue({ otype: "block", oid: blockId, version: 1, meta: { "cmd:cwd": folder } } as any);
}

function names(html: string): string[] {
    return [...html.matchAll(/class="mt-sb-agent-nm">([^<]*)</g)].map((m) => m[1]);
}

function section(agents: AgentStateInfo[], activeTabId: string, projects?: WorkspaceProjectEntry[]): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <AgentsSection agents={agents} activeTabId={activeTabId} projects={projects} />
        </Provider>
    );
}

function data(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((i) => [i.blockid, i])), versions: {} };
}

const ids = (list: AgentStateInfo[]) => list.map((a) => a.blockid);

describe("the order model (#2296)", () => {
    it("reads only a list of distinct ids", () => {
        expect(readAgentOrder(["a", "b", "a", "", 3, null])).toEqual(["a", "b"]);
        expect(readAgentOrder({ a: 1 })).toEqual([]);
        expect(readAgentOrder(undefined)).toEqual([]);
    });

    it("keeps the earlier arrivals' places and puts a new agent last", () => {
        const first = arrivalOrder([], [agent("a", "A"), agent("b", "B")]);
        expect(first).toEqual(["a", "b"]);
        expect(arrivalOrder(first, [agent("b", "B"), agent("a", "A")])).toBe(first);
        expect(arrivalOrder(first, [agent("c", "C"), agent("a", "A"), agent("b", "B")])).toEqual(["a", "b", "c"]);
        expect(arrivalOrder(first, [agent("b", "B")])).toEqual(["b"]);
    });

    it("puts the developer's order first, then the agents it does not hold by arrival", () => {
        const list = [agent("a", "A"), agent("b", "B"), agent("c", "C"), agent("d", "D")];
        expect(ids(orderAgents(list, ["c", "a"], ["a", "b", "c", "d"]))).toEqual(["c", "a", "b", "d"]);
        expect(ids(orderAgents(list, [], ["d", "c", "b", "a"]))).toEqual(["d", "c", "b", "a"]);
    });

    it("moves an agent within its group, and refuses a move to another group", () => {
        const shown = ["a1", "a2", "a3", "b1", "b2"];
        const groupA = ["a1", "a2", "a3"];
        expect(moveWithin(shown, groupA, "a3", "a1", false)).toEqual(["a3", "a1", "a2", "b1", "b2"]);
        expect(moveWithin(shown, groupA, "a1", "a3", true)).toEqual(["a2", "a3", "a1", "b1", "b2"]);
        expect(moveWithin(shown, groupA, "a1", "b1", false)).toBeNull();
        expect(moveWithin(shown, groupA, "a1", "a2", false)).toBeNull();
        expect(moveWithin(shown, groupA, "a1", "a1", true)).toBeNull();
    });

    it("steps up and down, never past the group's edge", () => {
        const shown = ["a1", "a2", "b1"];
        const groupA = ["a1", "a2"];
        expect(moveBy(shown, groupA, "a2", -1)).toEqual(["a2", "a1", "b1"]);
        expect(moveBy(shown, groupA, "a1", 1)).toEqual(["a2", "a1", "b1"]);
        expect(moveBy(shown, groupA, "a1", -1)).toBeNull();
        expect(moveBy(shown, groupA, "a2", 1)).toBeNull();
        expect(canMove(groupA, "a1", -1)).toBe(false);
        expect(canMove(groupA, "a1", 1)).toBe(true);
    });

    it("saves the new order and keeps the absent agents' places, bounded", () => {
        expect(savedAfterMove(["b", "a"], ["a", "gone", "b"])).toEqual(["b", "a", "gone"]);
        const many = Array.from({ length: MaxSavedOrder + 5 }, (_, i) => `x${i}`);
        expect(savedAfterMove(["a"], many)).toHaveLength(MaxSavedOrder);
    });
});

describe("the list never reorders on its own (#2296)", () => {
    it("keeps the order whichever of three agents of a project is focused", () => {
        for (const id of ["f1", "f2", "f3"]) {
            seedFolder(id, "/synthetic/alpha");
        }
        const agents = [
            agent("f1", "Ada", { started: 1 }),
            agent("f2", "Bea", { started: 2 }),
            agent("f3", "Cy", { started: 3 }),
        ];
        for (const focused of ["tab-f1", "tab-f2", "tab-f3", "tab-none"]) {
            expect(names(section(agents, focused, [Alpha]))).toEqual(["Ada", "Bea", "Cy"]);
        }
    });

    it("keeps the order and the groups when an agent of another project is focused or starts working", () => {
        seedFolder("g1", "/synthetic/alpha");
        seedFolder("g2", "/synthetic/beta");
        seedFolder("g3", "/synthetic/alpha");
        const quiet = [
            agent("g1", "Ada", { started: 1 }),
            agent("g2", "Bea", { started: 2 }),
            agent("g3", "Cy", { started: 3 }),
        ];
        const busy = data(
            agent("g1", "Ada", { started: 1 }),
            agent("g2", "Bea", { started: 2, state: "working", since: 999 }),
            agent("g3", "Cy", { started: 3, state: "waiting", since: 998 })
        );
        expect(names(section(quiet, "tab-g1", [Alpha, Beta]))).toEqual(["Ada", "Cy", "Bea"]);
        expect(names(section(quiet, "tab-g2", [Alpha, Beta]))).toEqual(["Ada", "Cy", "Bea"]);
        expect(names(section(workspaceAgents(busy, "ws1"), "tab-g2", [Alpha, Beta]))).toEqual(["Ada", "Cy", "Bea"]);
    });

    it("puts a new agent at the end of its project", () => {
        for (const id of ["n1", "n2", "n3"]) {
            seedFolder(id, "/synthetic/alpha");
        }
        seedFolder("nb", "/synthetic/beta");
        fake.seed("ws1", { [AgentOrderMetaKey]: ["n2", "n1"] });
        const agents = [
            agent("n1", "Ada", { started: 1 }),
            agent("n2", "Bea", { started: 2 }),
            agent("nb", "Dee", { started: 3 }),
            agent("n3", "Cy", { started: 4 }),
        ];
        expect(names(section(agents, "tab-n1", [Alpha, Beta]))).toEqual(["Bea", "Ada", "Cy", "Dee"]);
    });
});

describe("the developer's order (#2296)", () => {
    const subject: Parameters<typeof agentRowMenuItems>[0] = {
        kind: "agent",
        at: "row:m2",
        workspaceId: "ws1",
        key: "m2",
        name: "Bea",
    };

    it("moves with Move up, saves on the workspace, and shows the same order after a reload", async () => {
        for (const id of ["m1", "m2", "m3"]) {
            seedFolder(id, "/synthetic/alpha");
        }
        const agents = [
            agent("m1", "Ada", { started: 1 }),
            agent("m2", "Bea", { started: 2 }),
            agent("m3", "Cy", { started: 3 }),
        ];
        const order = { shown: ["m1", "m2", "m3"], group: ["m1", "m2", "m3"] };
        const items = agentRowMenuItems(subject, false, order, "m2");
        expect(items.slice(0, 2).map((i) => [i.label, i.enabled])).toEqual([
            ["Move up", true],
            ["Move down", true],
        ]);
        items[0].click();
        expect(names(section(agents, "tab-m1", [Alpha]))).toEqual(["Bea", "Ada", "Cy"]);
        await Promise.resolve();
        expect(fake.meta("ws1")[AgentOrderMetaKey]).toEqual(["m2", "m1", "m3"]);
        AgentOrderModel.resetInstance();
        expect(names(section(agents, "tab-m3", [Alpha]))).toEqual(["Bea", "Ada", "Cy"]);
    });

    it("refuses a drag onto another project's agent", () => {
        const model = AgentOrderModel.getInstance();
        expect(model.moveTo("ws1", ["a1", "a2", "b1"], ["a1", "a2"], "a1", "b1", false)).toBe(false);
        expect(fake.calls).toEqual([]);
        expect(model.moveTo("ws1", ["a1", "a2", "b1"], ["a1", "a2"], "a1", "a2", true)).toBe(true);
        expect(globalStore.get(model.orderAtom("ws1"))).toEqual(["a2", "a1", "b1"]);
    });

    it("offers no move when the agent is alone in its project, and greys the edge's step", () => {
        expect(agentRowMenuItems(subject, false, { shown: ["m2"], group: ["m2"] }, "m2").map((i) => i.label)).toEqual([
            "Add a note…",
        ]);
        const top = agentRowMenuItems(subject, false, { shown: ["m2", "m1"], group: ["m2", "m1"] }, "m2");
        expect(top[0].enabled).toBe(false);
        expect(top[1].enabled).toBe(true);
    });

    it("lets a drag start on the row and keeps the click that ends it from opening the view", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "sidebar-agents.tsx"), "utf8");
        expect(source).toContain(
            "onMouseDown={editing ? undefined : (e) => order.startDrag(e, info.blockid, order.group)}"
        );
        expect(source).toContain("if (!order.takeClick(info.blockid)) {");
        expect(source).toContain("!group.includes(target)");
    });
});
