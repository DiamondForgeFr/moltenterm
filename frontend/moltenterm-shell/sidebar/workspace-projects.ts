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

export type WorkspaceProjectEntry = { id: string; type: string; dir: string; branch: string };

export type ProjectDraft = { type: string; dir: string; branch: string };

export function str(value: any): string {
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

export function listValue(projects: WorkspaceProjectEntry[]): Record<string, string>[] {
    return projects.map((p) => {
        const value: Record<string, string> = { id: p.id, type: p.type, dir: p.dir };
        if (p.branch) {
            value.branch = p.branch;
        }
        return value;
    });
}

export function liveUpdate(project: WorkspaceProjectEntry): Record<string, any> {
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
