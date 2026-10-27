// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The writes of a workspace's projects (FR-SHELL-087): switch here, add, edit and remove in
// workspace-projects-edit-store.ts, each one meta write on the workspace, so every window and tab view follows at once.

import { atoms, globalStore } from "@/app/store/global";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { t } from "../i18n/i18n";
import { showToast } from "../toast-store";
import { projectLabel, readProjects, switchProjectUpdate } from "./workspace-projects";

const SwitchToastId = "workspace-project-switch";

export function activeWorkspace(): Workspace {
    return globalStore.get(atoms.workspace);
}

export function writeMeta(ws: Workspace, update: Record<string, any>): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("workspace", ws.oid), meta: update as MetaType });
}

export async function switchWorkspaceProject(id: string): Promise<void> {
    const ws = activeWorkspace();
    const update = switchProjectUpdate(ws, id);
    if (ws == null || update == null) {
        return;
    }
    await writeMeta(ws, update);
    const project = readProjects(ws).find((p) => p.id === id);
    showToast({
        id: SwitchToastId,
        kind: "info",
        title: t("sidebar.project.switched", { project: projectLabel(project) }),
        message: t("sidebar.project.switchedHint"),
    });
}
