// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace menu of the sidebar's background and of its workspace name (FR-SHELL-079, #1252): every item is an
// action that already exists elsewhere, so this module only decides what the menu offers and when a right-click opens it.

type TFn = (key: string, vars?: Record<string, any>) => string;

export type WorkspaceMenuActions = {
    name: string;
    // The edit sheet holds the name, the icon and the colour: three entries, one sheet.
    onRename: () => void;
    onChangeIcon: () => void;
    onEditColour: () => void;
    onEdit: () => void;
    onNewView: () => void;
    onAddProject: () => void;
    onManage: () => void;
    newViewKeys?: string;
    remove: { enabled: boolean; reason: string; onDelete: () => void };
};

export function workspaceBackgroundMenuItems(actions: WorkspaceMenuActions, t: TFn): ContextMenuItem[] {
    return [
        { type: "header", label: t("sidebar.workspaceMenu.header", { name: actions.name }) },
        { label: t("sidebar.workspaceMenu.rename"), icon: "pen", click: actions.onRename },
        { label: t("sidebar.workspaceMenu.changeIcon"), icon: "icons", click: actions.onChangeIcon },
        { label: t("sidebar.workspaceMenu.editColour"), icon: "palette", click: actions.onEditColour },
        { label: t("sidebar.workspaceMenu.edit"), icon: "sliders", click: actions.onEdit },
        { type: "separator" },
        {
            label: t("sidebar.workspaceMenu.newView"),
            icon: "plus",
            accelerator: actions.newViewKeys,
            click: actions.onNewView,
        },
        { label: t("sidebar.project.addMenu"), icon: "folder-plus", click: actions.onAddProject },
        { label: t("sidebar.workspaceMenu.manage"), icon: "layer-group", click: actions.onManage },
        { type: "separator" },
        {
            label: t("sidebar.workspaceMenu.delete"),
            icon: "trash",
            destructive: true,
            enabled: actions.remove.enabled,
            sublabel: actions.remove.enabled ? undefined : actions.remove.reason,
            click: actions.remove.onDelete,
        },
    ];
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
