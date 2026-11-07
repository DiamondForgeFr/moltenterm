// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { DurableSession, DurableSessionsData } from "../sessions/sessions-model";
import { cardGroups, cardRow } from "./boss-card-model";
import { agentGroups, currentFirst, groupHasWorkspace, rowCount, sessionGroups, taskOf } from "./brokk-rows-model";

const Home = "/Users/me";
const Now = 1_000_000_000_000;

function session(id: string, extra: Partial<DurableSession> = {}): DurableSession {
    return {
        id,
        shortid: id.slice(0, 8),
        connection: "",
        connstate: "connected",
        workspaceorder: 0,
        shown: true,
        canshow: true,
        canend: true,
        workspaceid: "wsA",
        workspacename: "Alpha",
        startedat: Now - 12 * 60 * 1000,
        ...extra,
    };
}

function data(...sessions: DurableSession[]): DurableSessionsData {
    return { sessions, runningagents: sessions.filter((s) => s.agent).length, version: 1 };
}

const list = data(
    session("zoe", {
        workspaceid: "wsB",
        workspacename: "Beta",
        workspaceorder: 2,
        agent: "claude",
        agentname: "Claude Code",
        firstname: "Zoé",
        agentstate: "waiting",
        modelname: "Opus 5.5",
        effort: "high",
        context: { ticket: 2024 },
    }),
    session("jo", {
        workspaceid: "wsA",
        workspacename: "Alpha",
        workspaceorder: 1,
        agent: "codex",
        agentname: "Codex",
        firstname: "Jo",
        agentstate: "working",
    }),
    session("zsh", { workspaceid: "wsA", workspacename: "Alpha", workspaceorder: 1, command: "zsh" }),
    session("ci", {
        workspaceid: "wsB",
        workspacename: "Beta",
        workspaceorder: 2,
        connection: "build-ci",
        connstate: "disconnected",
        command: "bash",
    }),
    session("lost", { shown: false, workspaceid: "wsB", workspacename: "Beta", workspaceorder: 2, command: "top" })
);

describe("the Agents panel (FR-BOSS-009, AC19)", () => {
    it("lists only the sessions that run an agent, grouped by workspace, the current one first", () => {
        const groups = agentGroups(cardGroups(list, "wsB", Home, Now));
        expect(groups.map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([
            ["wsB", ["zoe"]],
            ["wsA", ["jo"]],
        ]);
    });

    it("puts the current workspace first even when it comes last in the workspaces' order", () => {
        const groups = agentGroups(cardGroups(list, "wsA", Home, Now));
        expect(groups.map((g) => g.id)).toEqual(["wsA", "wsB"]);
    });

    it("gives a row its first name, its agent, its model and its ticket", () => {
        const row = agentGroups(cardGroups(list, "wsB", Home, Now))[0].rows[0];
        expect(row).toMatchObject({
            name: "Zoé",
            agentName: "Claude Code",
            state: "waiting",
            ticket: 2024,
        });
        expect(row.model).toContain("Opus 5.5");
        expect(taskOf(row)).toBe("#2024");
    });

    it("names the project when the session names no ticket", () => {
        const row = cardRow(
            session("p", { agent: "claude", agentname: "Claude Code", firstname: "Léa", folder: "/Users/me/forge" }),
            0,
            Home,
            Now
        );
        expect(row.ticket).toBe(0);
        expect(taskOf(row)).toBe("forge");
    });

    it("drops a workspace that has no agent", () => {
        const onlyShell = data(session("zsh", { command: "zsh" }));
        expect(agentGroups(cardGroups(onlyShell, "wsA", Home, Now))).toEqual([]);
    });
});

describe("the Sessions panel (FR-BOSS-009, AC19)", () => {
    it("lists the terminals and the SSH sessions that run no agent, and no agent", () => {
        const groups = sessionGroups(cardGroups(list, "wsA", Home, Now));
        const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
        expect(ids.sort()).toEqual(["ci", "lost", "zsh"]);
    });

    it("keeps the host and the state of an SSH session, and offers Reconnecter when its connection is lost", () => {
        const ci = sessionGroups(cardGroups(list, "wsA", Home, Now))
            .flatMap((g) => g.rows)
            .find((r) => r.id === "ci");
        expect(ci).toMatchObject({ host: "build-ci", hostState: "disconnected", canReconnect: true });
    });

    it("does not offer Reconnecter on a connected session or a local one", () => {
        const rows = sessionGroups(cardGroups(list, "wsA", Home, Now)).flatMap((g) => g.rows);
        expect(rows.find((r) => r.id === "zsh")).toMatchObject({ host: "", canReconnect: false });
    });

    it("keeps the sessions no pane shows in a group of their own, which has no workspace to show", () => {
        const groups = sessionGroups(cardGroups(list, "wsA", Home, Now));
        const hidden = groups.find((g) => g.unplaced);
        expect(hidden.rows.map((r) => r.id)).toEqual(["lost"]);
        expect(groupHasWorkspace(hidden)).toBe(false);
        expect(groupHasWorkspace(groups.find((g) => g.id === "wsA"))).toBe(true);
    });

    it("counts the rows it lists", () => {
        expect(rowCount(sessionGroups(cardGroups(list, "wsA", Home, Now)))).toBe(3);
        expect(rowCount(agentGroups(cardGroups(list, "wsA", Home, Now)))).toBe(2);
        expect(rowCount(sessionGroups(cardGroups(null, "wsA", Home, Now)))).toBe(0);
    });

    it("keeps the order of the groups when none is current", () => {
        const groups = cardGroups(list, "other", Home, Now);
        expect(currentFirst(groups).map((g) => g.id)).toEqual(groups.map((g) => g.id));
    });
});
