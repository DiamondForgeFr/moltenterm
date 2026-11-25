// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A view made from a panel (FR-SHELL-080, #2548): where it can go, which of the sidebar's zones a drag is over, what the
// menu offers and what the notice says. Kept apart from the components so the rules are tested without the app.
//
// Three destinations follow the hierarchy: the Transversal views of the context (the top row), the Important views of
// the workspace (the tiles) and the Views of a project (the list, with its folders). Folders exist only among a
// project's Views.

import { dropTargetAt } from "./sidebar-model";
import { folderCandidateAt, RowSlot, shownFolders, ViewFolder } from "./view-folders-model";

// before: the id the new view lands before (a pin's in the top row, a tab's elsewhere); null or none: at the end.
export type PanelViewDestination =
    | { kind: "pinned"; before?: string }
    | { kind: "workspace"; before?: string }
    | { kind: "views"; projectId?: string; folderId?: string; before?: string };

export type PanelViewDestinationKind = PanelViewDestination["kind"];

// The sidebar's sections a panel can be dropped on; "project" is another project's zone, drawn while a panel is dragged.
export type PanelZone = "top" | "tiles" | "temporary" | "project";

// What a panel dragged over the sidebar is over: the section, and where in it.
export type PanelHit = {
    zone: PanelZone;
    // top and tiles: the block under the pointer and its side, for the mark.
    key?: string;
    after?: boolean;
    stacked?: boolean;
    // The id the view lands before; null at the end of the section.
    before?: string;
    // temporary: the folder whose row the pointer is on, and the row's key.
    folderId?: string;
    // project: the other project the zone stands for.
    projectId?: string;
};

export function sameHit(a: PanelHit, b: PanelHit): boolean {
    if (a == null || b == null) {
        return a === b;
    }
    return (
        a.zone === b.zone &&
        (a.key ?? null) === (b.key ?? null) &&
        !!a.after === !!b.after &&
        !!a.stacked === !!b.stacked &&
        (a.before ?? null) === (b.before ?? null) &&
        (a.folderId ?? null) === (b.folderId ?? null) &&
        (a.projectId ?? null) === (b.projectId ?? null)
    );
}

// The id a block dropped beside the one under the pointer lands before: that block itself, or the one after it. A pointer
// on no block, or on one the order does not hold, drops at the end.
export function landsBefore(order: readonly string[], key: string, after: boolean): string {
    const at = key == null ? -1 : order.indexOf(key);
    if (at < 0) {
        return null;
    }
    return after ? (order[at + 1] ?? null) : order[at];
}

// A pointer past the last block of a row, or in an empty part of the zone, marks the end of the section: the mark sits
// after the last block.
export function endMark(order: readonly string[]): { key: string; after: boolean } {
    return order.length === 0 ? { key: null, after: false } : { key: order[order.length - 1], after: true };
}

// The Views list's rows under a pointer at y: the folder whose row's middle it is in (the view goes into it), else the
// row it lands before (null: after the last row). A row's key is "tab:<id>" or "folder:<id>".
export type ListHit = { before: string; folderKey: string };

export function listHitAt(y: number, slots: readonly RowSlot[]): ListHit {
    const folders = slots.filter((s) => s.key.startsWith("folder:"));
    const folderKey = folderCandidateAt(y, folders, null);
    if (folderKey != null) {
        return { before: null, folderKey };
    }
    return {
        before: dropTargetAt(
            y,
            slots.map((s) => ({ id: s.key, top: s.top, height: s.height }))
        ),
        folderKey: null,
    };
}

// The destination a hit stands for. projectId is set only when the workspace has two projects or more, so that a view
// made for another project says which; null for a hit that is not on a drop zone.
export function destinationOfHit(hit: PanelHit, currentProjectId: string, projectsMany: boolean): PanelViewDestination {
    if (hit == null) {
        return null;
    }
    if (hit.zone === "top") {
        return { kind: "pinned", before: hit.before ?? undefined };
    }
    if (hit.zone === "tiles") {
        return { kind: "workspace", before: hit.before ?? undefined };
    }
    if (hit.zone === "project") {
        return hit.projectId ? { kind: "views", projectId: hit.projectId } : null;
    }
    const projectId = projectsMany ? currentProjectId || undefined : undefined;
    if (hit.folderId != null) {
        return { kind: "views", projectId, folderId: hit.folderId };
    }
    return { kind: "views", projectId, before: hit.before ?? undefined };
}

// Everything a sentence about a destination names.
export type PanelViewNames = {
    context: string;
    workspace: string;
    // A workspace with no linked project names none: its Views list is just Views.
    projectOf: (projectId: string) => string;
    folderName: (folderId: string) => string;
};

export type Phrase = { key: string; vars: Record<string, string> };

// The sentence a lit zone shows while a panel is dragged over the sidebar.
export function captionOf(dest: PanelViewDestination, names: PanelViewNames): Phrase {
    if (dest.kind === "pinned") {
        return { key: "sidebar.panelView.captionPinned", vars: { context: names.context } };
    }
    if (dest.kind === "workspace") {
        return { key: "sidebar.panelView.captionWorkspace", vars: { workspace: names.workspace } };
    }
    if (dest.folderId != null) {
        return { key: "sidebar.panelView.captionFolder", vars: { name: names.folderName(dest.folderId) } };
    }
    const project = names.projectOf(dest.projectId ?? "");
    return project
        ? { key: "sidebar.panelView.captionProject", vars: { project } }
        : { key: "sidebar.panelView.captionViews", vars: {} };
}

// The notice that says where the view was made.
export function noticeOf(dest: PanelViewDestination, name: string, names: PanelViewNames): Phrase {
    if (dest.kind === "pinned") {
        return { key: "sidebar.panelView.createdPinned", vars: { name, context: names.context } };
    }
    if (dest.kind === "workspace") {
        return { key: "sidebar.panelView.createdWorkspace", vars: { name, workspace: names.workspace } };
    }
    if (dest.folderId != null) {
        return { key: "sidebar.panelView.createdFolder", vars: { name, folder: names.folderName(dest.folderId) } };
    }
    const project = names.projectOf(dest.projectId ?? "");
    return project
        ? { key: "sidebar.panelView.createdProject", vars: { name, project } }
        : { key: "sidebar.panelView.createdViews", vars: { name } };
}

// A panel that holds an agent cannot live in two places: creating a view from it asks before anything moves.
export function asksBeforeMoving(agent: boolean): boolean {
    return agent === true;
}

export type AgentAnswer = "move" | "stay";

// What the answer to the question does: the panel itself moves into the new view, or the new view gets an empty agent
// slot and the agent stays where it is. No answer: nothing is made.
export function agentPlan(answer: AgentAnswer): { move: boolean; make: boolean } {
    if (answer === "move") {
        return { move: true, make: true };
    }
    if (answer === "stay") {
        return { move: false, make: true };
    }
    return { move: false, make: false };
}

// A project the menu and the zones name.
export type PanelViewProject = { id: string; label: string };

export type PanelViewFolder = { id: string; name: string };

// The folders of a project's Views the menu offers: the ones the list shows (a folder left with a single view of the
// project is not shown, view-folders-model.ts). visible: the project's Views, in order.
export function foldersOfViews(visible: readonly string[], folders: readonly ViewFolder[]): ViewFolder[] {
    return shownFolders(visible, folders);
}

// One entry of the panel's menu: a destination, or a project with its Views and its folders under it.
export type PanelViewEntry = {
    id: string;
    labelKey: string;
    vars: Record<string, string>;
    icon: string;
    destination?: PanelViewDestination;
    children?: PanelViewEntry[];
};

export type PanelViewMenuFacts = {
    contextName: string;
    workspaceName: string;
    // The workspace's linked projects, in order; none for a workspace without one.
    projects: PanelViewProject[];
    currentProjectId: string;
    // The folders of a project's Views (the project's id; "" for a workspace with no project).
    foldersOf: (projectId: string) => PanelViewFolder[];
};

// "Create a view with this panel": one entry per destination, in the order of the hierarchy. A project with folders
// opens a submenu (its Views, then its folders); a project without any is one entry. Folders are offered here and never
// for the context or the workspace.
export function panelViewEntries(facts: PanelViewMenuFacts): PanelViewEntry[] {
    const entries: PanelViewEntry[] = [
        {
            id: "pinned",
            labelKey: "sidebar.panelView.pinned",
            vars: { context: facts.contextName },
            icon: "thumbtack",
            destination: { kind: "pinned" },
        },
        {
            id: "workspace",
            labelKey: "sidebar.panelView.workspace",
            vars: { workspace: facts.workspaceName },
            icon: "table-cells-large",
            destination: { kind: "workspace" },
        },
    ];
    const many = facts.projects.length > 1;
    if (facts.projects.length === 0) {
        const folders = facts.foldersOf("");
        entries.push(projectEntry("views", "sidebar.panelView.views", {}, undefined, folders, false));
        return entries;
    }
    for (const project of facts.projects) {
        const projectId = many ? project.id : undefined;
        entries.push(
            projectEntry(
                `project:${project.id}`,
                "sidebar.panelView.project",
                { project: project.label },
                projectId,
                facts.foldersOf(project.id),
                true
            )
        );
    }
    return entries;
}

function projectEntry(
    id: string,
    labelKey: string,
    vars: Record<string, string>,
    projectId: string,
    folders: PanelViewFolder[],
    named: boolean
): PanelViewEntry {
    const destination: PanelViewDestination = { kind: "views", projectId };
    const entry: PanelViewEntry = { id, labelKey, vars, icon: "folder-tree", destination };
    if (folders.length === 0) {
        return entry;
    }
    return {
        id,
        labelKey,
        vars,
        icon: entry.icon,
        children: [
            {
                id: `${id}:views`,
                labelKey: named ? "sidebar.panelView.projectViews" : "sidebar.panelView.views",
                vars: {},
                icon: "list",
                destination,
            },
            ...folders.map((f) => ({
                id: `${id}:folder:${f.id}`,
                labelKey: "sidebar.panelView.folder",
                vars: { name: f.name },
                icon: "folder",
                destination: { kind: "views", projectId, folderId: f.id } as PanelViewDestination,
            })),
        ],
    };
}

// Whether a destination offers a folder: only among a project's Views.
export function destinationHasFolder(dest: PanelViewDestination): boolean {
    return dest.kind === "views" && dest.folderId != null;
}

// Every destination the entries lead to, flat, for what checks them all.
export function entryDestinations(entries: readonly PanelViewEntry[]): PanelViewDestination[] {
    return entries.flatMap((e) => [
        ...(e.destination != null ? [e.destination] : []),
        ...entryDestinations(e.children ?? []),
    ]);
}
