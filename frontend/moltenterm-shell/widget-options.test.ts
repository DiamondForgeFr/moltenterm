// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { DurableSession } from "./sessions/sessions-model";
import {
    cicdRuns,
    filterBranches,
    filterSessions,
    projectBranches,
    sessionsAgentChoices,
    sessionsFiltered,
} from "./widget-options";

function session(id: string, extra: Partial<DurableSession> = {}): DurableSession {
    return {
        id,
        shortid: id,
        connection: "",
        connstate: "connected",
        workspaceorder: 0,
        shown: true,
        canshow: true,
        canend: true,
        ...extra,
    };
}

const Sessions = [
    session("claude-waiting", { agent: "claude", agentstate: "waiting", folder: "/p/app" }),
    session("codex-working", { agent: "codex", agentstate: "working", folder: "/p/app/sub" }),
    session("shell", { folder: "/home/me" }),
    session("hidden-claude", { agent: "claude", shown: false, folder: "/p/other" }),
    session("remote", { agent: "claude", connection: "user@host", folder: "/p/app" }),
];

const ids = (list: DurableSession[]) => list.map((s) => s.id);
const Known = ["claude", "codex"];

describe("widget options (FR-SHELL-049, DS-SHELL-090)", () => {
    it("filters sessions by agent", () => {
        expect(ids(filterSessions(Sessions, { agent: "agents" }, ""))).toEqual([
            "claude-waiting",
            "codex-working",
            "hidden-claude",
            "remote",
        ]);
        expect(ids(filterSessions(Sessions, { agent: "codex" }, "", Known))).toEqual(["codex-working"]);
        expect(ids(filterSessions(Sessions, { agent: "shells" }, ""))).toEqual(["shell"]);
    });

    it("#1460: offers the agents the registry knows, and filters by any of them", () => {
        const choices = sessionsAgentChoices([
            { id: "claude", name: "Claude Code" },
            { id: "myagent", name: "My Agent" },
        ]);
        expect(choices.map((c) => c.value)).toEqual(["all", "agents", "claude", "myagent", "shells"]);
        expect(sessionsAgentChoices(undefined).map((c) => c.value)).toEqual(["all", "agents", "shells"]);
        const mine = [session("m", { agent: "myagent" }), session("s")];
        expect(ids(filterSessions(mine, { agent: "myagent" }, "", ["myagent"]))).toEqual(["m"]);
        expect(ids(filterSessions(mine, { agent: "myagent" }, ""))).toEqual(["m", "s"]);
    });

    it("filters sessions by the workspace's folder, local ones only", () => {
        expect(ids(filterSessions(Sessions, { folder: "workspace" }, "/p/app"))).toEqual([
            "claude-waiting",
            "codex-working",
        ]);
        expect(filterSessions(Sessions, { folder: "workspace" }, "")).toEqual([]);
    });

    it("filters sessions by state, an agent without a state counting as idle", () => {
        expect(ids(filterSessions(Sessions, { state: "waiting" }, ""))).toEqual(["claude-waiting"]);
        expect(ids(filterSessions(Sessions, { state: "idle" }, ""))).toEqual(["hidden-claude", "remote"]);
        expect(ids(filterSessions(Sessions, { state: "hidden" }, ""))).toEqual(["hidden-claude"]);
        expect(
            ids(filterSessions(Sessions, { agent: "claude", state: "idle", folder: "workspace" }, "/p", Known))
        ).toEqual(["hidden-claude"]);
    });

    it("treats unknown or missing values as no filter", () => {
        expect(sessionsFiltered({})).toBe(false);
        expect(sessionsFiltered({ agent: "bogus", state: null })).toBe(false);
        expect(sessionsFiltered({ folder: "workspace" })).toBe(true);
        expect(filterSessions(Sessions, { agent: "bogus" }, "")).toEqual(Sessions);
    });

    it("reads the CI/CD runs and the Project branches with their defaults, and filters branches", () => {
        expect(cicdRuns("cd")).toBe("cd");
        expect(cicdRuns("bogus")).toBe("remote");
        expect(cicdRuns(undefined)).toBe("remote");
        expect(projectBranches("merged")).toBe("merged");
        expect(projectBranches(1)).toBe("all");
        const branches = [
            { id: "a", state: "open" as const },
            { id: "b", state: "merged" as const },
        ];
        expect(filterBranches(branches, "open").map((b) => b.id)).toEqual(["a"]);
        expect(filterBranches(branches, "merged").map((b) => b.id)).toEqual(["b"]);
        expect(filterBranches(branches, null)).toBe(branches);
    });
});
