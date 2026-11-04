// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { DurableSession, DurableSessionsData } from "../sessions/sessions-model";
import {
    cardGroups,
    cardKeyAction,
    cardRow,
    cardRowCount,
    focusIsFree,
    focusTargetOf,
    isOutsidePress,
    restoreFocus,
    sessionBranch,
    sessionProject,
} from "./boss-card-model";

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
        workspaceid: "ws1",
        workspacename: "Work",
        startedat: Now - 12 * 60 * 1000,
        ...extra,
    };
}

function data(...sessions: DurableSession[]): DurableSessionsData {
    return { sessions, runningagents: sessions.filter((s) => s.agent).length, version: 1 };
}

describe("a session's project and branch", () => {
    it("is the repository's main checkout for a worktree, wherever the worktree lies", () => {
        const s = session("a", {
            folder: "/Users/me/code/forge/.claude/worktrees/agent-1",
            worktree: {
                path: "/Users/me/code/forge/.claude/worktrees/agent-1",
                branch: "feature/12-x",
                main: "/Users/me/code/forge",
            },
        });
        expect(sessionProject(s, Home)).toBe("forge");
        expect(sessionBranch(s)).toBe("feature/12-x");
    });

    it("falls back to the repository its pull request names, then to its folder", () => {
        expect(sessionProject(session("a", { context: { repo: "acme/widget", branch: "fix/3-y" } }), Home)).toBe(
            "widget"
        );
        expect(sessionBranch(session("a", { context: { repo: "acme/widget", branch: "fix/3-y" } }))).toBe("fix/3-y");
        expect(sessionProject(session("a", { folder: "/Users/me/code/notes" }), Home)).toBe("notes");
        expect(sessionProject(session("a", { folder: Home }), Home)).toBe("Home");
        expect(sessionProject(session("a"), Home)).toBe("");
        expect(sessionBranch(session("a"))).toBe("");
    });

    it("reads a remote folder as it is, not against this computer's home", () => {
        const s = session("a", { connection: "dev@box", folder: "/Users/me/srv/api" });
        expect(sessionProject(s, Home)).toBe("api");
    });
});

describe("a row (AC2)", () => {
    it("tells the agent's first name, its state, its project, its branch and how long it has run", () => {
        const row = cardRow(
            session("a", {
                agent: "claude",
                agentname: "Claude Code",
                agentstate: "waiting",
                firstname: "Léa",
                folder: "/Users/me/code/forge",
                worktree: { path: "/Users/me/code/forge", branch: "main", main: "/Users/me/code/forge" },
            }),
            0,
            Home,
            Now
        );
        expect(row).toMatchObject({
            id: "a",
            name: "Léa",
            kind: "agent",
            state: "waiting",
            stateText: "waiting for you",
            project: "forge",
            branch: "main",
            up: "12 min",
            host: "",
            shown: true,
            canShow: true,
        });
    });

    it("treats an agent that said nothing yet as idle", () => {
        const row = cardRow(session("a", { agent: "codex", firstname: "Max" }), 0, Home, Now);
        expect(row.state).toBe("idle");
    });

    it("names a shell by its place and says what it runs, with no state", () => {
        const row = cardRow(session("a", { folder: "/Users/me/code/forge", command: "npm run dev" }), 0, Home, Now);
        expect(row).toMatchObject({ name: "forge", kind: "command", state: "", stateText: "npm run dev" });
        expect(row.project).toBe("");
        expect(cardRow(session("b", { folder: Home }), 0, Home, Now)).toMatchObject({
            name: "Home",
            kind: "shell",
            stateText: "Shell",
        });
    });

    it("names the host of a session that is not on this computer, with its connection state", () => {
        const row = cardRow(session("a", { connection: "dev@box", connstate: "disconnected" }), 0, Home, Now);
        expect(row.host).toBe("dev@box");
        expect(row.hostState).toBe("disconnected");
        expect(row.hostTitle).toContain("dev@box");
    });

    it("offers Show it for a session whose pane is gone, and says why when it cannot be shown", () => {
        expect(cardRow(session("a", { shown: false }), 0, Home, Now).shown).toBe(false);
        const blocked = cardRow(session("b", { shown: false, canshow: false, reason: "olderversion" }), 0, Home, Now);
        expect(blocked.canShow).toBe(false);
        expect(blocked.blockedTitle).toBe("Started by an older MoltenTerm: it can only be ended.");
        expect(cardRow(session("c"), 0, Home, Now).blockedTitle).toBe("");
    });
});

describe("the groups (AC2)", () => {
    const list = data(
        session("b2", {
            workspaceid: "wsB",
            workspacename: "Beta",
            workspaceorder: 2,
            agent: "claude",
            firstname: "Zoé",
        }),
        session("a1", {
            workspaceid: "wsA",
            workspacename: "Alpha",
            workspaceorder: 1,
            agent: "codex",
            firstname: "Jo",
        }),
        session("a0", { workspaceid: "wsA", workspacename: "Alpha", workspaceorder: 1 }),
        session("gone", { shown: false, workspaceid: "wsB", workspacename: "Beta", workspaceorder: 2 })
    );

    it("lists the sessions no pane shows first, then a group per workspace in the workspaces' order", () => {
        const groups = cardGroups(list, "wsB", Home, Now);
        expect(groups.map((g) => [g.id, g.unplaced])).toEqual([
            ["hidden", true],
            ["wsA", false],
            ["wsB", false],
        ]);
        expect(groups.map((g) => g.title)).toEqual(["Not in a pane", "Alpha", "Beta"]);
        expect(groups.find((g) => g.id === "wsB").current).toBe(true);
        expect(groups.find((g) => g.id === "wsA").current).toBe(false);
    });

    it("puts the agents that need the developer first in a group, then the commands", () => {
        const alpha = cardGroups(list, "wsA", Home, Now).find((g) => g.id === "wsA");
        expect(alpha.rows.map((r) => r.id)).toEqual(["a1", "a0"]);
    });

    it("counts every row of every group", () => {
        expect(cardRowCount(cardGroups(list, "wsA", Home, Now))).toBe(4);
        expect(cardRowCount(cardGroups(data(), "wsA", Home, Now))).toBe(0);
        expect(cardRowCount(cardGroups(null, "wsA", Home, Now))).toBe(0);
    });

    it("nests a sub-session under the session that handed it work, as the Sessions view does", () => {
        const nested = data(
            session("parent", { agent: "claude", firstname: "Léa" }),
            session("child", { agent: "codex", firstname: "Max", parentid: "parent" })
        );
        const rows = cardGroups(nested, "ws1", Home, Now)[0].rows;
        expect(rows.map((r) => [r.id, r.depth])).toEqual([
            ["parent", 0],
            ["child", 1],
        ]);
    });

    it("keeps every workspace's color for its swatch", () => {
        const coloured = data(session("a", { workspacecolor: "#ff8800" }));
        expect(cardGroups(coloured, "ws1", Home, Now)[0].color).toBe("#ff8800");
        expect(cardGroups(data(session("b")), "ws1", Home, Now)[0].color).toBe("");
    });
});

describe("a press outside (AC5)", () => {
    const inCard = {};
    const card = { contains: (node: unknown) => node === inCard };
    const plain = { closest: () => null };
    const anchor = { closest: (selector: string) => (selector === "[data-boss-anchor]" ? {} : null) };

    it("is a press that lands neither in the card nor on the bubble or the pennant", () => {
        expect(isOutsidePress(plain, card)).toBe(true);
    });

    it("is not one inside the card", () => {
        expect(isOutsidePress(inCard, card)).toBe(false);
    });

    it("is not one on the bubble or the pennant, whose click toggles the card", () => {
        expect(isOutsidePress(anchor, card)).toBe(false);
    });

    it("is none without a target", () => {
        expect(isOutsidePress(null, card)).toBe(false);
    });
});

describe("Escape (AC5)", () => {
    it("hides the card and is the card's alone while the focus is in it", () => {
        expect(cardKeyAction({ key: "Escape", focusAtHome: true })).toEqual({ hide: true, consume: true });
    });

    it("hides the card but goes on to a terminal that holds the focus: a vim user's Escape is never taken", () => {
        expect(cardKeyAction({ key: "Escape", focusAtHome: false })).toEqual({ hide: true, consume: false });
    });

    it("leaves every other key alone", () => {
        for (const key of ["a", "Enter", "Tab", "ArrowDown", " "]) {
            expect(cardKeyAction({ key, focusAtHome: true })).toEqual({ hide: false, consume: false });
        }
    });
});

describe("giving the focus back (AC5)", () => {
    const body = { name: "body" };
    const target = () => ({ focus: vi.fn(), isConnected: true });

    it("remembers the element that held the focus, not the page itself", () => {
        const el = target();
        expect(focusTargetOf(el, { body })).toBe(el);
        expect(focusTargetOf(body, { body })).toBeNull();
        expect(focusTargetOf(null, { body })).toBeNull();
        expect(focusTargetOf({}, { body })).toBeNull();
    });

    it("counts the focus as free on the page, nowhere, on a removed element, or in the card that is leaving", () => {
        expect(focusIsFree({ activeElement: body, body })).toBe(true);
        expect(focusIsFree({ activeElement: null, body })).toBe(true);
        expect(focusIsFree({ activeElement: { isConnected: false }, body })).toBe(true);
        expect(
            focusIsFree({ activeElement: { closest: (s: string) => (s === "[data-boss-card]" ? {} : null) }, body })
        ).toBe(true);
    });

    it("counts it as taken when the developer put it on another element", () => {
        expect(focusIsFree({ activeElement: { isConnected: true, closest: () => null }, body })).toBe(false);
    });

    it("restores it without scrolling, only when it is free", () => {
        const el = target();
        expect(restoreFocus(el, { activeElement: body, body })).toBe(true);
        expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
        const other = target();
        expect(restoreFocus(other, { activeElement: { isConnected: true, closest: () => null }, body })).toBe(false);
        expect(other.focus).not.toHaveBeenCalled();
    });

    it("restores nothing to an element that left the page, or to none", () => {
        const gone = { focus: vi.fn(), isConnected: false };
        expect(restoreFocus(gone, { activeElement: body, body })).toBe(false);
        expect(gone.focus).not.toHaveBeenCalled();
        expect(restoreFocus(null, { activeElement: body, body })).toBe(false);
    });
});
