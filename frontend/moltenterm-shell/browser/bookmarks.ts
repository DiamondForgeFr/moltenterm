// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The bookmarks of the web page panel, kept per project (FR-BRW-019, DS-BRW-026). They live in the workspace's meta
// under one key, {projectId: {folders: [{id, name}], items: [{id, url, title, description, folder}]}}, next to the
// project list and keyed by its ids, so a bookmark belongs to one project and goes with it. A bookmark sits directly in
// the project (folder "") or in one folder; folders do not nest. Everything here is pure: the store reads the workspace
// and writes the answers, wavesrv reads the same value for `molten bookmarks list` (pkg/molten/bookmarks).

import { currentProjectId, readProjects } from "../sidebar/workspace-projects";
import { looksLikeAddress, toBrowserUrl } from "./browser-model";

// must match BookmarksMetaKey in pkg/molten/agentbookmarks.go
export const BookmarksMetaKey = "molten:bookmarks";
// Workspace meta {tabId: projectId}, written once the workspace has two projects. must match
// TabProjectsMetaKey in pkg/molten/projectviews
export const TabProjectsMetaKey = "molten:tabprojects";

export const BookmarkLimits = {
    items: 300,
    folders: 50,
    title: 200,
    url: 2048,
    description: 1000,
    folderName: 60,
};

export type BookmarkFolder = { id: string; name: string };
export type Bookmark = { id: string; url: string; title: string; description: string; folder: string };
export type ProjectBookmarks = { folders: BookmarkFolder[]; items: Bookmark[] };
export type AllBookmarks = Record<string, ProjectBookmarks>;

// What the dialog collects: the folder is an existing folder's id, "" for the project itself, and newFolder (a name)
// replaces it when the bookmark goes in a folder that does not exist yet.
export type BookmarkDraft = { url: string; title: string; description: string; folder: string; newFolder?: string };

// A problem is an i18n key, so the component says it in the current language.
export type BookmarkProblem = string;
export type BookmarkResult<T> = { value: T; problem?: undefined } | { value?: undefined; problem: BookmarkProblem };

// The numbers a problem's text names.
export function problemVars(problem: BookmarkProblem): Record<string, number> {
    switch (problem) {
        case "browser.bookmarks.problem.addressTooLong":
            return { max: BookmarkLimits.url };
        case "browser.bookmarks.problem.tooMany":
            return { max: BookmarkLimits.items };
        case "browser.bookmarks.problem.tooManyFolders":
            return { max: BookmarkLimits.folders };
        case "browser.bookmarks.problem.titleTooLong":
            return { max: BookmarkLimits.title };
        case "browser.bookmarks.problem.descriptionTooLong":
            return { max: BookmarkLimits.description };
        case "browser.bookmarks.problem.folderNameTooLong":
            return { max: BookmarkLimits.folderName };
        default:
            return {};
    }
}

export type IdMaker = (prefix: "b" | "f") => string;

export function makeBookmarkId(prefix: "b" | "f"): string {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export const EmptyProjectBookmarks: ProjectBookmarks = { folders: [], items: [] };

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

// Removes control characters, which a title, a note or a folder name never needs and a terminal would act on.
export function plainText(value: string): string {
    // eslint-disable-next-line no-control-regex
    return (value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

// A title, an address or a folder name is one line.
export function singleLine(value: string): string {
    return plainText(value).replace(/\s+/g, " ");
}

// A scheme followed by // (ftp://, file://, vscode://), and the schemes that need no //.
const OtherSchemeRe = /^[a-z][a-z0-9+.-]*:\/\//i;
const BareSchemeRe = /^(about|file|data|javascript|mailto|blob|view-source|tel):/i;

export function readProjectBookmarks(meta: Record<string, any>, projectId: string): ProjectBookmarks {
    const all = meta?.[BookmarksMetaKey];
    const entry = all != null && typeof all === "object" ? all[projectId] : null;
    if (entry == null || typeof entry !== "object") {
        return EmptyProjectBookmarks;
    }
    const folders: BookmarkFolder[] = [];
    const folderIds = new Set<string>();
    for (const f of Array.isArray(entry.folders) ? entry.folders : []) {
        const id = text(f?.id);
        const name = text(f?.name);
        if (id === "" || name === "" || folderIds.has(id)) {
            continue;
        }
        folderIds.add(id);
        folders.push({ id, name });
    }
    const items: Bookmark[] = [];
    const itemIds = new Set<string>();
    for (const b of Array.isArray(entry.items) ? entry.items : []) {
        const id = text(b?.id);
        const url = text(b?.url);
        if (id === "" || url === "" || itemIds.has(id)) {
            continue;
        }
        itemIds.add(id);
        const folder = text(b?.folder);
        items.push({
            id,
            url,
            title: text(b?.title) || url,
            description: text(b?.description),
            folder: folderIds.has(folder) ? folder : "",
        });
    }
    return { folders, items };
}

export function bookmarksOfFolder(data: ProjectBookmarks, folderId: string): Bookmark[] {
    return data.items.filter((b) => b.folder === folderId);
}

export function folderName(data: ProjectBookmarks, folderId: string): string {
    return data.folders.find((f) => f.id === folderId)?.name ?? "";
}

export function bookmarkCount(data: ProjectBookmarks): number {
    return data.items.length;
}

// The project a panel's tab belongs to: its owner in the workspace's tab map, else the current project (as wavesrv
// answers `molten bookmarks list`, pkg/molten/bookmarks.ProjectOf). null for a workspace without a project.
export function projectIdOfTab(ws: { meta?: Record<string, any> }, tabId: string): string {
    const projects = readProjects(ws);
    if (projects.length === 0) {
        return null;
    }
    const owner = text(ws?.meta?.[TabProjectsMetaKey]?.[tabId]);
    if (owner !== "" && projects.some((p) => p.id === owner)) {
        return owner;
    }
    return currentProjectId(ws);
}

// The address a bookmark keeps: what was typed, with a scheme when it had none (http for a local server), or the
// problem. Only web addresses, and none that carries a user name or a password.
export function bookmarkAddress(raw: string): BookmarkResult<string> {
    const typed = singleLine(raw);
    if (typed === "") {
        return { problem: "browser.bookmarks.problem.noAddress" };
    }
    if (!/^https?:\/\//i.test(typed) && (OtherSchemeRe.test(typed) || BareSchemeRe.test(typed))) {
        return { problem: "browser.bookmarks.problem.notWeb" };
    }
    const full = /^https?:\/\//i.test(typed) ? typed : looksLikeAddress(typed) ? toBrowserUrl(typed, "") : null;
    if (full == null) {
        return { problem: "browser.bookmarks.problem.notAddress" };
    }
    let parsed: URL;
    try {
        parsed = new URL(full);
    } catch {
        return { problem: "browser.bookmarks.problem.notAddress" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { problem: "browser.bookmarks.problem.notWeb" };
    }
    if (parsed.hostname === "") {
        return { problem: "browser.bookmarks.problem.notAddress" };
    }
    if (parsed.username !== "" || parsed.password !== "") {
        return { problem: "browser.bookmarks.problem.credentials" };
    }
    if (parsed.href.length > BookmarkLimits.url) {
        return { problem: "browser.bookmarks.problem.addressTooLong" };
    }
    return { value: parsed.href };
}

// The address of the page a panel shows when it can be bookmarked (a web page, not the start page or a blank one), else
// "".
export function bookmarkablePage(url: string): string {
    return bookmarkAddress(url ?? "").value ?? "";
}

// Two addresses are the same page for a bookmark when only a fragment or a lone trailing slash differs.
export function sameBookmarkAddress(a: string, b: string): boolean {
    const key = (url: string) => {
        try {
            const u = new URL(url);
            u.hash = "";
            return u.href.replace(/\/$/, "");
        } catch {
            return (url ?? "").trim();
        }
    };
    return key(a) !== "" && key(a) === key(b);
}

export function findBookmarkByAddress(data: ProjectBookmarks, url: string): Bookmark {
    return data.items.find((b) => sameBookmarkAddress(b.url, url)) ?? null;
}

function hostTitle(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

function findFolderByName(data: ProjectBookmarks, name: string): BookmarkFolder {
    const wanted = name.trim().toLowerCase();
    return data.folders.find((f) => f.name.toLowerCase() === wanted) ?? null;
}

export function folderNameProblem(data: ProjectBookmarks, name: string, exceptId?: string): BookmarkProblem {
    const clean = singleLine(name);
    if (clean === "") {
        return "browser.bookmarks.problem.noFolderName";
    }
    if (clean.length > BookmarkLimits.folderName) {
        return "browser.bookmarks.problem.folderNameTooLong";
    }
    const taken = findFolderByName(data, clean);
    if (taken != null && taken.id !== exceptId) {
        return "browser.bookmarks.problem.folderTaken";
    }
    return null;
}

export function createFolder(
    data: ProjectBookmarks,
    name: string,
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<ProjectBookmarks> {
    const clean = singleLine(name);
    const problem = folderNameProblem(data, clean);
    if (problem != null) {
        return { problem };
    }
    if (data.folders.length >= BookmarkLimits.folders) {
        return { problem: "browser.bookmarks.problem.tooManyFolders" };
    }
    return { value: { ...data, folders: [...data.folders, { id: makeId("f"), name: clean }] } };
}

// The folder a draft names: an existing one, or one created by name (an existing folder of that name is reused).
function folderForDraft(
    data: ProjectBookmarks,
    draft: BookmarkDraft,
    makeId: IdMaker
): BookmarkResult<{ data: ProjectBookmarks; folder: string }> {
    const newName = singleLine(draft.newFolder ?? "");
    if (newName === "") {
        const known = data.folders.some((f) => f.id === draft.folder);
        return { value: { data, folder: known ? draft.folder : "" } };
    }
    const existing = findFolderByName(data, newName);
    if (existing != null) {
        return { value: { data, folder: existing.id } };
    }
    const created = createFolder(data, newName, makeId);
    if (created.problem != null) {
        return { problem: created.problem };
    }
    const folders = created.value.folders;
    return { value: { data: created.value, folder: folders[folders.length - 1].id } };
}

type Checked = { url: string; title: string; description: string };

function checkDraft(draft: BookmarkDraft): BookmarkResult<Checked> {
    const address = bookmarkAddress(draft.url);
    if (address.problem != null) {
        return { problem: address.problem };
    }
    const title = singleLine(draft.title) || hostTitle(address.value);
    if (title.length > BookmarkLimits.title) {
        return { problem: "browser.bookmarks.problem.titleTooLong" };
    }
    const description = plainText(draft.description);
    if (description.length > BookmarkLimits.description) {
        return { problem: "browser.bookmarks.problem.descriptionTooLong" };
    }
    return { value: { url: address.value, title, description } };
}

// Adds a bookmark; an address the project already holds is refused (the caller offers the existing one for editing).
export function addBookmark(
    data: ProjectBookmarks,
    draft: BookmarkDraft,
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<{ data: ProjectBookmarks; bookmark: Bookmark }> {
    const checked = checkDraft(draft);
    if (checked.problem != null) {
        return { problem: checked.problem };
    }
    if (findBookmarkByAddress(data, checked.value.url) != null) {
        return { problem: "browser.bookmarks.problem.alreadyThere" };
    }
    if (data.items.length >= BookmarkLimits.items) {
        return { problem: "browser.bookmarks.problem.tooMany" };
    }
    const placed = folderForDraft(data, draft, makeId);
    if (placed.problem != null) {
        return { problem: placed.problem };
    }
    const bookmark: Bookmark = { id: makeId("b"), ...checked.value, folder: placed.value.folder };
    return { value: { data: { ...placed.value.data, items: [...placed.value.data.items, bookmark] }, bookmark } };
}

export function updateBookmark(
    data: ProjectBookmarks,
    id: string,
    draft: BookmarkDraft,
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<ProjectBookmarks> {
    const current = data.items.find((b) => b.id === id);
    if (current == null) {
        return { problem: "browser.bookmarks.problem.gone" };
    }
    const checked = checkDraft(draft);
    if (checked.problem != null) {
        return { problem: checked.problem };
    }
    const twin = findBookmarkByAddress(data, checked.value.url);
    if (twin != null && twin.id !== id) {
        return { problem: "browser.bookmarks.problem.alreadyThere" };
    }
    const placed = folderForDraft(data, draft, makeId);
    if (placed.problem != null) {
        return { problem: placed.problem };
    }
    const items = placed.value.data.items.map((b) =>
        b.id === id ? { id, ...checked.value, folder: placed.value.folder } : b
    );
    return { value: { ...placed.value.data, items } };
}

export function moveBookmark(data: ProjectBookmarks, id: string, folderId: string): ProjectBookmarks {
    if (folderId !== "" && !data.folders.some((f) => f.id === folderId)) {
        return data;
    }
    return { ...data, items: data.items.map((b) => (b.id === id ? { ...b, folder: folderId } : b)) };
}

export function deleteBookmark(data: ProjectBookmarks, id: string): ProjectBookmarks {
    return { ...data, items: data.items.filter((b) => b.id !== id) };
}

export function renameFolder(data: ProjectBookmarks, folderId: string, name: string): BookmarkResult<ProjectBookmarks> {
    if (!data.folders.some((f) => f.id === folderId)) {
        return { problem: "browser.bookmarks.problem.gone" };
    }
    const problem = folderNameProblem(data, name, folderId);
    if (problem != null) {
        return { problem };
    }
    const clean = singleLine(name);
    return { value: { ...data, folders: data.folders.map((f) => (f.id === folderId ? { ...f, name: clean } : f)) } };
}

// Deleting a folder loses nothing: its bookmarks stay in the project.
export function deleteFolder(data: ProjectBookmarks, folderId: string): ProjectBookmarks {
    return {
        folders: data.folders.filter((f) => f.id !== folderId),
        items: data.items.map((b) => (b.folder === folderId ? { ...b, folder: "" } : b)),
    };
}

// An independent copy of a bookmark in another project, in the folder of the same name (created if missing). A target
// that holds the address already is refused.
export function copyBookmarkTo(
    source: ProjectBookmarks,
    id: string,
    target: ProjectBookmarks,
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<ProjectBookmarks> {
    const original = source.items.find((b) => b.id === id);
    if (original == null) {
        return { problem: "browser.bookmarks.problem.gone" };
    }
    const draft: BookmarkDraft = {
        url: original.url,
        title: original.title,
        description: original.description,
        folder: "",
        newFolder: folderName(source, original.folder),
    };
    const added = addBookmark(target, draft, makeId);
    return added.problem != null ? { problem: added.problem } : { value: added.value.data };
}

export function isEmptyProject(data: ProjectBookmarks): boolean {
    return data.folders.length === 0 && data.items.length === 0;
}

// The meta value after some projects' bookmarks change: the projects the workspace no longer has lose their entry (ids
// are reused), an empty project has none, and null deletes the key.
export function withProjectsBookmarks(
    meta: Record<string, any>,
    updates: Record<string, ProjectBookmarks>,
    knownProjectIds: readonly string[]
): AllBookmarks {
    const next: AllBookmarks = {};
    for (const id of knownProjectIds) {
        const own = updates[id] ?? readProjectBookmarks(meta, id);
        if (!isEmptyProject(own)) {
            next[id] = own;
        }
    }
    return Object.keys(next).length > 0 ? next : null;
}
