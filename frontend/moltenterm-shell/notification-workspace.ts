// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace an item of the notification center belongs to (#282), as the row shows it at the start of its meta
// line. Kept apart from the component so the rules can be tested without the app.

import { tabProjectOf } from "./hidden-tabs";
import { t } from "./i18n/i18n";
import { projectLabel, readProjects } from "./sidebar/workspace-projects";
import { workspaceShownName } from "./workspace-default-name";
import { workspaceIconSource } from "./workspace-icon-model";
import { pathBaseName, readWorkspaceProject } from "./workspace-project";

export type WorkspaceLabel = {
    id: string;
    name: string;
    // The project's folder name, only when it differs from the workspace's name.
    project: string;
    icon: string;
    color: string;
    logo: string;
    // The stored name of its imported icon (FR-SHELL-031): the chip resolves it like the rail.
    image: string;
    current: boolean;
    // The workspace no longer exists: the label stays, but leads nowhere.
    missing: boolean;
};

// English; the label shows t("notif.workspace.deleted").
export const MissingWorkspaceName = "Deleted workspace";

// null for an item without a workspace: it shows nothing extra.
export function workspaceLabel(
    workspaceId: string,
    workspaces: Map<string, Workspace>,
    currentId: string,
    tabId?: string
): WorkspaceLabel {
    if (!workspaceId) {
        return null;
    }
    const ws = workspaces?.get(workspaceId);
    if (ws == null) {
        return {
            id: workspaceId,
            name: t("notif.workspace.deleted"),
            project: "",
            icon: "",
            color: "",
            logo: "",
            image: "",
            current: false,
            missing: true,
        };
    }
    const dir = readWorkspaceProject(ws).dir;
    const { logo, image } = workspaceIconSource(ws);
    const name = workspaceShownName(ws.name, t) || t("rail.unsavedWorkspace");
    const projectFolder = pathBaseName(dir);
    let project = projectFolder.toLowerCase() === name.toLowerCase() ? "" : projectFolder;
    // A notification of a view of another project names that project (#1760), not the one shown.
    const projects = readProjects(ws);
    const owner = tabId && projects.length > 1 ? projects.find((p) => p.id === tabProjectOf(ws, tabId)) : null;
    if (owner != null) {
        project = projectLabel(owner);
    }
    return {
        id: workspaceId,
        name,
        project,
        icon: ws.icon,
        color: ws.color,
        logo,
        image,
        current: workspaceId === currentId,
        missing: false,
    };
}

export function workspaceLabelText(label: WorkspaceLabel): string {
    return label.project ? `${label.name} · ${label.project}` : label.name;
}
