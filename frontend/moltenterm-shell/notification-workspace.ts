// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace an item of the notification center belongs to (#282), as the row shows it at the start of its meta
// line. Kept apart from the component so the rules can be tested without the app.

import { pathBaseName, readWorkspaceProject } from "./workspace-project";

export type WorkspaceLabel = {
    id: string;
    name: string;
    // The project's folder name, only when it differs from the workspace's name.
    project: string;
    icon: string;
    color: string;
    logo: string;
    current: boolean;
    // The workspace no longer exists: the label stays, but leads nowhere.
    missing: boolean;
};

export const MissingWorkspaceName = "Deleted workspace";

// null for an item without a workspace: it shows nothing extra.
export function workspaceLabel(
    workspaceId: string,
    workspaces: Map<string, Workspace>,
    currentId: string
): WorkspaceLabel {
    if (!workspaceId) {
        return null;
    }
    const ws = workspaces?.get(workspaceId);
    if (ws == null) {
        return {
            id: workspaceId,
            name: MissingWorkspaceName,
            project: "",
            icon: "",
            color: "",
            logo: "",
            current: false,
            missing: true,
        };
    }
    const { dir, logo } = readWorkspaceProject(ws);
    const name = ws.name || "Unsaved workspace";
    const projectFolder = pathBaseName(dir);
    return {
        id: workspaceId,
        name,
        project: projectFolder.toLowerCase() === name.toLowerCase() ? "" : projectFolder,
        icon: ws.icon,
        color: ws.color,
        logo,
        current: workspaceId === currentId,
        missing: false,
    };
}

export function workspaceLabelText(label: WorkspaceLabel): string {
    return label.project ? `${label.name} · ${label.project}` : label.name;
}
