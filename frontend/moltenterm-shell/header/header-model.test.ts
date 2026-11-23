// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
        expect(pill).toMatchObject({ kind: "waiting", tone: "waiting", action: "Go", dot: true });
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
        const durable = durablePill(true, "disconnected");
        const all = [durable, remote, multi, missing, error, waiting];
        expect(pickHeaderPill(all).kind).toBe("waiting");
        expect(pickHeaderPill(all.slice(0, 5)).kind).toBe("error");
        expect(pickHeaderPill(all.slice(0, 4)).kind).toBe("missingworktree");
        expect(pickHeaderPill(all.slice(0, 3)).kind).toBe("multiinput");
        expect(pickHeaderPill(all.slice(0, 2)).kind).toBe("remote");
        expect(pickHeaderPill(all.slice(0, 1)).kind).toBe("durable");
        expect(pickHeaderPill([null, null])).toBeNull();
    });

    it("uses the four tones only (waiting is its own since FR-SHELL-116)", () => {
        const pills = [
            waitingPill(agent("waiting")),
            agentErrorPill(agent("error")),
            multiInputPill(true),
            remotePill("me@host", false, { ...healthy, status: "connecting", connected: false }),
            durablePill(true, "done"),
        ];
        for (const pill of pills) {
            expect(["neutral", "warning", "waiting", "danger"]).toContain(pill.tone);
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
    it("takes no pill for an attached durable session, the default of a local terminal", () => {
        expect(durablePill(true, "connected")).toBeNull();
        expect(durablePill(true, null)).toBeNull();
        expect(durablePill(false, "disconnected")).toBeNull();
    });

    it("names a detached, starting or ended session, neutral", () => {
        const pill = durablePill(true, "disconnected");
        expect(pill).toMatchObject({ kind: "durable", tone: "neutral", label: "Detached" });
        expect(pill.title).toContain("detached");
        expect(durablePill(true, "init").label).toBe("Starting");
        expect(durablePill(true, "done").label).toBe("Session ended");
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

    it("gives a worktree its chip, with its icon, colour and title, before the branch (FR-SHELL-160)", () => {
        const parts = termContextParts({ folder: "/x", projectName: "MoltenTerm", branch: "", marker: worktree });
        expect(parts.map((p) => [p.key, p.text])).toEqual([
            ["project", "MoltenTerm"],
            ["worktree", "agent-a77"],
            ["branch", "worktree-agent-a77"],
        ]);
        expect(parts[1].marker).toBe(worktree);
        expect(parts[1].title).toContain("Worktree agent-a77");
    });

    it("says nothing of the main tree beside its branch, as the sidebar's line did", () => {
        const main = { ...worktree, kind: "main" as const, label: "main tree" };
        const parts = termContextParts({ folder: "/x", projectName: "MoltenTerm", branch: "develop", marker: main });
        expect(parts.map((p) => p.key)).toEqual(["project", "branch"]);
    });
});

// FR-SHELL-160: what the sidebar's branch line showed, with the clicks and the titles it had.
describe("the branch line in a terminal's header (FR-SHELL-160)", () => {
    const main: TreeMarker = {
        kind: "main",
        label: "main tree",
        branch: "develop",
        path: "/repo",
        linked: false,
        outside: false,
        colorClass: "",
        icon: "",
        title: "",
    };
    const input = {
        folder: "/repo",
        projectName: "MoltenTerm",
        projectTitle: "MoltenTerm\n/repo",
        branch: "develop",
        branchTitle: "develop, 2 commits ahead",
        marker: main,
    };

    it("opens the project overview from the branch, which carries its ahead count and its dirty dot", () => {
        const branch = termContextParts({ ...input, ahead: 2, dirty: true }).find((p) => p.key === "branch");
        expect(branch).toMatchObject({ text: "develop", click: "overview", ahead: 2, dirty: true });
        expect(branch.title).toBe("MoltenTerm\ndevelop, 2 commits ahead");
    });

    it("has neither an ahead count nor a dirty dot on a clean branch that is up to date", () => {
        const branch = termContextParts(input).find((p) => p.key === "branch");
        expect(branch).toMatchObject({ ahead: 0, dirty: false });
    });

    it("opens the CI/CD view from the verdict, and titles it with the verdict", () => {
        const ci = { status: "failure", label: "failed", iconClass: "fa-circle-xmark text-error" };
        const part = termContextParts({ ...input, ci }).find((p) => p.key === "ci");
        expect(part).toMatchObject({ click: "ci", ci });
        expect(part.title).toBe("failed on this code\nOpen CI/CD");
    });

    it("opens the pull request from its number, titled as the sidebar titled it", () => {
        const pr = { number: 12, title: "Contexts", url: "https://example.test/pull/12", draft: true };
        const part = termContextParts({ ...input, pr }).find((p) => p.key === "pr");
        expect(part).toMatchObject({ text: "#12", click: "pr", pr });
        expect(part.title).toContain("Contexts");
        const open = termContextParts({ ...input, pr: { ...pr, draft: false } }).find((p) => p.key === "pr");
        expect(open.title).not.toBe(part.title);
    });

    it("shows the project alone when the folder has no repository", () => {
        const parts = termContextParts({ folder: "/notes", projectName: "notes", branch: "", marker: null });
        expect(parts.map((p) => p.key)).toEqual(["project"]);
    });

    it("keeps the project first, then the chip, the branch, the verdict and the pull request", () => {
        const wt = { ...main, kind: "worktree" as const, label: "wt-1" };
        const parts = termContextParts({
            ...input,
            marker: wt,
            ci: { status: "success", label: "passed", iconClass: "fa-circle-check text-success" },
            pr: { number: 3, title: "x", url: "u" },
        });
        expect(parts.map((p) => p.key)).toEqual(["project", "worktree", "branch", "ci", "pr"]);
    });

    it("titles a terminal with its agent, else its own title, else Terminal", () => {
        expect(termHeaderTitle(agent("working"), "Build", "")).toBe("Claude Code");
        expect(termHeaderTitle(null, "Build", "")).toBe("Build");
        expect(termHeaderTitle(null, null, "")).toBe("Terminal");
    });
});
