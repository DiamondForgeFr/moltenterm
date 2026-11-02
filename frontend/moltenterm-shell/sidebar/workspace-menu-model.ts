// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace menu (FR-SHELL-079, FR-SHELL-107): one list for the header's ⋯, a workspace dot and the sidebar's
// background, in three families: the workspace itself, its projects, and Delete or reset last. Every item is an action
// that already exists elsewhere, so this module only decides what the menu offers and when a right-click opens it.

type TFn = (key: string, vars?: Record<string, any>) => string;

export type WorkspaceMenuProject = { id: string; label: string; current: boolean; onSwitch: () => void };

export type WorkspaceMenuActions = {
    name: string;
    // The edit sheet holds the name, the icon and the colour: one entry, not one per field.
    onEdit: () => void;
    // Keep awake (FR-SHELL-023), built by the sidebar where the computer supports it.
    keepAwake?: ContextMenuItem;
    onManage: () => void;
    // Set for the workspace on screen, whose projects the window knows (FR-SHELL-087).
    projects?: {
        list: WorkspaceMenuProject[];
        onAdd: () => void;
        // Set when the current project has a folder (FR-SHELL-015).
        onProjectTab?: () => void;
    };
    onReset: () => void;
    // Disabled with its reason on the last workspace (#222).
    remove: { enabled: boolean; reason: string; onDelete: () => void };
};

export function workspaceMenuItems(actions: WorkspaceMenuActions, t: TFn): ContextMenuItem[] {
    const workspace = t("sidebar.workspaceMenu.header", { name: actions.name });
    const items: ContextMenuItem[] = [
        { label: t("sidebar.workspaceMenu.edit"), icon: "pen", section: workspace, click: actions.onEdit },
    ];
    if (actions.keepAwake != null) {
        items.push({ ...actions.keepAwake, section: workspace });
    }
    items.push({
        label: t("sidebar.workspaceMenu.manage"),
        icon: "layer-group",
        section: workspace,
        click: actions.onManage,
    });
    const projects = actions.projects;
    if (projects != null) {
        const section = t("sidebar.workspaceMenu.projects", { count: projects.list.length });
        for (const project of projects.list) {
            items.push({
                label: project.label,
                type: "checkbox",
                checked: project.current,
                section,
                click: project.onSwitch,
            });
        }
        items.push({ label: t("sidebar.project.addMenu"), icon: "folder-plus", section, click: projects.onAdd });
        if (projects.onProjectTab != null) {
            items.push({
                label: t("rail.menu.openProjectTab"),
                icon: "folder-open",
                section,
                click: projects.onProjectTab,
            });
        }
    }
    const remove = t("sidebar.workspaceMenu.removeSection");
    items.push(
        { label: t("rail.menu.resetWorkspace"), icon: "rotate-left", section: remove, click: actions.onReset },
        {
            label: t("sidebar.workspaceMenu.delete"),
            icon: "trash",
            destructive: true,
            section: remove,
            enabled: actions.remove.enabled,
            sublabel: actions.remove.enabled ? undefined : actions.remove.reason,
            click: actions.remove.onDelete,
        }
    );
    return items;
}

// Views, agent rows and pinned blocks open their own menu, which stops the event before it reaches the sidebar; the
// controls (library, dots, +, buttons, fields) keep the system menu or their own.
const ControlSelector = "button, a, input, textarea, select, [role='button'], [contenteditable='true']";

export function opensWorkspaceMenu(target: Element, handled: boolean): boolean {
    if (handled || target == null || typeof target.closest !== "function") {
        return false;
    }
    return target.closest(ControlSelector) == null;
}
