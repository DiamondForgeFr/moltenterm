// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sidebar's agents (FR-SHELL-084, DS of #1181): one row per agent of the workspace, from wavesrv's agent states,
// in the order they were created. A view where an agent runs stays listed as a view (#1246).

import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { TFunction } from "../i18n/i18n";
import { pathBaseName } from "../workspace-project";
import type { SidebarTabSplit } from "./sidebar-model";
import { projectLabel, type WorkspaceProjectEntry } from "./workspace-projects";

// The agents of a workspace: the terminals where MoltenTerm detected an agent, the first started first. Never by
// state or activity (#2296): a row that moves while the developer reads the list makes them lose their place.
export function workspaceAgents(data: AgentStatesData, workspaceId: string): AgentStateInfo[] {
    if (!workspaceId) {
        return [];
    }
    return Object.values(data?.states ?? {})
        .filter((s) => s.workspaceid === workspaceId && !!(s.agent || s.agentname))
        .sort((a, b) => (a.started ?? Infinity) - (b.started ?? Infinity) || a.blockid.localeCompare(b.blockid));
}

// The row's look: working shows the dominoes, waiting and error a dot and coloured text, done a green dot on a dimmed
// row, idle nothing.
export type AgentRowLook = "working" | "waiting" | "error" | "done" | "idle";

export function agentRowLook(info: AgentStateInfo): AgentRowLook {
    switch (info?.state) {
        case "working":
        case "waiting":
        case "error":
        case "done":
            return info.state;
    }
    return "idle";
}

// An agent whose turn ended with services left running (#2583, FR-SHELL-084): a dev server or a daemon runs until
// somebody stops it, so the agent is not at work. Its row keeps its own state (done, idle), says what runs on its second
// line and wears a calm plug where the dominoes would be. A working agent shows its services in its tree only, and a
// waiting or failed one keeps its own words: they matter more.
export function agentHasServiceLeft(info: AgentStateInfo): boolean {
    const look = agentRowLook(info);
    return (info?.services?.length ?? 0) > 0 && (look === "done" || look === "idle");
}

// "Service running: Molten browser daemon", "Service running" when the agent gave no words, "2 services running" for
// several; "" unless agentHasServiceLeft. tc is the plural form of a key for a count (useTCount).
export function agentServiceLine(
    t: TFunction,
    tc: (key: string, count: number) => string,
    info: AgentStateInfo
): string {
    if (!agentHasServiceLeft(info)) {
        return "";
    }
    const services = info.services;
    if (services.length > 1) {
        return tc("sidebar.agents.services", services.length);
    }
    const name = (services[0] ?? "").trim();
    return name === "" ? t("sidebar.agents.serviceUnnamed") : t("sidebar.agents.service", { name });
}

// The project chip on an agent's name line (FR-SHELL-084, #1746): shown only when the workspace holds two projects or
// more. The agent's terminal folder names its project: the project whose folder holds it, the longest match when
// projects nest, never the workspace's default project. An agent outside every project shows its folder's name,
// muted. Nothing without a folder.
export type AgentProjectLabel = { text: string; outside: boolean };

export function agentProjectLabel(folder: string, projects: WorkspaceProjectEntry[]): AgentProjectLabel {
    if (projects == null || projects.length < 2) {
        return null;
    }
    const here = trimPath(folder);
    if (here === "") {
        return null;
    }
    const owner = projectOfFolder(folder, projects);
    if (owner != null) {
        return { text: projectLabel(owner), outside: false };
    }
    const text = pathBaseName(here);
    return text === "" ? null : { text, outside: true };
}

// The project whose folder holds `folder`, the longest match when projects nest; null when none does. A project with a
// repository inside its folder matches by it too, which is longer: of the projects sharing a client's folder, the one
// whose repository holds `folder` owns it (#1777). must match ProjectOfDir in pkg/molten/projectviews/projectviews.go
export function projectOfFolder(folder: string, projects: WorkspaceProjectEntry[]): WorkspaceProjectEntry {
    const here = trimPath(folder);
    let owner: WorkspaceProjectEntry = null;
    let ownerLength = -1;
    if (here === "") {
        return null;
    }
    for (const p of projects ?? []) {
        const matched = matchLength(p, here);
        if (matched > ownerLength) {
            owner = p;
            ownerLength = matched;
        }
    }
    return owner;
}

// How much of `here` a project's places hold: its repository first, else its folder; -1 for none.
function matchLength(p: WorkspaceProjectEntry, here: string): number {
    const dir = trimPath(p.dir);
    if (dir === "") {
        return -1;
    }
    const repo = trimPath(p.repo ?? "");
    if (repo !== "" && repo !== dir && holds(dir, repo) && holds(repo, here)) {
        return repo.length;
    }
    return holds(dir, here) ? dir.length : -1;
}

function trimPath(path: string): string {
    return (path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function holds(dir: string, path: string): boolean {
    return path === dir || path.startsWith(`${dir}/`);
}

export type SidebarSections = SidebarTabSplit & { agents: AgentStateInfo[] };

// The sidebar's sections (FR-SHELL-084, #1246): a view stays in its own section, temporary list, tiles or top row,
// whatever it holds; the agents are listed beside the views, never in their place.
export function sidebarSections(split: SidebarTabSplit, agents: AgentStateInfo[]): SidebarSections {
    return { ...split, agents: agents ?? [] };
}

// Where an agent row goes: the workspace, the view and the panel the agent runs in.
export function agentRowTarget(info: AgentStateInfo): { workspaceid: string; tabid: string; blockid: string } {
    return { workspaceid: info?.workspaceid, tabid: info?.tabid, blockid: info?.blockid };
}

// What the developer opened or closed in an agent's tree, kept on the agent terminal's block (#1763): the tree
// itself, and each section.
export type AgentTreeSection = "subs" | "services" | "links";
export type AgentTreeState = { open?: boolean; shut?: Partial<Record<AgentTreeSection, boolean>> };
export type AgentTreeStates = Record<string, AgentTreeState>;

export function toggleTree(state: AgentTreeState): AgentTreeState {
    const cur = state ?? {};
    return { ...cur, open: !cur.open };
}

export function toggleSection(state: AgentTreeState, section: AgentTreeSection): AgentTreeState {
    const cur = state ?? {};
    return { ...cur, shut: { ...(cur.shut ?? {}), [section]: !cur.shut?.[section] } };
}

export function readTreeState(raw: unknown): AgentTreeState {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }
    const v = raw as Record<string, any>;
    const shut: AgentTreeState["shut"] = {};
    if (v.shut?.subs === true) {
        shut.subs = true;
    }
    if (v.shut?.services === true) {
        shut.services = true;
    }
    if (v.shut?.links === true) {
        shut.links = true;
    }
    return { open: v.open === true, shut };
}

// The map earlier versions kept in localStorage, by agent terminal.
export function readTreeStates(raw: unknown): AgentTreeStates {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const rtn: AgentTreeStates = {};
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
        const state = readTreeState(v);
        if (state != null) {
            rtn[k] = state;
        }
    }
    return rtn;
}
