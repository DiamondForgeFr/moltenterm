// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import {
    agentOwnedViews,
    agentRowLook,
    MaxKeptTrees,
    readTreeStates,
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

describe("agentOwnedViews", () => {
    it("gives a temporary view to its only agent, never a pinned one or a view of two agents", () => {
        const agents = [
            info("a", "working", { tabid: "t1" }),
            info("b", "working", { tabid: "t2" }),
            info("c", "working", { tabid: "t2" }),
            info("d", "working", { tabid: "pinned" }),
        ];
        const owned = agentOwnedViews(["t1", "t2", "t3"], agents);
        expect(Array.from(owned)).toEqual([["t1", "a"]]);
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
