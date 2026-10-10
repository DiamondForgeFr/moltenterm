// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import type { TreeMarker } from "../worktree-model";
import {
    agentErrorPill,
    durablePill,
    missingWorktreePill,
    multiInputPill,
    pickHeaderPill,
    QuestionMaxChars,
    remotePill,
    termContextParts,
    termHeaderTitle,
    truncateQuestion,
    waitingPill,
} from "./header-model";

function agent(state: AgentStateInfo["state"], message?: string): AgentStateInfo {
    return { blockid: "b1", agent: "claude", agentname: "Claude Code", state, message, version: 1 };
}

const healthy = { status: "connected", connected: true, wshenabled: true };

describe("waiting question (FR-SHELL-052-AC3)", () => {
    it("keeps a short question whole and collapses its whitespace", () => {
        expect(truncateQuestion("  Allow   npm\ntest?  ")).toBe("Allow npm test?");
    });

    it("cuts at 48 characters, ellipsis included", () => {
        const long = "Claude needs your permission to run the command npm run build:all --watch";
        const cut = truncateQuestion(long);
        expect(Array.from(cut).length).toBe(QuestionMaxChars);
        expect(cut.endsWith("…")).toBe(true);
        expect(long.startsWith(cut.slice(0, -1).trimEnd())).toBe(true);
    });

    it("never splits a surrogate pair", () => {
        const cut = truncateQuestion("🙂".repeat(60));
        expect(Array.from(cut).length).toBe(QuestionMaxChars);
        expect(cut).toBe("🙂".repeat(47) + "…");
    });

    it("is an amber pill with Go and the whole question on hover", () => {
        const long = "Claude needs your permission to run the command npm run build:all --watch";
        const pill = waitingPill(agent("waiting", long));
        expect(pill).toMatchObject({ kind: "waiting", tone: "warning", action: "Go", dot: true });
        expect(pill.label).toBe(truncateQuestion(long));
        expect(pill.title).toContain(long);
    });

    it("says Waiting when the Notification hook gave no text", () => {
        expect(waitingPill(agent("waiting")).label).toBe("Waiting");
        expect(waitingPill(agent("waiting", "   ")).label).toBe("Waiting");
    });

    it("is absent unless the agent waits", () => {
        expect(waitingPill(agent("working", "Allow npm test?"))).toBeNull();
        expect(waitingPill(null)).toBeNull();
    });
});

describe("one pill, the most urgent (DS-SHELL-093)", () => {
    it("ranks waiting > error > missing worktree > multi input > remote > durable", () => {
        const waiting = waitingPill(agent("waiting", "Allow npm test?"));
        const error = agentErrorPill(agent("error", "Exited with code 2"));
        const missing = missingWorktreePill({ kind: "missing", title: "gone", icon: "x" } as TreeMarker);
        const multi = multiInputPill(true);
        const remote = remotePill("me@host", false, { ...healthy, status: "error", connected: false });
        const durable = durablePill(true, "connected");
        const all = [durable, remote, multi, missing, error, waiting];
        expect(pickHeaderPill(all).kind).toBe("waiting");
        expect(pickHeaderPill(all.slice(0, 5)).kind).toBe("error");
        expect(pickHeaderPill(all.slice(0, 4)).kind).toBe("missingworktree");
        expect(pickHeaderPill(all.slice(0, 3)).kind).toBe("multiinput");
        expect(pickHeaderPill(all.slice(0, 2)).kind).toBe("remote");
        expect(pickHeaderPill(all.slice(0, 1)).kind).toBe("durable");
        expect(pickHeaderPill([null, null])).toBeNull();
    });

    it("uses the three tones only", () => {
        const pills = [
            waitingPill(agent("waiting")),
            agentErrorPill(agent("error")),
            multiInputPill(true),
            remotePill("me@host", false, { ...healthy, status: "connecting", connected: false }),
            durablePill(true, null),
        ];
        for (const pill of pills) {
            expect(["neutral", "warning", "danger"]).toContain(pill.tone);
        }
    });
});

describe("connection (FR-SHELL-052-AC2)", () => {
    it("gives a local or healthy remote panel no pill", () => {
        expect(remotePill("local", true, null)).toBeNull();
        expect(remotePill("", false, null)).toBeNull();
        expect(remotePill("me@host", false, healthy)).toBeNull();
    });

    it("names what is wrong with a remote connection", () => {
        expect(remotePill("me@host", false, { ...healthy, status: "connecting", connected: false }).label).toBe(
            "Connecting"
        );
        const error = remotePill("me@host", false, {
            status: "error",
            connected: false,
            wshenabled: false,
            error: "x",
        });
        expect(error).toMatchObject({ tone: "danger", label: "Can't connect" });
        expect(error.title).toContain("(x)");
        expect(remotePill("me@host", false, { ...healthy, status: "disconnected", connected: false }).label).toBe(
            "Disconnected"
        );
        expect(remotePill("me@host", false, { ...healthy, connhealthstatus: "stalled" }).tone).toBe("warning");
        expect(remotePill("me@host", false, { ...healthy, wshenabled: false }).label).toBe("No wsh");
    });
});

describe("durability (moved into the command panel)", () => {
    it("only names a durable session, neutral", () => {
        expect(durablePill(false, "connected")).toBeNull();
        expect(durablePill(null, null)).toBeNull();
        const pill = durablePill(true, "disconnected");
        expect(pill).toMatchObject({ kind: "durable", tone: "neutral", label: "Durable" });
        expect(pill.title).toContain("detached");
    });
});

describe("context and title (FR-SHELL-052-AC1)", () => {
    const worktree: TreeMarker = {
        kind: "worktree",
        label: "agent-a77",
        branch: "worktree-agent-a77",
        path: "/repo/.claude/worktrees/agent-a77",
        linked: false,
        outside: false,
        colorClass: "text-violet-300 border-violet-400/50 bg-violet-400/10",
        icon: "code-fork",
        title: "Worktree agent-a77 on worktree-agent-a77, not linked to this terminal",
    };

    it("shows the project then the branch, once", () => {
        const parts = termContextParts({
            folder: "/repo",
            projectName: "MoltenTerm",
            branch: "develop",
            marker: { ...worktree, kind: "main", label: "main tree", branch: "develop" },
        });
        expect(parts.map((p) => p.text)).toEqual(["MoltenTerm", "develop"]);
        expect(parts[1].icon).toBeUndefined();
    });

    it("marks a worktree's branch with its tree icon in the tree's text colour only", () => {
        const parts = termContextParts({ folder: "/x", projectName: "MoltenTerm", branch: "", marker: worktree });
        expect(parts.map((p) => p.text)).toEqual(["MoltenTerm", "worktree-agent-a77"]);
        expect(parts[1]).toMatchObject({ icon: "code-fork", iconClass: "text-violet-300" });
        expect(parts[1].title).toContain("Worktree agent-a77");
    });

    it("titles a terminal with its agent, else its own title, else Terminal", () => {
        expect(termHeaderTitle(agent("working"), "Build", "")).toBe("Claude Code");
        expect(termHeaderTitle(null, "Build", "")).toBe("Build");
        expect(termHeaderTitle(null, null, "")).toBe("Terminal");
    });
});
