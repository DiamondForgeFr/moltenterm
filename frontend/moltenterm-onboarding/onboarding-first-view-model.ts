// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the first launch's project, first-view and place scenes decide (FR-ONB-007 P-4, FR-ONB-009), kept apart from
// the components so the rules are tested without a window: the folder a new project gets, the tools of the view and
// the name that follows them, the agent on its left, and the view the last scene makes.

import { findSuggestion, ViewSuggestions } from "../moltenterm-shell/workspace-views/view-suggestions";
import type { OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import { catalogAgents } from "./onboarding-agent-model";

// The tools the view may hold on the right of its agent, in the mock-up's order; up to MaxTools at once. Each one's
// hint is the key onboarding.pour.view.hints.<kind>.
export const FirstViewTools: { kind: string; labelKey: string; icon: string }[] = [
    { kind: "browser", labelKey: "workspaceViews.panels.browser", icon: "globe" },
    { kind: "files", labelKey: "workspaceViews.panels.files", icon: "folder-open" },
    { kind: "integration", labelKey: "workspaceViews.panels.integration", icon: "code-pull-request" },
    { kind: "project", labelKey: "workspaceViews.panels.project", icon: "gauge" },
];
export const MaxTools = 3;
const ToolKinds = FirstViewTools.map((t) => t.kind);

export const DefaultToolsSuggestion = "scoping";
export const MyViewNameKey = "workspaceViews.names.myView";
export const AgentOnlyNameKey = "workspaceViews.names.agentOnly";

export type ViewPlace = "everywhere" | "workspace";
export const DefaultPlace: ViewPlace = "everywhere";

// A preset's tools: the suggestion's panels on the right of its agent, the agent itself always being there.
export function presetTools(suggestionId: string): string[] {
    return (findSuggestion(suggestionId)?.panels ?? []).filter((k) => ToolKinds.includes(k));
}

// A tool turned on joins the view; a fourth one pushes the oldest out. Turned off, it goes.
export function toggleTool(tools: string[], kind: string): string[] {
    if (!ToolKinds.includes(kind)) {
        return tools;
    }
    if (tools.includes(kind)) {
        return tools.filter((k) => k !== kind);
    }
    const next = [...tools, kind];
    return next.length > MaxTools ? next.slice(next.length - MaxTools) : next;
}

function sameSet(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((k) => b.includes(k));
}

// The suggestion whose tools these are, in the order of FR-SHELL-138; null for another combination.
export function matchingSuggestion(tools: string[]): string {
    return ViewSuggestions.find((s) => sameSet(presetTools(s.id), tools ?? []))?.id ?? null;
}

// The name the view gets until the user types one: its suggestion's, else My view, else Agent for the agent alone.
export function suggestedNameKey(tools: string[]): string {
    const id = matchingSuggestion(tools);
    if (id != null) {
        return findSuggestion(id).nameKey;
    }
    return (tools ?? []).length === 0 ? AgentOnlyNameKey : MyViewNameKey;
}

// The view's panels as a template lists them: the agent first, then the tools in the order they were turned on.
export function viewPanels(tools: string[]): string[] {
    return ["agent", ...(tools ?? []).filter((k) => ToolKinds.includes(k))];
}

// The agents ready on the agents scene, never a vendor picked by MoltenTerm: those found, in the catalog's order.
export function readyAgents(list: OnboardingAgents): OnboardingAgent[] {
    return catalogAgents(list).filter((a) => a.found && a.executable);
}

// The agent on the view's left: the one kept if still ready, else the one installed on the agents scene, else the
// first found; null when none is ready.
export function defaultAgentId(ready: OnboardingAgent[], kept: string, installed: string): string {
    const ids = (ready ?? []).map((a) => a.id);
    for (const id of [kept, installed]) {
        if (id && ids.includes(id)) {
            return id;
        }
    }
    return ids[0] ?? null;
}

// The view the last scene makes (FR-ONB-009): its panels, the agent the slot opens, its typed name or its key, and
// where it is pinned. A blank typed name keeps the suggestion's key.
export type FirstViewPlan = { panels: string[]; agentId: string; name: string; nameKey: string; place: ViewPlace };

export function firstViewPlan(input: {
    tools: string[];
    agentId: string;
    typedName: string;
    named: boolean;
    place: ViewPlace;
}): FirstViewPlan {
    const typed = input.named ? (input.typedName ?? "").trim() : "";
    return {
        panels: viewPanels(input.tools),
        agentId: input.agentId ?? null,
        name: typed,
        nameKey: typed ? null : suggestedNameKey(input.tools),
        place: input.place === "workspace" ? "workspace" : "everywhere",
    };
}

// The project scene (FR-ONB-007 P-4): create a folder or find one.
export type ProjectMode = "new" | "find";
export const DefaultProjectMode: ProjectMode = "find";

// The folder MoltenTerm proposes for new projects: Projets in French, Projects otherwise, in the home folder. It is
// made with the first project, never before.
export function defaultProjectsFolder(home: string, locale: string): string {
    const base = (home ?? "").replace(/[/\\]+$/, "");
    const name = (locale ?? "").toLowerCase().startsWith("fr") ? "Projets" : "Projects";
    return base ? `${base}/${name}` : name;
}

// A folder name as typed, made safe: no separators, no surrounding spaces; "" when nothing usable is left.
export function cleanFolderName(typed: string): string {
    const name = (typed ?? "").trim().replace(/[/\\]+/g, "-");
    return name === "." || name === ".." ? "" : name;
}

export function joinPath(dir: string, name: string): string {
    return `${(dir ?? "").replace(/[/\\]+$/, "")}/${name}`;
}

// A path under the home folder written with ~, as the scene shows it.
export function shownPath(path: string, home: string): string {
    if (!home || !path) {
        return path ?? "";
    }
    const h = home.replace(/[/\\]+$/, "");
    return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

// The project scene's choice, what leaving it creates or links.
export type ProjectDraft = { mode: ProjectMode; name: string; location: string; git: boolean; found: string };

export function projectTarget(draft: ProjectDraft): string {
    if (draft?.mode === "new") {
        const name = cleanFolderName(draft.name);
        return name && draft.location ? joinPath(draft.location, name) : "";
    }
    return draft?.found ?? "";
}

// What the project scene set, for the chip and the recap.
export type ProjectResult = { name: string; path: string; colour: string };
