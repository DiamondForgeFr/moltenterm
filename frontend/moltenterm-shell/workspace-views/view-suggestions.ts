// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The ready-made combinations of panels (FR-SHELL-138, #1709): MoltenTerm makes no view on the user's behalf, so they
// live only as suggestions, in the new-view launcher (⌘T) and in the first launch's first-view step (FR-ONB-009), the
// same list in the same order. A view made from one is laid out like a template view (DS-SHELL-132): the agent slot on
// the left, the graphical panels stacked on the right (DS-REV-012), named by a dictionary key until renamed.

import type { PinConfig, PinNode } from "../sidebar/view-pins-model";
import { AgentSlotMetaKey, RepoToken } from "../sidebar/view-pins-model";
import { WorkspaceViewPanels } from "./workspace-views-model";

// must match ProjectToken in pkg/molten/viewpin/viewpin.go
export const ProjectToken = "molten:projectdir";
// On an agent slot made by the first launch: the catalog id of the agent the user picked there, which the slot's Start
// opens (pkg/molten/onboarding/agents.go ids). Never a command: the slot looks the command up in the catalog.
export const AgentSlotAgentMetaKey = "molten:slotagent";

export type ViewSuggestion = { id: string; nameKey: string; panels: string[] };

export const ViewSuggestions: ViewSuggestion[] = [
    { id: "scoping", nameKey: "workspaceViews.names.scoping", panels: ["agent", "browser", "files"] },
    { id: "pilotage", nameKey: "workspaceViews.names.pilotage", panels: ["project", "integration"] },
    { id: "preview", nameKey: "workspaceViews.names.preview", panels: ["agent", "browser"] },
    { id: "code", nameKey: "workspaceViews.names.code", panels: ["agent", "files"] },
    { id: "delivery", nameKey: "workspaceViews.names.delivery", panels: ["agent", "integration"] },
];

export function findSuggestion(id: string): ViewSuggestion {
    return ViewSuggestions.find((s) => s.id === id) ?? null;
}

// What each panel kind opens, on the workspace's project when the view is built. must match viewPanelMeta in
// pkg/wcore/moltenterm_workspaceviews.go
function panelMeta(kind: string): Record<string, any> {
    switch (kind) {
        case "agent":
            return { view: "term", controller: "shell", [AgentSlotMetaKey]: true };
        case "terminal":
            return { view: "term", controller: "shell" };
        case "browser":
            return { view: "molten-browser", url: RepoToken };
        case "files":
            return { view: "preview", file: ProjectToken };
        case "project":
            return { view: "molten-project" };
        case "integration":
            return { view: "molten-reviews" };
        case "cicd":
            return { view: "molten-cicd" };
        case "linemap":
            return { view: "molten-linemap" };
    }
    return null;
}

function group(idxs: number[], dir: string): PinNode {
    if (idxs.length === 1) {
        return { pane: idxs[0] };
    }
    return { dir, children: idxs.map((pane) => ({ pane })) };
}

// The configuration of a view holding these panels, as WorkspaceViewConfig makes it in wavesrv: the agent slots in a
// column on the left, the others in a column on the right; without an agent, the panels side by side. agentId, when
// given, is the agent the slot's Start opens. null when no kind is known.
export function suggestionConfig(panels: string[], agentId?: string): PinConfig {
    const panes: Record<string, any>[] = [];
    const agents: number[] = [];
    const others: number[] = [];
    for (const kind of panels ?? []) {
        const meta = panelMeta(kind);
        if (meta == null) {
            continue;
        }
        if (kind === "agent" && agentId) {
            meta[AgentSlotAgentMetaKey] = agentId;
        }
        (kind === "agent" ? agents : others).push(panes.length);
        panes.push(meta);
    }
    if (panes.length === 0) {
        return null;
    }
    let tree: PinNode;
    if (agents.length === 0) {
        tree = group(others, "row");
    } else if (others.length === 0) {
        tree = group(agents, "row");
    } else {
        tree = { dir: "row", children: [group(agents, "column"), group(others, "column")] };
    }
    return { tree, panes };
}

export type SuggestionPanel = { kind: string; labelKey: string; icon: string };

export function suggestionPanels(suggestion: ViewSuggestion): SuggestionPanel[] {
    return (suggestion?.panels ?? [])
        .map((kind) => WorkspaceViewPanels.find((p) => p.kind === kind))
        .filter((p) => p != null);
}
