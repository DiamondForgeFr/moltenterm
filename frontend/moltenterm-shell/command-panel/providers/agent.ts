// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Agent section (FR-SHELL-048, DS-SHELL-088): first in a terminal running Claude Code or Codex, absent in a plain
// shell, and in a panel that drives such an agent in another terminal (the Review AI panel, #916). Every command goes through wavesrv's moltenagentinput, which types it only into the verified foreground
// agent; the panel shows its refusals and asks before an unsent draft is cleared.

import { ActionGate, actionGate, AgentAction, gateMessage } from "../../agent-info/agent-action-gate";
import { currentFeatureMatrix, type FeatureMatrix } from "../../agent-info/agent-features-model";
import { agentLabel, AgentStateInfo } from "../../agent-state-model";
import { t } from "../../i18n/i18n";
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
import { CommandProvider, PanelActionResult, PanelContext, PanelItem, PanelSection } from "../panel-types";

// What a terminal's Agent section offers for an agent MoltenTerm has no command table for (FR-AGC-005): the actions
// its matrix row says do not work, each saying why when chosen and what to do instead, so the section is never just
// missing while the developer looks for Effort or Resume.
type GatedAction = { action: AgentAction; labelKey: string; icon: string };

const GatedActions: GatedAction[] = [
    { action: "commands", labelKey: "agc.gate.commands.label", icon: "terminal" },
    { action: "effort", labelKey: "cmdpanel.agent.effort", icon: "gauge-high" },
    { action: "resume", labelKey: "cmdpanel.agent.resume", icon: "clock-rotate-left" },
];

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

function gatedItem(gate: ActionGate, agent: AgentStateInfo, def: GatedAction, ctx: PanelContext): PanelItem {
    const id = `agent:gated:${def.action}`;
    const reveal = ctx.revealAgent;
    return {
        id,
        type: "action",
        label: t(def.labelKey),
        icon: def.icon,
        detail: t("agc.gate.notHere"),
        keywords: [def.action, "unavailable"],
        awaitResult: true,
        run: (): PanelActionResult => ({
            id,
            tone: "muted",
            role: "alert",
            message: gateMessage(gate, agent.agentname),
            actions:
                reveal != null
                    ? [
                          {
                              id: "agent:gated:goto",
                              label: t("agc.gate.showTerminal"),
                              primary: true,
                              run: () => {
                                  reveal();
                                  return "away";
                              },
                          },
                      ]
                    : undefined,
        }),
    };
}

export function unavailableAgentSection(
    ctx: PanelContext,
    matrix: FeatureMatrix = currentFeatureMatrix()
): PanelSection {
    const agent = ctx.agent;
    if (agent?.agent == null || hasAgentCommands(agent)) {
        return null;
    }
    const items: PanelItem[] = [];
    for (const def of GatedActions) {
        const gate = actionGate(matrix, agent.agent, def.action);
        if (!gate.works) {
            items.push(gatedItem(gate, agent, def, ctx));
        }
    }
    if (items.length === 0) {
        return null;
    }
    return { id: "agent", kind: "agent", title: t("cmdpanel.agent.sectionTitle", { agent: agentLabel(agent) }), items };
}

export function agentProviderSections(ctx: PanelContext): PanelSection[] {
    if (!hasAgentCommands(ctx.agent)) {
        const gated = unavailableAgentSection(ctx);
        return gated ? [gated] : [];
    }
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
    when: (ctx) => hasAgentCommands(ctx.agent) || unavailableAgentSection(ctx) != null,
    sections: agentProviderSections,
    suggestions: (ctx) => agentSuggestions(ctx.agent, ctx.revealAgent),
};
