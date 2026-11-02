// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What each running agent got at launch (#947, FR-BRW-011, FR-SHELL-040): MoltenTerm's integration and its browser
// server, from the launcher's report or, once MoltenTerm restarted, from the agent's arguments
// (pkg/molten/attention/agentintegration.go). The share menu tells a lost browser connection from a session started
// without it; the settings list which running sessions have the integration.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { agentLabel, AgentStatesRoute, type AgentStateInfo } from "./agent-state-model";
import { t } from "./i18n/i18n";
import type { ServerText } from "./i18n/server-text";

export const AgentIntegrationRunsCommand = "moltenagentintegrationruns";
const RunsTimeoutMs = 5000;

// Must match pkg/molten/agentintegration.go.
export type AgentIntegrationRun = {
    blockid: string;
    agent: string;
    integration: "on" | "off" | "unknown";
    browser: "added" | "skipped" | "none" | "unknown";
    browserreason?: string;
    browserreasontext?: ServerText;
};

export async function loadIntegrationRuns(): Promise<AgentIntegrationRun[]> {
    const res: { runs: AgentIntegrationRun[] } = await TabRpcClient.wshRpcCall(
        AgentIntegrationRunsCommand,
        {},
        { route: AgentStatesRoute, timeout: RunsTimeoutMs }
    );
    return res?.runs ?? [];
}

export type IntegrationRunRow = { blockId: string; label: string; integration: AgentIntegrationRun["integration"] };

// The settings' list of running sessions: each named as the panes name it, with or without the integration.
export function integrationRunRows(
    runs: AgentIntegrationRun[],
    states: Record<string, AgentStateInfo>
): IntegrationRunRow[] {
    return (runs ?? [])
        .map((run) => {
            const info = states?.[run.blockid];
            return {
                blockId: run.blockid,
                label: info != null ? agentLabel(info) : run.agent,
                integration: run.integration,
            };
        })
        .sort((a, b) => a.label.localeCompare(b.label) || a.blockId.localeCompare(b.blockId));
}

export function integrationRunText(integration: AgentIntegrationRun["integration"]): string {
    switch (integration) {
        case "on":
            return t("settings.integrationRuns.on");
        case "off":
            return t("settings.integrationRuns.off");
    }
    return t("settings.integrationRuns.unknown");
}

export function runsByBlock(runs: AgentIntegrationRun[]): Map<string, AgentIntegrationRun> {
    const rtn = new Map<string, AgentIntegrationRun>();
    for (const run of runs ?? []) {
        if (run?.blockid) {
            rtn.set(run.blockid, run);
        }
    }
    return rtn;
}
