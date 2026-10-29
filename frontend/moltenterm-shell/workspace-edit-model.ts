// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The rules of the workspace edit sheet (FR-SHELL-030, DS-SHELL-035/036), kept apart from the components so they are
// tested without the app: the name check, what the icon and colour controls are called, how the arrow keys move in
// their radio groups, and the double-click handed over between two tab views.

import { t } from "./i18n/i18n";
import { colourChoiceName } from "./workspace-colour";
import { lastWorkspaceReason } from "./workspace-reset-model";

export function emptyNameError(): string {
    return t("workspace.edit.emptyName");
}

const IconNames: Record<string, string> = {
    "custom@wave-logo-solid": "workspace.icons.wave",
    "solid@cloud": "workspace.icons.cloud",
    "layer-group": "workspace.icons.layers",
    "chart-line": "workspace.icons.chart",
    "graduation-cap": "workspace.icons.graduationCap",
    "mug-hot": "workspace.icons.hotMug",
};

// The name to save, or null when the field is empty: the previous name then stays saved.
export function checkWorkspaceName(draft: string): string {
    const name = (draft ?? "").trim();
    return name === "" ? null : name;
}

// A swatch is announced by its name, never by its colour alone (NFR-SHELL-014): wavesrv's colours
// (pkg/wcore/workspace.go, WorkspaceColors) and the presets of workspace-colour.ts each have one.
export function colourName(colour: string): string {
    return colourChoiceName(colour);
}

export function iconName(icon: string): string {
    if (!icon) {
        return t("workspace.icons.none");
    }
    const known = IconNames[icon];
    if (known) {
        return t(known);
    }
    const bare = icon.replace(/^[a-z]+@/, "").replace(/-/g, " ");
    return bare.charAt(0).toUpperCase() + bare.slice(1);
}

// The sheet's two parts and the fields each holds, in order (#1280, DS-SHELL-036): what is the workspace's own, then
// what follows its linked project. A field is in exactly one part.
export type WorkspaceEditPart = "workspace" | "project";
export type WorkspaceEditField =
    | "name"
    | "icon"
    | "colour"
    | "look"
    | "linkedProject"
    | "logo"
    | "folder"
    | "projectSettings";

export const WorkspaceEditParts: Record<WorkspaceEditPart, readonly WorkspaceEditField[]> = {
    workspace: ["name", "icon", "colour", "look"],
    project: ["linkedProject", "logo", "folder", "projectSettings"],
};

export function partOfField(field: WorkspaceEditField): WorkspaceEditPart {
    return (Object.keys(WorkspaceEditParts) as WorkspaceEditPart[]).find((part) =>
        WorkspaceEditParts[part].includes(field)
    );
}

export type ProjectPartState = {
    hasProject: boolean;
    // Project settings… opens the sidebar's project page, which edits the workspace the window shows.
    sidebarOn: boolean;
    isWindowWorkspace: boolean;
};

// The Project part's fields that show. Without a linked project it offers the link and keeps the folder: nothing else
// in the sheet waits on a project.
export function projectPartFields(state: ProjectPartState): WorkspaceEditField[] {
    return WorkspaceEditParts.project.filter((field) => {
        if (field === "logo") {
            return state.hasProject;
        }
        if (field === "projectSettings") {
            return state.hasProject && state.sidebarOn && state.isWindowWorkspace;
        }
        return true;
    });
}

export type DangerAction = { kind: "delete" | "reset"; label: string; text: string };

// The last workspace is reset, never deleted (#222); both keep their confirmations.
export function dangerAction(closable: boolean): DangerAction {
    if (closable) {
        return {
            kind: "delete",
            label: t("workspace.edit.deleteLabel"),
            text: t("workspace.edit.deleteText"),
        };
    }
    return { kind: "reset", label: t("workspace.edit.resetLabel"), text: `${lastWorkspaceReason()}.` };
}

// The option a key moves to in a radio group of count options (WAI-ARIA radio group: the arrows move and select, and
// wrap; Home and End go to the ends). -1 when the key does not move.
export function moveRadio(key: string, index: number, count: number): number {
    if (count <= 0) {
        return -1;
    }
    const from = index >= 0 && index < count ? index : 0;
    switch (key) {
        case "ArrowRight":
        case "ArrowDown":
            return (from + 1) % count;
        case "ArrowLeft":
        case "ArrowUp":
            return (from - 1 + count) % count;
        case "Home":
            return 0;
        case "End":
            return count - 1;
        default:
            return -1;
    }
}

// The option that takes the tab stop of a radio group: the selected one, else the first.
export function radioTabStop(options: string[], selected: string): number {
    const index = (options ?? []).indexOf(selected);
    return index >= 0 ? index : 0;
}

// A click on another workspace in the rail switches the window to another tab view, that is another renderer. The
// second click of a double-click then lands in the old renderer (before the switch is drawn) or in the new one, never
// as a dblclick of the same element: the renderer that sees the gesture writes this intent to localStorage, which
// every renderer of the app shares, and the one that shows the workspace opens the sheet.
export type WorkspaceEditIntent = { workspaceId: string; at: number };

export const WorkspaceEditIntentKey = "moltenterm:workspace-edit-intent";
export const WorkspaceSwitchClickKey = "moltenterm:workspace-switch-click";

// Long enough for a switch to a tab view that was not loaded yet; short enough that a stale one is never picked up by a
// later, unrelated switch.
export const IntentMaxAgeMs = 4000;
// The second click of a double-click: the systems' default intervals are at most 500 ms.
export const DoubleClickMs = 500;

export function parseIntent(raw: string): WorkspaceEditIntent {
    if (!raw) {
        return null;
    }
    try {
        const value = JSON.parse(raw);
        if (typeof value?.workspaceId !== "string" || value.workspaceId === "" || typeof value?.at !== "number") {
            return null;
        }
        return { workspaceId: value.workspaceId, at: value.at };
    } catch {
        return null;
    }
}

export function isFreshIntent(
    intent: WorkspaceEditIntent,
    workspaceId: string,
    now: number,
    maxAgeMs: number
): boolean {
    if (intent == null || !workspaceId || intent.workspaceId !== workspaceId) {
        return false;
    }
    const age = now - intent.at;
    return age >= 0 && age <= maxAgeMs;
}
