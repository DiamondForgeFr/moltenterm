// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import {
    agentProjectLabel,
    agentRowLook,
    agentRowTarget,
    readTreeState,
    readTreeStates,
    sidebarSections,
    toggleSection,
    toggleTree,
    workspaceAgents,
} from "./sidebar-agents-model";
import type { WorkspaceProjectEntry } from "./workspace-projects";

const Desktop: WorkspaceProjectEntry = { id: "p1", type: "desktop", dir: "/Users/x/notulia-desktop", branch: "" };
const Website: WorkspaceProjectEntry = { id: "p2", type: "website", dir: "/Users/x/notulia-web", branch: "" };

describe("agentProjectLabel (FR-SHELL-084, #1746)", () => {
    it("shows nothing with one project, even for an agent inside it", () => {
        expect(agentProjectLabel("/Users/x/notulia-web/src", [Website])).toBeNull();
    });

    it("shows nothing without projects", () => {
        expect(agentProjectLabel("/Users/x/notulia-web", [])).toBeNull();
        expect(agentProjectLabel("/Users/x/notulia-web", undefined)).toBeNull();
    });

    it("names the project the agent runs in, not the workspace's first one", () => {
        expect(agentProjectLabel("/Users/x/notulia-web", [Desktop, Website])).toEqual({
            text: "website",
            outside: false,
        });
        expect(agentProjectLabel("/Users/x/notulia-desktop/src/main", [Desktop, Website])).toEqual({
            text: "desktop",
            outside: false,
        });
    });

    it("takes the longest project when projects nest", () => {
        const app = { id: "p3", type: "", dir: "/Users/x/notulia-web/packages/app", branch: "" };
        expect(agentProjectLabel("/Users/x/notulia-web/packages/app/lib", [Website, app])).toEqual({
            text: "app",
            outside: false,
        });
        expect(agentProjectLabel("/Users/x/notulia-web/docs", [Website, app])).toEqual({
            text: "website",
            outside: false,
        });
    });

    it("names, among the projects of one client folder, the one whose repository the agent runs in (#1777)", () => {
        const web = { id: "p1", type: "web", dir: "/c/ofpis", branch: "", repo: "/c/ofpis/app" };
        const api = { id: "p2", type: "api", dir: "/c/ofpis", branch: "", repo: "/c/ofpis/api" };
        const docs = { id: "p3", type: "docs", dir: "/c/ofpis", branch: "" };
        expect(agentProjectLabel("/c/ofpis/api/src", [web, api, docs])).toEqual({ text: "api", outside: false });
        expect(agentProjectLabel("/c/ofpis/app", [web, api, docs])).toEqual({ text: "web", outside: false });
        expect(agentProjectLabel("/c/ofpis/mails", [web, api, docs])).toEqual({ text: "web", outside: false });
        expect(agentProjectLabel("/c/ofpis/app/x", [docs, web])).toEqual({ text: "web", outside: false });
        const elsewhere = { id: "p4", type: "x", dir: "/c/ofpis", branch: "", repo: "/other/app" };
        expect(agentProjectLabel("/other/app/x", [elsewhere, docs])).toEqual({ text: "x", outside: true });
    });

    it("does not match a folder that only shares a name prefix with a project", () => {
        expect(agentProjectLabel("/Users/x/notulia-web-old", [Desktop, Website])).toEqual({
            text: "notulia-web-old",
            outside: true,
        });
    });

    it("shows the folder's name, muted, for an agent outside every project", () => {
        expect(agentProjectLabel("/tmp/scratch/agent-run", [Desktop, Website])).toEqual({
            text: "agent-run",
            outside: true,
        });
    });

    it("names a project without a type by its folder", () => {
        const untyped = { id: "p4", type: "", dir: "/Users/x/tools/cli", branch: "" };
        expect(agentProjectLabel("/Users/x/tools/cli/cmd", [Website, untyped])).toEqual({
            text: "cli",
            outside: false,
        });
    });

    it("reads Windows paths and trailing separators", () => {
        const win = [
            { id: "w1", type: "desktop", dir: "C:\\work\\desktop", branch: "" },
            { id: "w2", type: "website", dir: "C:\\work\\web\\", branch: "" },
        ];
        expect(agentProjectLabel("C:\\work\\web\\src\\", win)).toEqual({ text: "website", outside: false });
    });

    it("shows nothing when the agent's folder is unknown", () => {
        expect(agentProjectLabel("", [Desktop, Website])).toBeNull();
        expect(agentProjectLabel(undefined, [Desktop, Website])).toBeNull();
    });
});

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
        let s = toggleTree(null);
        expect(s.open).toBe(true);
        s = toggleSection(s, "subs");
        expect(s.shut).toEqual({ subs: true });
        s = toggleSection(s, "links");
        expect(s.shut).toEqual({ subs: true, links: true });
        s = toggleSection(s, "subs");
        expect(s.shut).toEqual({ subs: false, links: true });
        s = toggleTree(s);
        expect(s).toEqual({ open: false, shut: { subs: false, links: true } });
    });

    it("reads a terminal's stored state defensively", () => {
        expect(readTreeState(null)).toBeNull();
        expect(readTreeState("open")).toBeNull();
        expect(readTreeState({ open: true, shut: { links: true, other: true } })).toEqual({
            open: true,
            shut: { links: true },
        });
    });

    it("reads the old stored map defensively", () => {
        expect(readTreeStates(null)).toEqual({});
        expect(readTreeStates([1])).toEqual({});
        expect(readTreeStates({ a: { open: true, shut: { subs: true, other: true } }, b: 3 })).toEqual({
            a: { open: true, shut: { subs: true } },
        });
    });
});
