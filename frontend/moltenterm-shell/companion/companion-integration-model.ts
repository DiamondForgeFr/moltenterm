// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the companion tells of MoltenTerm's integration of a run (FR-SHELL-040, DS-SHELL-051, DS-SHELL-052): what the
// launcher added and left alone, and the settings that turn it off (agent:integrate, agent:integrateoff), read at
// the agent's next launch.

import { t } from "../i18n/i18n";
import { CompanionIntegration } from "./companion-model";

export const IntegrateKey = "agent:integrate";
export const IntegrateOffKey = "agent:integrateoff";
export const IntegrationsGuide = "agent-integrations.md";

// Where the settings leave an agent: on, off for this agent only, or off for every agent.
export type IntegrationSetting = "on" | "agentoff" | "alloff";

export function integrationSetting(settings: Record<string, unknown>, agent: string): IntegrationSetting {
    if (settings?.[IntegrateKey] === false) {
        return "alloff";
    }
    const off = settings?.[IntegrateOffKey];
    if (Array.isArray(off) && off.includes(agent)) {
        return "agentoff";
    }
    return "on";
}

// The settings to write to turn the integration off for the agent, for every agent, or back on for the agent.
export function turnOffForAgent(settings: Record<string, unknown>, agent: string): Record<string, unknown> {
    const off = Array.isArray(settings?.[IntegrateOffKey]) ? (settings[IntegrateOffKey] as string[]) : [];
    return { [IntegrateOffKey]: off.includes(agent) ? off : [...off, agent] };
}

export function turnOffForEveryAgent(): Record<string, unknown> {
    return { [IntegrateKey]: false };
}

// Back on for the agent: its id leaves the list (null clears an empty list) and the global switch is cleared.
export function turnOnForAgent(settings: Record<string, unknown>, agent: string): Record<string, unknown> {
    const off = Array.isArray(settings?.[IntegrateOffKey]) ? (settings[IntegrateOffKey] as string[]) : [];
    const rest = off.filter((id) => id !== agent);
    return { [IntegrateKey]: null, [IntegrateOffKey]: rest.length > 0 ? rest : null };
}

// What a setting means for this session and the next ones, in words.
export function integrationSettingText(setting: IntegrationSetting, agentName: string): string {
    switch (setting) {
        case "alloff":
            return t("companion.integration.allOff");
        case "agentoff":
            return t("companion.integration.agentOff", { name: agentName });
        default:
            return null;
    }
}

// How the additions reach the agent, for the details' footer: the per-run files and arguments, never the user's.
export function integrationVia(integration: CompanionIntegration): string[] {
    const rtn: string[] = [];
    if (integration?.settings) {
        rtn.push(`--settings ${integration.settings}`);
    }
    if (integration?.mcpconfig) {
        rtn.push(`--mcp-config ${integration.mcpconfig}`);
    }
    const args = integration?.args ?? [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "-c" && i + 1 < args.length) {
            rtn.push(`-c ${args[i + 1]}`);
            i++;
            continue;
        }
        rtn.push(args[i]);
    }
    return rtn;
}
