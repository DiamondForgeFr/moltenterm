// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import {
    agentRowLook,
    agentRowTarget,
    MaxKeptTrees,
    readTreeStates,
    sidebarSections,
    toggleSection,
    toggleTree,
    workspaceAgents,
} from "./sidebar-agents-model";

function info(blockid: string, state: any, extra: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return { blockid, state, version: 1, agent: "claude", workspaceid: "ws1", ...extra };
}

function data(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((i) => [i.blockid, i])), versions: {} };
}

describe("workspaceAgents", () => {
    it("lists the workspace's agents, working first, then waiting, error, idle, done", () => {
        const d = data(
            info("done", "done"),
            info("idle", "idle"),
            info("wait", "waiting"),
            info("work2", "working", { started: 20 }),
            info("work1", "working", { started: 10 }),
            info("err", "error"),
            info("other", "working", { workspaceid: "ws2" }),
            info("shell", "idle", { agent: "", agentname: "" })
        );
        expect(workspaceAgents(d, "ws1").map((a) => a.blockid)).toEqual([
            "work1",
            "work2",
            "wait",
            "err",
            "idle",
            "done",
        ]);
        expect(workspaceAgents(d, "")).toEqual([]);
    });

    it("lists Claude Code and Codex alike", () => {
        const d = data(info("a", "working", { agent: "codex", agentname: "Codex" }), info("b", "waiting"));
        expect(workspaceAgents(d, "ws1").map((a) => a.agent)).toEqual(["codex", "claude"]);
    });
});

describe("agentRowLook", () => {
    it("keeps the four shown states and folds the rest into idle", () => {
        expect(agentRowLook(info("a", "working"))).toBe("working");
        expect(agentRowLook(info("a", "waiting"))).toBe("waiting");
        expect(agentRowLook(info("a", "done"))).toBe("done");
        expect(agentRowLook(info("a", "error"))).toBe("error");
        expect(agentRowLook(info("a", "idle"))).toBe("idle");
        expect(agentRowLook(null)).toBe("idle");
    });
});

// A view stays a view whatever it holds (#1246): the agent rows sit beside the views, never in their place.
describe("sidebarSections", () => {
    const split = { tiles: ["tile"], temporary: ["t1", "t2", "t3"], everywhere: { pin1: "top" } };

    it("keeps a temporary view that starts an agent in the temporary list", () => {
        const agents = [info("a", "working", { tabid: "t1" })];
        const s = sidebarSections(split, agents);
        expect(s.temporary).toEqual(["t1", "t2", "t3"]);
        expect(s.agents.map((a) => a.blockid)).toEqual(["a"]);
    });

    it("keeps a view of two agents, and each of its agents, listed", () => {
        const agents = [info("b", "working", { tabid: "t2" }), info("c", "waiting", { tabid: "t2" })];
        const s = sidebarSections(split, agents);
        expect(s.temporary).toEqual(["t1", "t2", "t3"]);
        expect(s.agents.map((a) => a.blockid)).toEqual(["b", "c"]);
    });

    it("keeps a pinned view with an agent pinned, as a tile or in the top row", () => {
        const agents = [info("d", "working", { tabid: "tile" }), info("e", "idle", { tabid: "top" })];
        const s = sidebarSections(split, agents);
        expect(s.tiles).toEqual(["tile"]);
        expect(s.everywhere).toEqual({ pin1: "top" });
        expect(s.temporary).toEqual(["t1", "t2", "t3"]);
        expect(s.agents).toHaveLength(2);
    });

    it("lists no agent when the workspace has none", () => {
        expect(sidebarSections(split, null).agents).toEqual([]);
    });
});

describe("agentRowTarget", () => {
    it("goes to the view and the panel the agent runs in", () => {
        expect(agentRowTarget(info("blk", "working", { tabid: "t1", workspaceid: "ws1" }))).toEqual({
            workspaceid: "ws1",
            tabid: "t1",
            blockid: "blk",
        });
    });
});

describe("tree states", () => {
    it("opens a tree and shuts its sections independently, each kept", () => {
        let s = toggleTree({}, "a");
        expect(s.a.open).toBe(true);
        s = toggleSection(s, "a", "subs");
        expect(s.a.shut).toEqual({ subs: true });
        s = toggleSection(s, "a", "links");
        expect(s.a.shut).toEqual({ subs: true, links: true });
        s = toggleSection(s, "a", "subs");
        expect(s.a.shut).toEqual({ subs: false, links: true });
        s = toggleTree(s, "a");
        expect(s.a).toEqual({ open: false, shut: { subs: false, links: true } });
    });

    it("keeps the latest trees only", () => {
        let s = {};
        for (let i = 0; i < MaxKeptTrees + 10; i++) {
            s = toggleTree(s, `b${i}`);
        }
        expect(Object.keys(s)).toHaveLength(MaxKeptTrees);
        expect(s).toHaveProperty(`b${MaxKeptTrees + 9}`);
        expect(s).not.toHaveProperty("b0");
    });

    it("reads stored states defensively", () => {
        expect(readTreeStates(null)).toEqual({});
        expect(readTreeStates([1])).toEqual({});
        expect(readTreeStates({ a: { open: true, shut: { subs: true, other: true } }, b: 3 })).toEqual({
            a: { open: true, shut: { subs: true } },
        });
    });
});
