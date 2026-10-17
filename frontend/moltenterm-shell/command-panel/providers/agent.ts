// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Agent section (FR-SHELL-048, DS-SHELL-088): first in a terminal running Claude Code or Codex, absent in a plain
// shell, and in a panel that drives such an agent in another terminal (the Review AI panel, #916). Every command goes through wavesrv's moltenagentinput, which types it only into the verified foreground
// agent; the panel shows its refusals and asks before an unsent draft is cleared.

import {
    agentSection,
    agentSuggestions,
    EffortAction,
    feedbackFor,
    hasAgentCommands,
    InterruptAction,
    ModelAction,
    PermissionModeAction,
} from "../agent-commands";
import { AgentInputs } from "../agent-input-store";
import { CommandProvider, PanelActionResult, PanelContext, PanelSection } from "../panel-types";

// The terminal the commands are typed into: the panel itself, or the one it drives (the Review AI panel's session, #916).
function agentBlockId(ctx: PanelContext): string {
    return ctx.agentBlockId || ctx.blockId;
}

async function runAgentCommand(
    ctx: PanelContext,
    action: string,
    opts: { mode?: string; effort?: string; model?: string; confirmedDraft?: boolean } = {}
): Promise<PanelActionResult> {
    const result = await AgentInputs.getInstance().send({
        blockid: agentBlockId(ctx),
        agent: ctx.agent?.agent,
        action,
        mode: opts.mode || undefined,
        effort: opts.effort || undefined,
        model: opts.model || undefined,
        confirmeddraft: opts.confirmedDraft || undefined,
    });
    return feedbackFor(
        result,
        action,
        {
            interrupt: () => runAgentCommand(ctx, InterruptAction),
            confirmDraft: () => runAgentCommand(ctx, action, { ...opts, confirmedDraft: true }),
            openModel: () => runAgentCommand(ctx, ModelAction),
            gotoAgent: ctx.revealAgent,
        },
        { mode: opts.mode }
    );
}

export function agentProviderSections(ctx: PanelContext): PanelSection[] {
    const info = AgentInputs.getInstance().info(agentBlockId(ctx));
    const section = agentSection(ctx.agent, info, {
        run: (action) => runAgentCommand(ctx, action),
        setMode: (mode) => runAgentCommand(ctx, PermissionModeAction, { mode }),
        setEffort: (effort) => runAgentCommand(ctx, EffortAction, { effort }),
        setModel: (model) => runAgentCommand(ctx, ModelAction, { model }),
    });
    return section ? [section] : [];
}

export const AgentProvider: CommandProvider = {
    id: "agent",
    kind: "agent",
    needs: ["agent-input", "agent:*"],
    when: (ctx) => hasAgentCommands(ctx.agent),
    sections: agentProviderSections,
    suggestions: (ctx) => agentSuggestions(ctx.agent, ctx.revealAgent),
};
