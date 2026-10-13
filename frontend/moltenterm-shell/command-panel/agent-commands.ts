// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Agent section of the command panel (FR-SHELL-048, DS-SHELL-088): the commands of the coding agent running in a
// terminal, typed by wavesrv's guarded moltenagentinput (pkg/molten/termupdate/agentinput.go), and what the panel
// says when a command is refused. wavesrv holds the authoritative tables and checks every action against them; this
// copy gives the labels and the order. Nothing is greyed out: a refusal explains itself.

import { AgentStateInfo, agentStateLabel } from "../agent-state-model";
import {
    PanelActionResult,
    PanelChoice,
    PanelChoiceOption,
    PanelItem,
    PanelSection,
    PanelSuggestion,
} from "./panel-types";

// must match pkg/molten/termupdate/agentinput.go
export const AgentInputRoute = "molten:termupdate";
export const AgentInputCommand = "moltenagentinput";
export const AgentInputInfoCommand = "moltenagentinputinfo";

export type AgentInputRequest = {
    blockid: string;
    agent: string;
    action: string;
    mode?: string;
    confirmeddraft?: boolean;
    effort?: string;
    model?: string;
};

export type AgentInputReason =
    | "working"
    | "waiting"
    | "notforeground"
    | "draft"
    | "unknownaction"
    | "noagent"
    | "busy"
    | "unavailable"
    | "effortunknown";

export type AgentInputResult = {
    result: "sent" | "refused";
    reason?: AgentInputReason;
    offer?: "interrupt" | "goto";
    message: string;
    agent?: string;
    agentname?: string;
    program?: string;
    mode?: string;
    presses?: number;
    effort?: string;
};

export type AgentInputInfo = {
    blockid: string;
    agent?: string;
    mode?: string;
    modes?: string[];
    draft?: boolean;
    // The run's effort level and the levels MoltenTerm can set (#549); no levels: the agent's own picker only.
    effort?: string;
    efforts?: string[];
    // The models the agent's model command takes inline (#573); none: the agent's own picker only.
    models?: AgentModelOption[];
};

export type AgentModelOption = {
    id: string;
    label: string;
};

// must match pkg/molten/agentcontinuity/commands.go
export const PermissionModeAction = "permissionmode";
export const InterruptAction = "interrupt";
export const EffortAction = "effort";
export const ModelAction = "model";

export type AgentCommandDef = {
    action: string;
    label: string;
    icon: string;
    // What is typed, shown in mono on the right.
    command: string;
    keywords?: string[];
};

const Interrupt: AgentCommandDef = {
    action: InterruptAction,
    label: "Interrupt",
    icon: "hand",
    command: "Esc",
    keywords: ["stop", "cancel", "escape"],
};

export const ClaudeCommands: AgentCommandDef[] = [
    { action: "clear", label: "New conversation", icon: "plus", command: "/clear", keywords: ["clear", "reset"] },
    { action: "compact", label: "Compact", icon: "compress", command: "/compact", keywords: ["summarize", "context"] },
    { action: "model", label: "Model", icon: "microchip", command: "/model" },
    { action: "resume", label: "Resume", icon: "clock-rotate-left", command: "/resume", keywords: ["session"] },
    { action: "copy", label: "Copy last answer", icon: "copy", command: "/copy", keywords: ["response"] },
    { action: "status", label: "Status", icon: "circle-info", command: "/status" },
    { action: "review", label: "Review", icon: "code-pull-request", command: "/review", keywords: ["pull request"] },
    Interrupt,
    { action: "quit", label: "Quit", icon: "right-from-bracket", command: "/exit", keywords: ["exit"] },
];

export const CodexCommands: AgentCommandDef[] = [
    {
        action: "approvals",
        label: "Approvals",
        icon: "shield-halved",
        command: "/approvals",
        keywords: ["permissions", "sandbox"],
    },
    { action: "new", label: "New conversation", icon: "plus", command: "/new", keywords: ["clear", "reset"] },
    { action: "compact", label: "Compact", icon: "compress", command: "/compact", keywords: ["summarize", "context"] },
    { action: "model", label: "Model", icon: "microchip", command: "/model" },
    { action: "status", label: "Status", icon: "circle-info", command: "/status" },
    { action: "diff", label: "Diff", icon: "code-compare", command: "/diff", keywords: ["changes"] },
    Interrupt,
    { action: "quit", label: "Quit", icon: "right-from-bracket", command: "/exit", keywords: ["exit"] },
];

// How an agent takes an effort level (#549), told in the submenu: Claude Code keeps what /effort sets as its default
// for new sessions (max excepted); Codex's effort keys change this session only.
export type EffortStyle = "claude" | "codex";

const Tables: Record<string, { commands: AgentCommandDef[]; modes: boolean; effort?: EffortStyle }> = {
    claude: { commands: ClaudeCommands, modes: true, effort: "claude" },
    codex: { commands: CodexCommands, modes: false, effort: "codex" },
};

export function agentCommandTable(agent: string): AgentCommandDef[] {
    return Tables[agent]?.commands ?? null;
}

export function hasAgentCommands(agent: AgentStateInfo): boolean {
    return agent?.agent != null && Tables[agent.agent] != null;
}

// Claude Code's permission modes in its Shift+Tab order; the last two show only once the agent drew them (they
// depend on how it was started).
export const PermissionModes: { id: string; label: string; optional?: boolean }[] = [
    { id: "default", label: "Default" },
    { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan" },
    { id: "auto", label: "Auto", optional: true },
    { id: "bypassPermissions", label: "Bypass permissions", optional: true },
];

export function permissionModeLabel(mode: string): string {
    return PermissionModes.find((m) => m.id === mode)?.label ?? mode ?? "";
}

export function agentName(agent: AgentStateInfo): string {
    return agent?.agentname || agent?.agent || "Agent";
}

// What the section's commands do; the provider binds them to wavesrv.
export type AgentCommandHandlers = {
    run: (action: string) => Promise<PanelActionResult>;
    setMode: (mode: string) => Promise<PanelActionResult>;
    setEffort?: (effort: string) => Promise<PanelActionResult>;
    setModel?: (model: string) => Promise<PanelActionResult>;
};

export const ModelItemId = "agent:model";
export const EffortItemId = "agent:effort";

// The Model choice (#573), built like Effort: the model the agent reported, checked, then the models its model
// command takes inline (Claude Code's `/model <alias>`, which Claude Code keeps as the default for new sessions),
// then the agent's own picker, the only way for Codex, whose /model takes no argument.
export function modelItem(
    agent: AgentStateInfo,
    info: AgentInputInfo,
    def: AgentCommandDef,
    handlers: AgentCommandHandlers
): PanelChoice {
    const options: PanelChoiceOption[] = [];
    const current = (agent?.model || "").trim();
    const currentLabel = (agent?.modelname || agent?.model || "").trim();
    if (currentLabel) {
        options.push({
            id: "model:current",
            label: currentLabel,
            detail: current && current !== currentLabel ? current : undefined,
            checked: true,
            disabled: true,
        });
    }
    const models = info?.models ?? [];
    for (const m of models) {
        options.push({
            id: `model:${m.id}`,
            label: m.label,
            detail: "Saved as your default",
            checked: false,
            run: () => handlers.setModel?.(m.id),
        });
    }
    options.push({
        id: "model:picker",
        label: `Choose in ${agentName(agent)}`,
        detail: def.command,
        checked: false,
        run: () => handlers.run(ModelAction),
    });
    return {
        id: ModelItemId,
        type: "choice",
        label: def.label,
        icon: def.icon,
        keywords: [def.command, "model", ...models.map((m) => m.id)],
        awaitResult: true,
        options,
    };
}

function effortDetail(style: EffortStyle, level: string): string {
    if (style === "codex" || level === "max") {
        return "This session";
    }
    return "Saved as your default";
}

// The Effort entry below Model (#549): the level the agent reported on the right, its levels in the submenu. Codex
// without a known level (before its first turn, or with its effort keys moved) offers its own picker instead.
export function effortItem(
    agent: AgentStateInfo,
    info: AgentInputInfo,
    style: EffortStyle,
    handlers: AgentCommandHandlers
): PanelChoice {
    const current = agent?.effort || info?.effort || "";
    const levels = info?.efforts ?? [];
    let options: PanelChoiceOption[] = levels.map((level) => ({
        id: `effort:${level}`,
        label: level,
        detail: effortDetail(style, level),
        checked: level === current,
        run: () => handlers.setEffort?.(level),
    }));
    if (options.length === 0) {
        options = [
            {
                id: "effort:model",
                label: style === "codex" ? `Choose in ${agentName(agent)}` : "Choose a level",
                detail: "/model",
                checked: false,
                run: () => handlers.run(ModelAction),
            },
        ];
        if (current) {
            options.unshift({ id: `effort:${current}`, label: current, checked: true, disabled: true });
        }
    }
    return {
        id: EffortItemId,
        type: "choice",
        label: "Effort",
        icon: "gauge-high",
        keywords: ["effort", "reasoning", "thinking", "/effort", ...levels],
        awaitResult: true,
        options,
    };
}

export function permissionModeItem(info: AgentInputInfo, handlers: AgentCommandHandlers): PanelChoice {
    const current = info?.mode ?? "";
    const seen = new Set(info?.modes ?? []);
    let options: PanelChoiceOption[];
    if (current === "") {
        // The mode was never drawn in this run: each press moves to the next mode (FR-SHELL-048-AC3).
        options = [
            {
                id: "mode:next",
                label: "Next mode",
                detail: "Shift+Tab",
                checked: false,
                run: () => handlers.setMode(""),
            },
        ];
    } else {
        options = PermissionModes.filter((m) => !m.optional || seen.has(m.id) || m.id === current).map((m) => ({
            id: `mode:${m.id}`,
            label: m.label,
            checked: m.id === current,
            run: () => handlers.setMode(m.id),
        }));
    }
    return {
        id: "agent:permissionmode",
        type: "choice",
        label: "Permission mode",
        icon: "shield-halved",
        keywords: ["plan", "accept edits", "shift+tab", "auto"],
        awaitResult: true,
        options,
    };
}

export function agentSection(
    agent: AgentStateInfo,
    info: AgentInputInfo,
    handlers: AgentCommandHandlers
): PanelSection {
    const table = Tables[agent?.agent];
    if (table == null) {
        return null;
    }
    const items: PanelItem[] = [];
    if (table.modes) {
        items.push(permissionModeItem(info, handlers));
    }
    for (const def of table.commands) {
        if (def.action === ModelAction) {
            items.push(modelItem(agent, info, def, handlers));
            if (table.effort != null) {
                items.push(effortItem(agent, info, table.effort, handlers));
            }
            continue;
        }
        items.push({
            id: `agent:${def.action}`,
            type: "action",
            label: def.label,
            icon: def.icon,
            shortcut: def.command,
            keywords: [def.command, ...(def.keywords ?? [])],
            awaitResult: true,
            run: () => handlers.run(def.action),
        });
    }
    const state = agent.state && agent.state !== "idle" ? agentStateLabel(agent.state) : null;
    return {
        id: "agent",
        kind: "agent",
        title: `Agent · ${agentName(agent)}`,
        state,
        stateTone: agent.state === "waiting" || agent.state === "error" ? "warning" : "muted",
        items,
    };
}

// A waiting agent's question, with Go, which closes the panel and focuses the terminal (FR-SHELL-048-AC8).
export function agentSuggestions(agent: AgentStateInfo): PanelSuggestion[] {
    if (!hasAgentCommands(agent) || agent.state !== "waiting") {
        return [];
    }
    const question = (agent.message ?? "").trim() || `${agentName(agent)} is waiting for your answer`;
    return [
        {
            id: "agent:question",
            label: question,
            icon: "circle-question",
            tone: "warning",
            action: "Go",
            run: () => {},
        },
    ];
}

export type FeedbackHandlers = {
    interrupt: () => Promise<PanelActionResult>;
    confirmDraft: () => Promise<PanelActionResult>;
    openModel?: () => Promise<PanelActionResult>;
};

// What the panel does with wavesrv's answer: close on a command sent, or say why nothing was typed and offer what
// fits (FR-SHELL-048-AC4, AC5, AC6).
export function feedbackFor(
    result: AgentInputResult,
    action: string,
    handlers: FeedbackHandlers,
    opts?: { mode?: string }
): PanelActionResult {
    if (result == null) {
        return {
            id: "agent:error",
            tone: "danger",
            role: "alert",
            message: "MoltenTerm could not reach the terminal.",
        };
    }
    if (result.result === "sent") {
        if (action === EffortAction && result.presses > 0) {
            // Codex's effort keys: the header shows the level from the agent's next turn, and says nothing until then.
            return { id: "agent:effort", tone: "muted", role: "alert", message: result.message };
        }
        if (action !== PermissionModeAction) {
            return "close";
        }
        if (opts?.mode && result.mode === opts.mode) {
            return "close";
        }
        // One press with the mode unseen, or a target not reached: the panel stays on the modes with the outcome.
        return { id: "agent:mode", tone: "muted", role: "alert", message: result.message };
    }
    switch (result.reason) {
        case "working":
            return {
                id: "agent:working",
                tone: "warning",
                role: "alert",
                message: result.message,
                actions: [{ id: "interrupt", label: "Interrupt", primary: true, run: handlers.interrupt }],
            };
        case "waiting":
            return {
                id: "agent:waiting",
                tone: "warning",
                role: "alert",
                message: result.message,
                actions: [{ id: "goto", label: "Go to the question", primary: true, run: () => "close" }],
            };
        case "draft":
            return {
                id: "agent:draft",
                tone: "warning",
                role: "alertdialog",
                message: result.message,
                actions: [
                    { id: "cancel", label: "Cancel", run: () => "dismiss" },
                    { id: "confirm", label: "Clear and send", primary: true, run: handlers.confirmDraft },
                ],
            };
        case "effortunknown":
            return {
                id: "agent:effortunknown",
                tone: "warning",
                role: "alert",
                message: result.message,
                actions: handlers.openModel
                    ? [{ id: "model", label: "Open /model", primary: true, run: handlers.openModel }]
                    : undefined,
            };
        default:
            return {
                id: `agent:${result.reason ?? "refused"}`,
                tone: "danger",
                role: "alert",
                message: result.message,
            };
    }
}
