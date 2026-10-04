// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    applySessions,
    cleanupConfirmText,
    cleanupResultText,
    connChip,
    connStateLabel,
    DurableSession,
    endConfirmText,
    flattenGroups,
    formatAge,
    groupSessions,
    middleTruncate,
    moveSelection,
    nextSelection,
    outputText,
    railBadge,
    reasonLabel,
    rowAriaLabel,
    sortSessions,
} from "./sessions-model";

const Home = "/Users/me";

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
        ...extra,
    };
}

describe("applying lists", () => {
    it("keeps the newer version", () => {
        const v2 = { sessions: [session("a")], runningagents: 0, version: 2 };
        const v1 = { sessions: [], runningagents: 0, version: 1 };
        expect(applySessions(null, v1)).toEqual(v1);
        expect(applySessions(v2, v1)).toBe(v2);
        expect(applySessions(v1, v2)).toEqual(v2);
        expect(applySessions(v2, null)).toBe(v2);
    });
});

describe("groups and order", () => {
    const list = [
        session("b-idle", {
            workspaceid: "wsB",
            workspacename: "B",
            workspaceorder: 1,
            agent: "claude",
            agentstate: "idle",
        }),
        session("a-cmd", { workspaceid: "wsA", workspacename: "A", workspaceorder: 0, lastoutputat: 50 }),
        session("hidden", { shown: false, reason: "detached", workspaceid: undefined, workspaceorder: -1 }),
        session("b-wait", {
            workspaceid: "wsB",
            workspacename: "B",
            workspaceorder: 1,
            agent: "codex",
            agentstate: "waiting",
        }),
        session("a-recent", { workspaceid: "wsA", workspacename: "A", workspaceorder: 0, lastoutputat: 90 }),
    ];

    it("puts the sessions no pane shows first, then the workspaces in the rail's order", () => {
        const groups = groupSessions(list, "wsB");
        expect(groups.map((g) => g.title)).toEqual(["Not in a pane", "A", "B"]);
        expect(groups.map((g) => !!g.current)).toEqual([false, false, true]);
        expect(flattenGroups(groups)).toEqual(["hidden", "a-recent", "a-cmd", "b-wait", "b-idle"]);
    });

    it("has no hidden group without such sessions", () => {
        expect(groupSessions([session("x")], "ws1").map((g) => g.title)).toEqual(["Work"]);
        expect(groupSessions([], "ws1")).toEqual([]);
    });

    it("sorts by urgency, then by the latest output", () => {
        const sorted = sortSessions([
            session("none", { lastoutputat: 100 }),
            session("idle", { agent: "claude", agentstate: "idle" }),
            session("working", { agent: "claude", agentstate: "working" }),
            session("error", { agent: "claude", agentstate: "error" }),
            session("waiting", { agent: "claude", agentstate: "waiting" }),
            session("done", { agent: "claude", agentstate: "done" }),
            session("none-old", { lastoutputat: 10 }),
        ]);
        expect(sorted.map((s) => s.id)).toEqual(["waiting", "error", "working", "done", "idle", "none", "none-old"]);
    });
});

describe("keyboard", () => {
    const order = Array.from({ length: 25 }, (_, i) => `r${i}`);
    it("moves across groups and stops at the ends", () => {
        expect(moveSelection(order, "r0", "ArrowUp")).toBe("r0");
        expect(moveSelection(order, "r0", "ArrowDown")).toBe("r1");
        expect(moveSelection(order, "r24", "ArrowDown")).toBe("r24");
        expect(moveSelection(order, "r3", "Home")).toBe("r0");
        expect(moveSelection(order, "r3", "End")).toBe("r24");
        expect(moveSelection(order, "r3", "PageDown")).toBe("r13");
        expect(moveSelection(order, "r20", "PageDown")).toBe("r24");
        expect(moveSelection(order, "r5", "PageUp")).toBe("r0");
        expect(moveSelection(order, null, "ArrowDown")).toBe("r0");
        expect(moveSelection(order, "r5", "x")).toBe("r5");
        expect(moveSelection([], "r5", "ArrowDown")).toBeNull();
    });

    it("hands the focus of a row that went away to the next one, else the one above", () => {
        expect(nextSelection(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
        expect(nextSelection(["a", "b", "c"], ["a", "b"], "c")).toBe("b");
        expect(nextSelection(["a", "b"], ["a", "b"], "b")).toBe("b");
        expect(nextSelection(["a"], [], "a")).toBeNull();
    });
});

describe("text", () => {
    it("formats ages", () => {
        const now = 10_000_000;
        expect(formatAge(0, now)).toBe("");
        expect(formatAge(now - 2000, now)).toBe("now");
        expect(formatAge(now - 42_000, now)).toBe("42 s");
        expect(formatAge(now - 3 * 60_000, now)).toBe("3 min");
        expect(formatAge(now - (2 * 60 + 14) * 60_000, now)).toBe("2 h 14 min");
        expect(formatAge(now - 2 * 3600_000, now)).toBe("2 h");
        expect(formatAge(now - 3 * 86400_000, now + 1000)).toBe("3 d");
        expect(formatAge(now + 5000, now)).toBe("now");
        expect(outputText(session("x", { lastoutputat: now - 1000 }), now)).toBe("output just now");
        expect(outputText(session("x", { lastoutputat: now - 180_000 }), now)).toBe("output 3 min ago");
    });

    it("labels reasons and connections", () => {
        expect(reasonLabel("panegone")).toBe("pane closed");
        expect(reasonLabel("olderversion")).toBe("older version");
        expect(connChip(session("l")).label).toBe("local");
        expect(connChip(session("r", { connection: "me@box", connstate: "reconnecting" }))).toEqual({
            label: "me@box",
            state: "reconnecting",
            title: "me@box: reconnecting…",
        });
        expect(
            connStateLabel(session("r", { connection: "me@box", connstate: "disconnected", connerror: "timeout" }))
        ).toBe("me@box: disconnected\ntimeout");
    });

    it("truncates in the middle", () => {
        expect(middleTruncate("~/short", 20)).toBe("~/short");
        const cut = middleTruncate("~/projects/very/long/path/to/the/app", 16);
        expect(cut.length).toBe(16);
        expect(cut.startsWith("~/proje")).toBe(true);
        expect(cut.endsWith("the/app")).toBe(true);
    });

    it("names the agent or the command, the folder and the workspace when asking to end", () => {
        const now = 10_000_000;
        const claude = session("c", {
            agent: "claude",
            agentname: "Claude Code",
            agentstate: "working",
            folder: "/Users/me/proj/app",
            startedat: now - 2 * 3600_000,
            tabname: "Main",
        });
        expect(endConfirmText(claude, Home, now)).toEqual({
            title: "End Claude Code in ~/proj/app?",
            subtitle: "Work › Main · local · up 2 h",
            warning: "Claude Code is working: its current task stops.",
            confirm: "End session",
        });
        const sleep = session("s", {
            command: "sleep 600",
            connection: "me@box",
            folder: "/srv",
            shown: false,
            workspacename: undefined,
        });
        const text = endConfirmText(sleep, Home, now);
        expect(text.title).toBe("End sleep 600 in /srv?");
        expect(text.subtitle).toBe("not in a pane · me@box");
        expect(text.warning).toBeUndefined();
        expect(
            endConfirmText(session("w", { agent: "codex", agentname: "Codex", agentstate: "waiting" }), Home, now)
                .warning
        ).toBe("Codex is waiting for you: what it was asking is lost.");
    });

    it("counts the cleanup", () => {
        expect(cleanupConfirmText([session("a"), session("b")]).confirm).toBe("End 2 sessions");
        expect(cleanupConfirmText([session("a")]).title).toBe("End 1 session not in a pane?");
        expect(cleanupResultText({ ended: ["a", "b", "c"], skipped: ["d"] })).toBe(
            "Ended 3 · 1 skipped (shown in a pane or gone since)"
        );
        expect(cleanupResultText({ ended: [], skipped: [], failed: ["x"] })).toBe(
            "Ended 0 · 1 ending once their host is back"
        );
    });

    it("reads a whole row for screen readers", () => {
        const now = 10_000_000;
        const label = rowAriaLabel(
            session("c", {
                agent: "claude",
                agentname: "Claude Code",
                agentstate: "waiting",
                command: "claude",
                folder: "/Users/me/app",
                worktree: { path: "/Users/me/app-wt", branch: "feat" },
                startedat: now - 60_000,
                lastoutputat: now - 1000,
                tabname: "T1",
            }),
            Home,
            now
        );
        expect(label).toBe(
            "Claude Code, waiting for you, claude, local, in ~/app, branch feat, up 1 min, output just now, Work › T1"
        );
    });
});

describe("rail badge", () => {
    it("counts the running agents, coloured by the most urgent state", () => {
        expect(railBadge(null)).toEqual({ count: 0, tone: "accent", label: "Sessions" });
        expect(railBadge({ sessions: [session("a")], runningagents: 0, version: 1 })).toEqual({
            count: 0,
            tone: "accent",
            label: "Sessions · 1 session running",
        });
        const data = {
            sessions: [
                session("a", { agent: "claude", agentstate: "working" }),
                session("b", { agent: "codex", agentstate: "waiting" }),
                session("c", { agent: "claude", agentstate: "error" }),
                session("d"),
            ],
            runningagents: 3,
            version: 1,
        };
        expect(railBadge(data)).toEqual({
            count: 3,
            tone: "waiting",
            label: "Sessions · 3 agents running, 1 waiting, 1 with an error",
        });
        data.sessions[1].agentstate = "working";
        expect(railBadge(data).tone).toBe("error");
        data.sessions[2].agentstate = "done";
        expect(railBadge(data).tone).toBe("accent");
    });
});
