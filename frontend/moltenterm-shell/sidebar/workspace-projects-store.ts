// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The writes of a workspace's projects (FR-SHELL-087): switch, add, edit and remove, each one meta write on the
// workspace, so every window and tab view follows at once.

import { atoms, globalStore } from "@/app/store/global";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { t } from "../i18n/i18n";
import { showToast } from "../toast-store";
import {
    addProjectUpdate,
    editProjectUpdate,
    ProjectDraft,
    projectLabel,
    readProjects,
    removeProjectUpdate,
    switchProjectUpdate,
} from "./workspace-projects";

const SwitchToastId = "workspace-project-switch";

function activeWorkspace(): Workspace {
    return globalStore.get(atoms.workspace);
}

function writeMeta(ws: Workspace, update: Record<string, any>): Promise<void> {
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

export async function addWorkspaceProject(draft: ProjectDraft): Promise<void> {
    const ws = activeWorkspace();
    if (ws == null) {
        return;
    }
    const { update } = addProjectUpdate(ws, draft);
    await writeMeta(ws, update);
    showToast({
        kind: "success",
        title: t("sidebar.project.added", {
            project: projectLabel({ id: "", type: draft.type.trim(), dir: draft.dir.trim(), branch: "" }),
        }),
        message: t("sidebar.project.addedHint"),
    });
}

export async function editWorkspaceProject(id: string, draft: ProjectDraft): Promise<void> {
    const ws = activeWorkspace();
    const update = ws == null ? null : editProjectUpdate(ws, id, draft);
    if (update == null) {
        return;
    }
    await writeMeta(ws, update);
}

export async function removeWorkspaceProject(id: string): Promise<void> {
    const ws = activeWorkspace();
    const update = ws == null ? null : removeProjectUpdate(ws, id);
    if (update == null) {
        return;
    }
    await writeMeta(ws, update);
}
