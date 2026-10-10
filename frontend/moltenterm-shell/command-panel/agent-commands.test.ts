// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: async () => null } }));
vi.mock("@/app/store/global", () => ({
    globalStore: { get: () => 0, set: () => {} },
    getFocusedBlockId: () => null,
    refocusNode: () => {},
}));

import { AgentStateInfo } from "../agent-state-model";
import {
    agentSection,
    agentSuggestions,
    ClaudeCommands,
    CodexCommands,
    feedbackFor,
    hasAgentCommands,
    permissionModeItem,
} from "./agent-commands";
import { panelCapabilities } from "./panel-context";
import { matchingProviders } from "./panel-registry";
import { PanelAction, PanelChoice, PanelContext, PanelFeedback } from "./panel-types";
import { AgentProvider } from "./providers/agent";

const claude: AgentStateInfo = { blockid: "b1", agent: "claude", agentname: "Claude Code", state: "idle", version: 1 };
const codex: AgentStateInfo = { blockid: "b1", agent: "codex", agentname: "Codex", state: "idle", version: 1 };
const handlers = { run: vi.fn(async () => "close" as const), setMode: vi.fn(async () => "close" as const) };

function ctxOf(agent: AgentStateInfo, view = "term"): PanelContext {
    return {
        blockId: "b1",
        view,
        meta: {},
        viewModel: null,
        agent,
        capabilities: panelCapabilities({ view, meta: {}, agent, waveMenu: false }),
        kindLabel: "terminals",
        panelName: "Terminal",
    };
}

describe("agent command tables", () => {
    it("lists Claude Code's commands after its permission mode", () => {
        const section = agentSection(claude, null, handlers);
        expect(section.title).toBe("Agent · Claude Code");
        expect(section.kind).toBe("agent");
        expect(section.items.map((i) => i.label)).toEqual([
            "Permission mode",
            "New conversation",
            "Compact",
            "Model",
            "Resume",
            "Copy last answer",
            "Status",
            "Review",
            "Interrupt",
            "Quit",
        ]);
        expect(section.items.every((i) => !i.disabled)).toBe(true);
        expect((section.items[1] as PanelAction).shortcut).toBe("/clear");
    });

    it("lists Codex's commands, without a permission mode", () => {
        const section = agentSection(codex, null, handlers);
        expect(section.title).toBe("Agent · Codex");
        expect(section.items.map((i) => (i as PanelAction).shortcut)).toEqual(CodexCommands.map((c) => c.command));
        expect(section.items.some((i) => i.id === "agent:permissionmode")).toBe(false);
    });

    it("has no section for an agent without a table", () => {
        expect(agentSection({ ...claude, agent: "gemini" }, null, handlers)).toBeNull();
        expect(hasAgentCommands({ ...claude, agent: "gemini" })).toBe(false);
        expect(hasAgentCommands(null)).toBe(false);
    });

    it("shows the state next to the heading", () => {
        expect(agentSection(claude, null, handlers).state).toBeNull();
        const waiting = agentSection({ ...claude, state: "waiting" }, null, handlers);
        expect(waiting.state).toBe("waiting for you");
        expect(waiting.stateTone).toBe("warning");
        expect(agentSection({ ...claude, state: "working" }, null, handlers).stateTone).toBe("muted");
    });

    it("keeps the Claude Code table's commands unique", () => {
        expect(new Set(ClaudeCommands.map((c) => c.action)).size).toBe(ClaudeCommands.length);
    });
});

describe("agent provider", () => {
    it("matches a terminal running Claude Code or Codex, not a plain shell", () => {
        expect(matchingProviders(ctxOf(claude), [AgentProvider])).toHaveLength(1);
        expect(matchingProviders(ctxOf(codex), [AgentProvider])).toHaveLength(1);
        expect(matchingProviders(ctxOf(null), [AgentProvider])).toHaveLength(0);
        expect(matchingProviders(ctxOf({ ...claude, agent: "gemini" }), [AgentProvider])).toHaveLength(0);
        expect(matchingProviders(ctxOf(claude, "preview"), [AgentProvider])).toHaveLength(0);
    });
});

describe("permission mode", () => {
    it("offers one press while the mode is unseen", () => {
        const item = permissionModeItem(null, handlers);
        expect(item.options.map((o) => o.label)).toEqual(["Next mode"]);
        item.options[0].run();
        expect(handlers.setMode).toHaveBeenCalledWith("");
    });

    it("lists the modes with the current one checked, optional ones once seen", () => {
        const item: PanelChoice = permissionModeItem({ blockid: "b1", mode: "plan", modes: ["plan"] }, handlers);
        expect(item.options.map((o) => o.label)).toEqual(["Default", "Accept edits", "Plan"]);
        expect(item.options.find((o) => o.checked)?.label).toBe("Plan");
        const bypass = permissionModeItem({ blockid: "b1", mode: "default", modes: ["bypassPermissions"] }, handlers);
        expect(bypass.options.map((o) => o.label)).toContain("Bypass permissions");
        bypass.options[2].run();
        expect(handlers.setMode).toHaveBeenCalledWith("plan");
    });
});

describe("suggestions", () => {
    it("shows a waiting agent's question with Go", () => {
        const [s] = agentSuggestions({ ...claude, state: "waiting", message: "Allow Bash(rm -rf build)?" });
        expect(s.label).toBe("Allow Bash(rm -rf build)?");
        expect(s.action).toBe("Go");
        expect(agentSuggestions({ ...claude, state: "waiting" })[0].label).toBe(
            "Claude Code is waiting for your answer"
        );
        expect(agentSuggestions(claude)).toEqual([]);
    });
});

describe("feedback", () => {
    const fb = { interrupt: vi.fn(async () => "close" as const), confirmDraft: vi.fn(async () => "close" as const) };

    it("closes once a command is sent", () => {
        expect(feedbackFor({ result: "sent", message: "Sent" }, "clear", fb)).toBe("close");
        expect(
            feedbackFor({ result: "sent", message: "x", mode: "plan" }, "permissionmode", fb, { mode: "plan" })
        ).toBe("close");
        const unseen = feedbackFor({ result: "sent", message: "Pressed" }, "permissionmode", fb, { mode: "" });
        expect((unseen as PanelFeedback).message).toBe("Pressed");
    });

    it("offers Interrupt while working and Go while waiting", () => {
        const working = feedbackFor(
            { result: "refused", reason: "working", message: "w" },
            "compact",
            fb
        ) as PanelFeedback;
        expect(working.actions.map((a) => a.label)).toEqual(["Interrupt"]);
        working.actions[0].run();
        expect(fb.interrupt).toHaveBeenCalled();
        const waiting = feedbackFor(
            { result: "refused", reason: "waiting", message: "q" },
            "status",
            fb
        ) as PanelFeedback;
        expect(waiting.actions.map((a) => a.label)).toEqual(["Go to the question"]);
        expect(waiting.actions[0].run()).toBe("close");
    });

    it("asks before a draft is cleared, and Cancel types nothing", () => {
        const draft = feedbackFor({ result: "refused", reason: "draft", message: "d" }, "clear", fb) as PanelFeedback;
        expect(draft.role).toBe("alertdialog");
        expect(draft.actions.map((a) => a.label)).toEqual(["Cancel", "Clear and send"]);
        expect(draft.actions[0].run()).toBe("dismiss");
        expect(fb.confirmDraft).not.toHaveBeenCalled();
        draft.actions[1].run();
        expect(fb.confirmDraft).toHaveBeenCalled();
    });

    it("says why nothing was typed", () => {
        const vim = feedbackFor(
            { result: "refused", reason: "notforeground", message: "vim is in the foreground" },
            "clear",
            fb
        ) as PanelFeedback;
        expect(vim.tone).toBe("danger");
        expect(vim.message).toContain("vim");
        expect((feedbackFor(null, "clear", fb) as PanelFeedback).message).toContain("could not reach");
    });
});
