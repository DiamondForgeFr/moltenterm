// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The writes of the project bookmarks (FR-BRW-019, FR-BRW-021): each one reads the workspace as it is now, applies a
// pure change from bookmarks.ts and saves the key in one meta write, so the panel's menu and the settings card, which
// read the same meta, follow at once. wavesrv never writes them.

import { atoms, globalStore } from "@/app/store/global";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { readProjects } from "../sidebar/workspace-projects";
import { writeMeta } from "../sidebar/workspace-projects-store";
import {
    addBookmark,
    Bookmark,
    BookmarkDraft,
    BookmarkProblem,
    BookmarkResult,
    BookmarksMetaKey,
    copyBookmarkTo,
    createFolder,
    deleteBookmark,
    deleteFolder,
    findBookmarkByAddress,
    moveBookmark,
    ProjectBookmarks,
    readProjectBookmarks,
    renameFolder,
    updateBookmark,
    withProjectsBookmarks,
} from "./bookmarks";

export const SaveFailedProblem: BookmarkProblem = "browser.bookmarks.problem.notSaved";

export function activeWorkspaceNow(): Workspace {
    return globalStore.get(atoms.workspace);
}

function latestWorkspace(ws: Workspace): Workspace {
    return globalStore.get(getWaveObjectAtom<Workspace>(makeORef("workspace", ws.oid))) ?? ws;
}

type Read = (projectId: string) => ProjectBookmarks;
type Change = (read: Read) => BookmarkResult<Record<string, ProjectBookmarks>>;

// Applies a change to the workspace's latest bookmarks. The answer is the problem to tell, or null once saved.
export async function changeBookmarks(ws: Workspace, change: Change): Promise<BookmarkProblem> {
    const latest = latestWorkspace(ws);
    if (latest == null) {
        return SaveFailedProblem;
    }
    const known = readProjects(latest).map((p) => p.id);
    const result = change((id) => readProjectBookmarks(latest.meta, id));
    if (result.problem != null) {
        return result.problem;
    }
    const value = withProjectsBookmarks(latest.meta, result.value, known);
    try {
        await writeMeta(latest, { [BookmarksMetaKey]: value });
    } catch (e) {
        console.error("bookmarks: save failed", e);
        return SaveFailedProblem;
    }
    return null;
}

function inProject(projectId: string, mutate: (data: ProjectBookmarks) => BookmarkResult<ProjectBookmarks>): Change {
    return (read) => {
        const result = mutate(read(projectId));
        return result.problem != null ? { problem: result.problem } : { value: { [projectId]: result.value } };
    };
}

// Adds a bookmark to a project and, when asked, a copy to each of the other projects named in alsoTo (never otherwise).
export function addProjectBookmark(
    ws: Workspace,
    projectId: string,
    draft: BookmarkDraft,
    alsoTo: readonly string[] = []
): Promise<BookmarkProblem> {
    return changeBookmarks(ws, (read) => {
        const added = addBookmark(read(projectId), draft);
        if (added.problem != null) {
            return { problem: added.problem };
        }
        const updates: Record<string, ProjectBookmarks> = { [projectId]: added.value.data };
        for (const other of alsoTo) {
            if (other === projectId) {
                continue;
            }
            if (findBookmarkByAddress(read(other), added.value.bookmark.url) != null) {
                continue;
            }
            const copy = addBookmark(read(other), {
                url: added.value.bookmark.url,
                title: added.value.bookmark.title,
                description: added.value.bookmark.description,
                folder: "",
                newFolder: folderNameOf(added.value.data, added.value.bookmark),
            });
            if (copy.problem != null) {
                return { problem: copy.problem };
            }
            updates[other] = copy.value.data;
        }
        return { value: updates };
    });
}

function folderNameOf(data: ProjectBookmarks, bookmark: Bookmark): string {
    return data.folders.find((f) => f.id === bookmark.folder)?.name ?? "";
}

export function updateProjectBookmark(
    ws: Workspace,
    projectId: string,
    id: string,
    draft: BookmarkDraft
): Promise<BookmarkProblem> {
    return changeBookmarks(
        ws,
        inProject(projectId, (data) => updateBookmark(data, id, draft))
    );
}

export function moveProjectBookmark(
    ws: Workspace,
    projectId: string,
    id: string,
    folderId: string
): Promise<BookmarkProblem> {
    return changeBookmarks(
        ws,
        inProject(projectId, (data) => ({ value: moveBookmark(data, id, folderId) }))
    );
}

export function deleteProjectBookmark(ws: Workspace, projectId: string, id: string): Promise<BookmarkProblem> {
    return changeBookmarks(
        ws,
        inProject(projectId, (data) => ({ value: deleteBookmark(data, id) }))
    );
}

export function createProjectFolder(ws: Workspace, projectId: string, name: string): Promise<BookmarkProblem> {
    return changeBookmarks(
        ws,
        inProject(projectId, (data) => createFolder(data, name))
    );
}

export function renameProjectFolder(
    ws: Workspace,
    projectId: string,
    folderId: string,
    name: string
): Promise<BookmarkProblem> {
    return changeBookmarks(
        ws,
        inProject(projectId, (data) => renameFolder(data, folderId, name))
    );
}

export function deleteProjectFolder(ws: Workspace, projectId: string, folderId: string): Promise<BookmarkProblem> {
    return changeBookmarks(
        ws,
        inProject(projectId, (data) => ({ value: deleteFolder(data, folderId) }))
    );
}

// An independent copy in another project: the developer's explicit action, never done by itself.
export function copyProjectBookmark(
    ws: Workspace,
    fromProjectId: string,
    id: string,
    toProjectId: string
): Promise<BookmarkProblem> {
    return changeBookmarks(ws, (read) => {
        if (fromProjectId === toProjectId) {
            return { problem: "browser.bookmarks.problem.sameProject" };
        }
        const copied = copyBookmarkTo(read(fromProjectId), id, read(toProjectId));
        return copied.problem != null ? { problem: copied.problem } : { value: { [toProjectId]: copied.value } };
    });
}
