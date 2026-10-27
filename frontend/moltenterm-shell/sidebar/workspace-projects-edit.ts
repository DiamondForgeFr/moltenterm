// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The rules of adding, editing and removing a workspace's projects (FR-SHELL-087). Apart from workspace-projects.ts so
// only the project page, loaded on demand, carries them (NFR-PERF-003, bundle.initialJsMB).

import { ProjectTypeMetaKey } from "./sidebar-model";
import {
    currentProjectId,
    CurrentProjectMetaKey,
    listValue,
    liveUpdate,
    ProjectDraft,
    ProjectsMetaKey,
    readProjects,
    str,
    WorkspaceProjectEntry,
} from "./workspace-projects";

export const ProjectTypeMaxLength = 40;

// The type suggestions, from a translated comma-separated list.
export function projectTypeSuggestions(list: string): string[] {
    return (list ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
}

export function nextProjectId(projects: readonly WorkspaceProjectEntry[]): string {
    const ids = new Set(projects.map((p) => p.id));
    for (let n = projects.length + 1; ; n++) {
        const id = `p${n}`;
        if (!ids.has(id)) {
            return id;
        }
    }
}

function sameDir(a: string, b: string): boolean {
    const trim = (p: string) => (p ?? "").replace(/[/\\]+$/, "");
    return a !== "" && b !== "" && trim(a) === trim(b);
}

// Why a draft cannot be saved, as an i18n key, or null. A project needs a type or a folder, and a folder is one
// project of the workspace at most.
export function projectDraftProblem(
    ws: { meta?: Record<string, any> },
    draft: ProjectDraft,
    editingId?: string
): string {
    const type = str(draft?.type);
    const dir = str(draft?.dir);
    if (type === "" && dir === "") {
        return "sidebar.project.needTypeOrFolder";
    }
    if (type.length > ProjectTypeMaxLength) {
        return "sidebar.project.typeTooLong";
    }
    if (readProjects(ws).some((p) => p.id !== editingId && sameDir(p.dir, dir))) {
        return "sidebar.project.folderTaken";
    }
    return null;
}

// The meta that adds a project. The first project of a workspace becomes its current one; a later one waits to be
// chosen (Pilotage follows it at once).
export function addProjectUpdate(
    ws: { meta?: Record<string, any> },
    draft: ProjectDraft
): { id: string; update: Record<string, any> } {
    const projects = readProjects(ws);
    const project: WorkspaceProjectEntry = {
        id: nextProjectId(projects),
        type: str(draft.type),
        dir: str(draft.dir),
        branch: str(draft.branch),
    };
    const next = [...projects, project];
    if (projects.length === 0) {
        return { id: project.id, update: { [ProjectsMetaKey]: listValue(next), ...liveUpdate(project) } };
    }
    return {
        id: project.id,
        update: { [ProjectsMetaKey]: listValue(next), [CurrentProjectMetaKey]: currentProjectId(ws) },
    };
}

// The meta that changes a project's type, folder or branch; the current one's folder and type go to the live keys.
export function editProjectUpdate(
    ws: { meta?: Record<string, any> },
    id: string,
    draft: ProjectDraft
): Record<string, any> {
    const projects = readProjects(ws);
    const at = projects.findIndex((p) => p.id === id);
    if (at < 0) {
        return null;
    }
    const edited: WorkspaceProjectEntry = { id, type: str(draft.type), dir: str(draft.dir), branch: str(draft.branch) };
    const next = projects.map((p, i) => (i === at ? edited : p));
    const update: Record<string, any> = { [ProjectsMetaKey]: listValue(next) };
    if (id !== currentProjectId(ws)) {
        return update;
    }
    update[CurrentProjectMetaKey] = id;
    update[ProjectTypeMetaKey] = edited.type || null;
    if (!sameDir(projects[at].dir, edited.dir)) {
        Object.assign(update, liveUpdate(edited));
    }
    return update;
}

// The meta that takes a project out of the workspace: only from two projects, nothing is written in the project's
// folder. The current one hands over to the first project left.
export function removeProjectUpdate(ws: { meta?: Record<string, any> }, id: string): Record<string, any> {
    const projects = readProjects(ws);
    if (projects.length < 2 || !projects.some((p) => p.id === id)) {
        return null;
    }
    const next = projects.filter((p) => p.id !== id);
    const update: Record<string, any> = { [ProjectsMetaKey]: listValue(next) };
    if (id !== currentProjectId(ws)) {
        return update;
    }
    return { ...update, ...liveUpdate(next[0]) };
}
