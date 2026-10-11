// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AgentStateInfo, AgentStateName } from "./agent-state-model";
import {
    busyCloseText,
    MaxRunningRows,
    runningInTerminal,
    RunningItem,
    runningOf,
    runningPlace,
    RunningSource,
    runningStateText,
    sortRunning,
    visibleRunning,
} from "./busy-close-model";

function term(extra: Partial<RunningSource> = {}): RunningSource {
    return { blockId: "b1", view: "term", procStatus: "running", workspace: "Work", tab: "api", ...extra };
}

function agent(state: AgentStateName, extra: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return { blockid: "b1", agent: "claude", agentname: "Claude Code", state, version: 1, ...extra };
}

describe("what counts as running (DS-SHELL-106)", () => {
    it("names the command the shell integration reports", () => {
        const item = runningInTerminal(
            term({ integration: true, shellState: "running-command", lastCmd: "npm run dev" })
        );
        expect(item).toEqual({ blockId: "b1", kind: "command", label: "npm run dev", workspace: "Work", tab: "api" });
        expect(runningInTerminal(term({ integration: true, shellState: "running-command" })).label).toBe("a command");
    });

    it("never asks for a shell at its prompt, even with a stale agent state", () => {
        expect(runningInTerminal(term({ integration: true, shellState: "ready" }))).toBeNull();
        expect(runningInTerminal(term({ integration: true, shellState: "ready", agent: agent("idle") }))).toBeNull();
    });

    it("never asks without any signal: no shell integration and no agent state", () => {
        expect(runningInTerminal(term())).toBeNull();
        expect(
            runningInTerminal(term({ integration: false, shellState: "running-command", lastCmd: "cat" }))
        ).toBeNull();
    });

    it("never asks once the process has ended or before it started", () => {
        const busy = { integration: true, shellState: "running-command", lastCmd: "exit", agent: agent("working") };
        expect(runningInTerminal(term({ ...busy, procStatus: "done" }))).toBeNull();
        expect(runningInTerminal(term({ ...busy, procStatus: "init" }))).toBeNull();
        expect(runningInTerminal(term({ ...busy, procStatus: null }))).not.toBeNull();
    });

    it("counts an agent even idle, and prefers it to its command line", () => {
        const item = runningInTerminal(
            term({ integration: true, shellState: "running-command", lastCmd: "claude", agent: agent("idle") })
        );
        expect(item).toMatchObject({ kind: "agent", label: "Claude Code", state: "idle" });
        expect(runningInTerminal(term({ agent: agent("working") }))).toMatchObject({ kind: "agent", state: "working" });
        expect(runningInTerminal(term({ agent: agent("done", { agentname: "", agent: "codex" }) })).label).toBe(
            "codex"
        );
    });

    it("lets an error state count only while a command still runs", () => {
        expect(runningInTerminal(term({ agent: agent("error") }))).toBeNull();
        const running = term({
            integration: true,
            shellState: "running-command",
            lastCmd: "claude",
            agent: agent("error"),
        });
        expect(runningInTerminal(running)).toMatchObject({ kind: "agent", state: "error" });
    });

    it("counts a block running its own command, named by it", () => {
        expect(runningInTerminal(term({ controller: "cmd", cmd: "npm test" }))).toMatchObject({
            kind: "command",
            label: "npm test",
        });
        expect(runningInTerminal(term({ controller: "cmd", cmd: "npm test", procStatus: "done" }))).toBeNull();
    });

    it("ignores everything that is not a terminal", () => {
        expect(runningInTerminal(term({ view: "preview", agent: agent("working") }))).toBeNull();
        expect(runningInTerminal(null)).toBeNull();
    });
});

describe("order and rows (DS-SHELL-108)", () => {
    const cmd = (id: string): RunningItem => ({ blockId: id, kind: "command", label: id });
    const ag = (id: string, state: AgentStateName): RunningItem => ({ blockId: id, kind: "agent", label: id, state });

    it("puts agents first, the working ones first, then commands in tab order", () => {
        const sorted = sortRunning([
            cmd("c1"),
            ag("idle", "idle"),
            cmd("c2"),
            ag("wait", "waiting"),
            ag("work", "working"),
        ]);
        expect(sorted.map((i) => i.blockId)).toEqual(["work", "wait", "idle", "c1", "c2"]);
    });

    it("keeps one row per terminal that runs something", () => {
        const items = runningOf([
            term({ blockId: "a", integration: true, shellState: "ready" }),
            term({ blockId: "b", integration: true, shellState: "running-command", lastCmd: "cat" }),
            term({ blockId: "c", agent: agent("working", { blockid: "c" }) }),
        ]);
        expect(items.map((i) => i.blockId)).toEqual(["c", "b"]);
    });

    it("shows at most eight rows and counts the others", () => {
        const many = Array.from({ length: 11 }, (_, i) => cmd(`c${i}`));
        const { shown, more } = visibleRunning(many);
        expect(shown).toHaveLength(MaxRunningRows);
        expect(more).toBe(3);
        expect(visibleRunning(many.slice(0, 8)).more).toBe(0);
    });

    it("says each state in words and where it runs", () => {
        expect(runningStateText(ag("a", "waiting"))).toBe("waiting for you");
        expect(runningStateText(cmd("c"))).toBe("running");
        expect(runningPlace({ ...cmd("c"), workspace: "Work", tab: "api" })).toBe("Work · api");
        expect(runningPlace(cmd("c"))).toBe("");
    });

    it("titles the dialog after the action", () => {
        expect(busyCloseText("pane")).toEqual({
            title: "Close this terminal?",
            subtitle: "Closing it stops what runs in it.",
            confirm: "Close anyway",
        });
        expect(busyCloseText("tab", "api").title).toBe("Close the tab “api”?");
        expect(busyCloseText("tab").title).toBe("Close this tab?");
        expect(busyCloseText("replace").confirm).toBe("Replace anyway");
    });
});
