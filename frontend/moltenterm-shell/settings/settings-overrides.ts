// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The app settings a workspace can replace with its own value (FR-SHELL-101): the window's look (FR-SHELL-091) is
// resolved workspace over project over the app's window:* settings, so a workspace with its own look, or on a project
// with one, no longer follows these rows. Preferences say so on each. Kept apart from the components to be tested
// alone.

import { lookForWorkspace } from "../window-look-model";
import { readWorkspaceProject } from "../workspace-project";

export const WindowLookSettingKeys = ["window:transparent", "window:blur", "window:opacity"];

// The workspaces whose window look does not come from the app's settings, in the given order.
export function lookOverriders<T extends { meta?: Record<string, any> }>(
    workspaces: T[],
    clientMeta: Record<string, any>
): T[] {
    return (workspaces ?? []).filter(
        (ws) =>
            ws != null &&
            lookForWorkspace(ws, readWorkspaceProject(ws as unknown as Workspace).dir, clientMeta, null).source !==
                "global"
    );
}

// The workspaces that replace an app setting, or none for a setting no workspace can replace.
export function settingOverriders<T extends { meta?: Record<string, any> }>(
    key: string,
    workspaces: T[],
    clientMeta: Record<string, any>
): T[] {
    if (!WindowLookSettingKeys.includes(key)) {
        return [];
    }
    return lookOverriders(workspaces, clientMeta);
}
