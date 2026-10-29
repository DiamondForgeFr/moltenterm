// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The writes that add, edit and remove a workspace's projects (FR-SHELL-087). Apart from workspace-projects-store.ts so
// only the project page, loaded on demand, carries them (NFR-PERF-003, bundle.initialJsMB).

import { t } from "../i18n/i18n";
import { showToast } from "../toast-store";
import { ProjectDraft, projectLabel } from "./workspace-projects";
import { addProjectUpdate, editProjectUpdate, removeProjectUpdate } from "./workspace-projects-edit";
import { activeWorkspace, writeMeta } from "./workspace-projects-store";

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

// ws defaults to the window's workspace; the Project sheet (FR-SHELL-105) passes the one it edits.
export async function editWorkspaceProject(id: string, draft: ProjectDraft, ws = activeWorkspace()): Promise<void> {
    const update = ws == null ? null : editProjectUpdate(ws, id, draft);
    if (update == null) {
        return;
    }
    await writeMeta(ws, update);
}

export async function removeWorkspaceProject(id: string, ws = activeWorkspace()): Promise<void> {
    const update = ws == null ? null : removeProjectUpdate(ws, id);
    if (update == null) {
        return;
    }
    await writeMeta(ws, update);
}
