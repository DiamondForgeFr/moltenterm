// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Agent section (FR-SHELL-048, DS-SHELL-088): first in a terminal running Claude Code or Codex, absent in a plain
// shell. Every command goes through wavesrv's moltenagentinput, which types it only into the verified foreground
// agent; the panel shows its refusals and asks before an unsent draft is cleared.

import {
    agentSection,
    agentSuggestions,
    feedbackFor,
    hasAgentCommands,
    InterruptAction,
    PermissionModeAction,
} from "../agent-commands";
import { AgentInputs } from "../agent-input-store";
import { CommandProvider, PanelActionResult, PanelContext, PanelSection } from "../panel-types";

async function runAgentCommand(
    ctx: PanelContext,
    action: string,
    opts: { mode?: string; confirmedDraft?: boolean } = {}
): Promise<PanelActionResult> {
    const result = await AgentInputs.getInstance().send({
        blockid: ctx.blockId,
        agent: ctx.agent?.agent,
        action,
        mode: opts.mode || undefined,
        confirmeddraft: opts.confirmedDraft || undefined,
    });
    return feedbackFor(
        result,
        action,
        {
            interrupt: () => runAgentCommand(ctx, InterruptAction),
            confirmDraft: () => runAgentCommand(ctx, action, { ...opts, confirmedDraft: true }),
        },
        { mode: opts.mode }
    );
}

export function agentProviderSections(ctx: PanelContext): PanelSection[] {
    const info = AgentInputs.getInstance().info(ctx.blockId);
    const section = agentSection(ctx.agent, info, {
        run: (action) => runAgentCommand(ctx, action),
        setMode: (mode) => runAgentCommand(ctx, PermissionModeAction, { mode }),
    });
    return section ? [section] : [];
}

export const AgentProvider: CommandProvider = {
    id: "agent",
    kind: "agent",
    needs: ["terminal", "agent:*"],
    when: (ctx) => hasAgentCommands(ctx.agent),
    sections: agentProviderSections,
    suggestions: (ctx) => agentSuggestions(ctx.agent),
};
