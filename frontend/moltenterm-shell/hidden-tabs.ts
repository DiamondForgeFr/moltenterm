// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Hidden tabs (#758, pkg/molten/hiddentabs.go): an agent the developer let work out of sight runs in a tab of the
// workspace that the tab bars and the tab-switch keys skip. Activating the tab (Go to, a notification, Show in
// Sessions) reveals it: wavesrv takes it out of the list.
//
// A workspace with two projects or more also keeps the views of the other projects out of sight (#1760,
// pkg/molten/projectviews): a temporary view belongs to the project it was opened in, and a project shows its own
// views, the pinned ones and the Project tab. The views of the other projects are not closed: their terminals and
// agents keep running.

// must match pkg/molten/hiddentabs.go
export const HiddenTabsMetaKey = "molten:hiddentabs";
// must match pkg/molten/projectviews/projectviews.go
export const TabProjectsMetaKey = "molten:tabprojects";
export const ActiveByProjectMetaKey = "molten:projectactivetab";
export const SlotsMetaKey = "molten:viewslots";
// must match readProjects and currentProjectId in sidebar/workspace-projects.ts, which this module cannot import
const ProjectsMetaKey = "molten:projects";
const CurrentProjectMetaKey = "molten:currentproject";

type WorkspaceLike = { tabids?: string[]; meta?: Record<string, any> };

export function hiddenTabIds(ws: { meta?: Record<string, any> }): string[] {
    const ids = ws?.meta?.[HiddenTabsMetaKey];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

function listedProjectIds(meta: Record<string, any>): string[] {
    const value = meta?.[ProjectsMetaKey];
    if (!Array.isArray(value)) {
        return [];
    }
    const ids: string[] = [];
    for (const item of value) {
        const id = typeof item?.id === "string" ? item.id.trim() : "";
        if (id !== "" && !ids.includes(id)) {
            ids.push(id);
        }
    }
    return ids;
}

// The id of the current project, or "" for a workspace with fewer than two projects, whose views are all shown.
export function currentProjectIdOf(ws: { meta?: Record<string, any> }): string {
    const ids = listedProjectIds(ws?.meta);
    if (ids.length < 2) {
        return "";
    }
    const wanted = ws.meta[CurrentProjectMetaKey];
    return ids.includes(wanted) ? wanted : ids[0];
}

// {tabId: projectId}: the project each temporary view belongs to. A view outside it, or mapped to a project the list no
// longer holds, belongs to every project.
export function tabProjectsOf(ws: { meta?: Record<string, any> }): Record<string, string> {
    const value = ws?.meta?.[TabProjectsMetaKey];
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const rtn: Record<string, string> = {};
    for (const [tabId, project] of Object.entries(value)) {
        if (typeof project === "string" && project !== "") {
            rtn[tabId] = project;
        }
    }
    return rtn;
}

// {tabId: slot}: the instances of one tile in the workspace's projects share a slot, which closes, renames and saves as
// one view (#1760).
export function tabSlotsOf(ws: { meta?: Record<string, any> }): Record<string, string> {
    const value = ws?.meta?.[SlotsMetaKey];
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const rtn: Record<string, string> = {};
    for (const [tabId, slot] of Object.entries(value)) {
        if (typeof slot === "string" && slot !== "") {
            rtn[tabId] = slot;
        }
    }
    return rtn;
}

// The tabs of a tile's slot in the workspace, the tab itself included; a tab without a slot is alone.
export function slotMembers(ws: WorkspaceLike, tabId: string): string[] {
    const slots = tabSlotsOf(ws);
    const slot = slots[tabId];
    if (slot == null) {
        return [tabId];
    }
    return (ws?.tabids ?? []).filter((id) => slots[id] === slot);
}

// The project that owns a tab: "" when every project shows it.
export function tabProjectOf(ws: { meta?: Record<string, any> }, tabId: string): string {
    const owner = tabProjectsOf(ws)[tabId] ?? "";
    return listedProjectIds(ws?.meta).includes(owner) ? owner : "";
}

// projectTabIds: the workspace's tabs the current project shows, hidden ones included, in order.
export function projectTabIds(ws: WorkspaceLike): string[] {
    const tabIds = ws?.tabids ?? [];
    const current = currentProjectIdOf(ws);
    if (current === "") {
        return tabIds;
    }
    const known = listedProjectIds(ws.meta);
    const owners = tabProjectsOf(ws);
    return tabIds.filter((id) => {
        const owner = owners[id];
        return owner == null || owner === current || !known.includes(owner);
    });
}

// visibleTabIds: the workspace's tabs a tab bar shows, in order: the current project's, without the hidden ones.
export function visibleTabIds(ws: WorkspaceLike): string[] {
    const tabIds = projectTabIds(ws);
    const hidden = hiddenTabIds(ws);
    if (hidden.length === 0) {
        return tabIds;
    }
    return tabIds.filter((id) => !hidden.includes(id));
}
