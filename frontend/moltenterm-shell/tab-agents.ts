// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The agent a top tab names after its own name (FR-SHELL-056, #1033): the one whose run started first, "+N" for the
// others; the tooltip lists them all. Read from the agent states the window already holds (agent-state-store.ts).

import { AgentStateInfo, agentCallName, agentLabel } from "./agent-state-model";
import { TFunction } from "./i18n/i18n";

export type TabAgentName = {
    name: string;
    // How many other agents the tab holds.
    more: number;
};

// A run without a known start (an older wavesrv) counts from its current state.
function runStart(info: AgentStateInfo): number {
    return info.started || info.since || Number.MAX_SAFE_INTEGER;
}

// Longest-running first; ties by first name, then by panel, so the choice never flips between renders.
export function tabAgentsByRun(infos: AgentStateInfo[]): AgentStateInfo[] {
    return (infos ?? [])
        .filter((info) => info != null)
        .slice()
        .sort(
            (a, b) =>
                runStart(a) - runStart(b) ||
                agentCallName(a).localeCompare(agentCallName(b)) ||
                a.blockid.localeCompare(b.blockid)
        );
}

export function tabAgentName(sorted: AgentStateInfo[]): TabAgentName {
    if (sorted == null || sorted.length === 0) {
        return null;
    }
    return { name: agentCallName(sorted[0]), more: sorted.length - 1 };
}

export function tabAgentRunTime(t: TFunction, ms: number): string {
    const minutes = Math.floor(Math.max(0, ms) / 60000);
    if (minutes < 1) {
        return t("tabs.agent.underMinute");
    }
    if (minutes < 60) {
        return t("tabs.agent.minutes", { minutes });
    }
    return t("tabs.agent.hours", { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, "0") });
}

const StateNames = ["working", "waiting", "done", "error", "idle"];

function stateLabel(t: TFunction, state: string): string {
    return StateNames.includes(state) ? t(`agent.state.${state}`) : (state ?? "");
}

// One line per agent: "Valentin · Claude Code: working, for 12 min".
export function tabAgentsTitle(t: TFunction, sorted: AgentStateInfo[], now: number): string {
    return (sorted ?? [])
        .map((info) => {
            const start = info.started || info.since;
            const line = t("tabs.agent.line", { agent: agentLabel(info), state: stateLabel(t, info.state) });
            if (!start) {
                return line;
            }
            return t("tabs.agent.lineFor", { line, duration: tabAgentRunTime(t, now - start) });
        })
        .join("\n");
}
