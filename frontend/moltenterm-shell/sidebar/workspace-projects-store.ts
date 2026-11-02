// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The writes of a workspace's projects (FR-SHELL-087): switch here, add, edit and remove in
// workspace-projects-edit-store.ts. A switch, a removal and the assignment after an addition go through wavesrv
// (pkg/molten/projectviews), which also decides the view the project shows and keeps every view running (#1760); the
// other writes are one meta write on the workspace, so every window and tab view follows at once.

import { atoms, globalStore } from "@/app/store/global";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { t } from "../i18n/i18n";
import { showToast } from "../toast-store";
import { projectLabel, readProjects, switchProjectUpdate } from "./workspace-projects";

const SwitchToastId = "workspace-project-switch";
const ProjectViewsTimeoutMs = 20000;

// must match pkg/molten/projectviews/route.go
export const ProjectViewsRoute = "molten:projectviews";
export const ProjectSwitchCommand = "moltenprojectswitch";
export const ProjectRemoveCommand = "moltenprojectremove";
export const ProjectAssignCommand = "moltenprojectassign";

export function activeWorkspace(): Workspace {
    return globalStore.get(atoms.workspace);
}

export function writeMeta(ws: Workspace, update: Record<string, any>): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("workspace", ws.oid), meta: update as MetaType });
}

export function callProjectViews(command: string, data: Record<string, any>): Promise<{ tabid?: string }> {
    return TabRpcClient.wshRpcCall(command, data, { route: ProjectViewsRoute, timeout: ProjectViewsTimeoutMs });
}

export async function switchWorkspaceProject(id: string): Promise<void> {
    const ws = activeWorkspace();
    if (ws == null || switchProjectUpdate(ws, id) == null) {
        return;
    }
    await callProjectViews(ProjectSwitchCommand, { workspaceid: ws.oid, projectid: id });
    const project = readProjects(ws).find((p) => p.id === id);
    showToast({
        id: SwitchToastId,
        kind: "info",
        title: t("sidebar.project.switched", { project: projectLabel(project) }),
        message: t("sidebar.project.switchedHint"),
    });
}
