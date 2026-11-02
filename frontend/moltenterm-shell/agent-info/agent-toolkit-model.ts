// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What an agent session can use (FR-SHELL-084, FR-CONT-006, #1543): its MCP servers, skills and plugins, read-only.
// wavesrv's agent adapter reads them from the agent's own configuration files when the agent window opens
// (pkg/molten/agenttoolkit); MoltenTerm's own servers come from the terminal's links with their live state. Choosing
// what stays usable is #550.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { BlockLinks, LinkState } from "../agent-links/agent-links-model";
import type { CompanionView } from "../companion/companion-model";
import { mcpServerRows } from "./agent-info-model";

// must match pkg/molten/agentcontinuity/toolkitroute.go
const RouteId = "molten:agenttoolkit";
const GetCommand = "moltenagenttoolkit";
const GetTimeoutMs = 8000;

export type ToolkitScope = "user" | "project" | "local" | "plugin" | "system";

// must match pkg/molten/agenttoolkit/toolkit.go
export type ToolkitServer = {
    name: string;
    transport?: string;
    scope: ToolkitScope;
    plugin?: string;
    state?: "needsapproval" | "off";
};
export type ToolkitSkill = { name: string; description?: string; scope: ToolkitScope; plugin?: string };
export type ToolkitPlugin = { name: string; source?: string; scope: ToolkitScope; enabled: boolean };
export type AgentToolkit = {
    supported: boolean;
    online?: boolean;
    servers?: ToolkitServer[];
    skills?: ToolkitSkill[];
    plugins?: ToolkitPlugin[];
};

export function fetchAgentToolkit(agent: string, cwd: string): Promise<AgentToolkit> {
    return TabRpcClient.wshRpcCall(GetCommand, { agent, cwd }, { route: RouteId, timeout: GetTimeoutMs });
}

// One server row of the window. origin: "molten" for MoltenTerm's own (live state), otherwise the configuration's
// scope. state: the live link state, or the configuration's word, or "configured".
export type ServerRow = {
    name: string;
    origin: ToolkitScope | "molten";
    plugin?: string;
    transport?: string;
    state: LinkState | "needsapproval" | "off" | "configured";
};

// MoltenTerm's servers first (they are the ones it can vouch for), then the configured ones; a configured server
// MoltenTerm also links shows once, as MoltenTerm's.
export function serverRows(links: BlockLinks, toolkit: AgentToolkit): ServerRow[] {
    const own: ServerRow[] = mcpServerRows(links).map((r) => ({
        name: r.server,
        origin: "molten",
        state: r.state ?? "connected",
    }));
    const ownNames = new Set(own.map((r) => r.name));
    const configured: ServerRow[] = (toolkit?.servers ?? [])
        .filter((s) => s?.name && !ownNames.has(s.name))
        .map((s) => ({
            name: s.name,
            origin: s.scope,
            plugin: s.plugin,
            transport: s.transport,
            state: s.state ?? "configured",
        }));
    return [...own, ...configured];
}

export type CommandRow = { name: string; count: number };

// The programs the agent ran, the most used first (then in first-use order), with how many shell calls ran each.
export function commandRows(view: CompanionView): CommandRow[] {
    const counts = view?.commandcounts ?? {};
    const rows = (view?.commands ?? []).map((name, i) => ({ name, count: counts[name] ?? 1, i }));
    rows.sort((a, b) => b.count - a.count || a.i - b.i);
    return rows.map(({ name, count }) => ({ name, count }));
}

// Lists longer than this show their first rows and a line to show the rest.
export const ToolkitPreviewRows = 6;
