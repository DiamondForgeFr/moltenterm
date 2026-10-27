// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A workspace is a product made of typed projects (FR-SHELL-087): Desktop, Mobile, Website… each a repository. The
// list lives in the workspace's meta; the current project keeps living in the keys every reader already follows
// (molten:project, molten:projecttype), so Mission Control, the Project panel, Pilotage and the folder new terminals
// and agents start in follow the current project unchanged. A workspace without the list reads as one project made of
// those keys. Kept apart from the components so the rules can be tested without the app.

import { pathBaseName, ProjectLogoOfferMetaKey, ProjectMetaKey, WorkspaceFolderMetaKey } from "../workspace-project";
import { ProjectTypeMetaKey } from "./sidebar-model";

// must match pkg/molten/mission/projects_migrate.go
export const ProjectsMetaKey = "molten:projects";
export const CurrentProjectMetaKey = "molten:currentproject";
// The id the one project of a workspace without a list gets.
export const FirstProjectId = "p1";
export const ProjectTypeMaxLength = 40;

export type WorkspaceProjectEntry = { id: string; type: string; dir: string; branch: string };

export type ProjectDraft = { type: string; dir: string; branch: string };

// The type suggestions, from a translated comma-separated list.
export function projectTypeSuggestions(list: string): string[] {
    return (list ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
}

function str(value: any): string {
    return typeof value === "string" ? value.trim() : "";
}

function storedProjects(meta: Record<string, any>): WorkspaceProjectEntry[] {
    const value = meta?.[ProjectsMetaKey];
    if (!Array.isArray(value)) {
        return null;
    }
    const seen = new Set<string>();
    const rtn: WorkspaceProjectEntry[] = [];
    for (const item of value) {
        const id = str(item?.id);
        if (id === "" || seen.has(id)) {
            continue;
        }
        seen.add(id);
        rtn.push({ id, type: str(item?.type), dir: str(item?.dir), branch: str(item?.branch) });
    }
    return rtn.length > 0 ? rtn : null;
}

function liveCurrent(meta: Record<string, any>): { type: string; dir: string } {
    return { type: str(meta?.[ProjectTypeMetaKey]), dir: str(meta?.[ProjectMetaKey]) };
}

// The id of the current project: the stored one when the list holds it, else the first project.
export function currentProjectId(ws: { meta?: Record<string, any> }): string {
    const projects = readProjects(ws);
    if (projects.length === 0) {
        return null;
    }
    const id = str(ws?.meta?.[CurrentProjectMetaKey]);
    return projects.some((p) => p.id === id) ? id : projects[0].id;
}

// The workspace's projects in order. The current one takes its folder and type from the live keys, which the
// workspace editor, the new-workspace page and `molten project link` write.
export function readProjects(ws: { meta?: Record<string, any> }): WorkspaceProjectEntry[] {
    const meta = ws?.meta;
    const live = liveCurrent(meta);
    const stored = storedProjects(meta);
    if (stored == null) {
        if (live.dir === "" && live.type === "") {
            return [];
        }
        return [{ id: FirstProjectId, type: live.type, dir: live.dir, branch: "" }];
    }
    const wanted = str(meta?.[CurrentProjectMetaKey]);
    const currentId = stored.some((p) => p.id === wanted) ? wanted : stored[0].id;
    return stored.map((p) => (p.id === currentId ? { ...p, type: live.type, dir: live.dir } : p));
}

export function currentProject(ws: { meta?: Record<string, any> }): WorkspaceProjectEntry {
    const id = currentProjectId(ws);
    return readProjects(ws).find((p) => p.id === id) ?? null;
}

// What a project is called: its type; a project without one by its folder's name. The product's name is never
// repeated as a project's name.
export function projectLabel(project: WorkspaceProjectEntry): string {
    if (project == null) {
        return "";
    }
    return project.type || pathBaseName(project.dir);
}

// "Desktop · main": the label and the branch it follows, when one is set.
export function projectChipLabel(project: WorkspaceProjectEntry): string {
    const label = projectLabel(project);
    return project?.branch ? `${label} · ${project.branch}` : label;
}

function listValue(projects: WorkspaceProjectEntry[]): Record<string, string>[] {
    return projects.map((p) => {
        const value: Record<string, string> = { id: p.id, type: p.type, dir: p.dir };
        if (p.branch) {
            value.branch = p.branch;
        }
        return value;
    });
}

function liveUpdate(project: WorkspaceProjectEntry): Record<string, any> {
    return {
        [CurrentProjectMetaKey]: project.id,
        [ProjectMetaKey]: project.dir || null,
        [ProjectTypeMetaKey]: project.type || null,
        // New terminals and agents start in the project's root, not in a folder of the project left.
        [WorkspaceFolderMetaKey]: project.dir || null,
        // The logo stands for the product: switching projects never offers another one.
        [ProjectLogoOfferMetaKey]: project.dir || null,
    };
}

// The meta that makes another project current, or null when it already is or does not exist.
export function switchProjectUpdate(ws: { meta?: Record<string, any> }, id: string): Record<string, any> {
    const projects = readProjects(ws);
    const target = projects.find((p) => p.id === id);
    if (target == null || id === currentProjectId(ws)) {
        return null;
    }
    return { [ProjectsMetaKey]: listValue(projects), ...liveUpdate(target) };
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
export function editProjectUpdate(ws: { meta?: Record<string, any> }, id: string, draft: ProjectDraft): Record<string, any> {
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
