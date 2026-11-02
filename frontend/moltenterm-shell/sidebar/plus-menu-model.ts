// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar's + menu (FR-SHELL-107, prototype item 16): what to create, by where it goes. In this view: a terminal, a
// web page, an agent, another panel; in the workspace: a view, a project; and a new workspace. The panels and the
// agents are the new view chooser's (FR-SHELL-089): every agent preset MoltenTerm knows, never a hard-coded provider.

import { TerminalChoiceId, WebPageChoiceId } from "../newview/new-view-model";
import { fillsPanel, PaletteEntry } from "../palette/palette-model";

type TFn = (key: string, vars?: Record<string, any>) => string;

export type PlusMenuActions = {
    workspace: string;
    // The new view chooser's entries (currentNewViewChoices).
    choices: PaletteEntry[];
    onOpenHere: (entry: PaletteEntry) => void;
    onNewView: () => void;
    newViewKeys?: string;
    onAddProject: () => void;
    onNewWorkspace: () => void;
};

function entryItem(entry: PaletteEntry, actions: PlusMenuActions): ContextMenuItem {
    return { label: entry.label, icon: entry.icon, click: () => actions.onOpenHere(entry) };
}

function inThisView(actions: PlusMenuActions, t: TFn): ContextMenuItem[] {
    const section = t("sidebar.plus.inThisView");
    const panels = actions.choices.filter((e) => fillsPanel(e.run));
    const terminal = panels.find((e) => e.id === TerminalChoiceId);
    const web = panels.find((e) => e.id === WebPageChoiceId);
    const agents = panels.filter((e) => e.group === "agents");
    const others = panels.filter((e) => e !== terminal && e !== web && e.group !== "agents");
    const items: ContextMenuItem[] = [];
    if (terminal != null) {
        items.push({ ...entryItem(terminal, actions), label: t("sidebar.plus.terminal"), icon: "terminal", section });
    }
    if (web != null) {
        items.push({ ...entryItem(web, actions), label: t("sidebar.plus.webPage"), icon: "globe", section });
    }
    if (agents.length === 1) {
        items.push({
            ...entryItem(agents[0], actions),
            label: t("sidebar.plus.agent"),
            sublabel: agents[0].label,
            icon: "user",
            section,
        });
    } else if (agents.length > 1) {
        items.push({
            label: t("sidebar.plus.agent"),
            icon: "user",
            type: "submenu",
            section,
            submenu: agents.map((e) => entryItem(e, actions)),
        });
    }
    if (others.length > 0) {
        items.push({
            label: t("sidebar.plus.otherPanel"),
            icon: "table-columns",
            type: "submenu",
            section,
            submenu: others.map((e) => entryItem(e, actions)),
        });
    }
    return items;
}

export function plusMenuItems(actions: PlusMenuActions, t: TFn): ContextMenuItem[] {
    const inWorkspace = t("sidebar.plus.inWorkspace", { name: actions.workspace });
    const workspaces = t("sidebar.plus.workspaces");
    return [
        ...inThisView(actions, t),
        {
            label: t("sidebar.plus.newView"),
            icon: "plus",
            section: inWorkspace,
            accelerator: actions.newViewKeys,
            click: actions.onNewView,
        },
        { label: t("sidebar.project.addMenu"), icon: "folder-plus", section: inWorkspace, click: actions.onAddProject },
        {
            label: t("sidebar.plus.newWorkspace"),
            icon: "layer-group",
            section: workspaces,
            click: actions.onNewWorkspace,
        },
    ];
}
