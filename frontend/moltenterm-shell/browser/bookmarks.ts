// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The bookmarks of the web page panel (FR-BRW-019, DS-BRW-026, #2531). A bookmark is ONE record (address, title, note for
// agents) placed at one or several places; a place is a level of the app (the app itself, a context, a workspace or a
// project) with its own folder for the bookmark. From a place, the bookmarks shown are those of its app, its context, its
// workspace and its project. Because one record may sit at several levels, everything lives in one value, the client's
// meta key molten:bookmarks, next to the contexts: {records: [{id, url, title, description, places: [{level, id, folder}]}],
// folders: {placeKey: [{id, name}]}}. A project's id is the workspace's oid and its own id (project ids repeat from one
// workspace to the next). Everything here is pure: the store writes the answers, wavesrv reads the same value for
// `molten bookmarks list` (pkg/molten/bookmarks).

import { contextIdOf, type ContextInfo } from "../contexts/context-model";
import { currentProjectId, readProjects } from "../sidebar/workspace-projects";
import { looksLikeAddress, toBrowserUrl } from "./browser-model";

// must match BookmarksMetaKey in pkg/molten/agentbookmarks.go
export const BookmarksMetaKey = "molten:bookmarks";
// Workspace meta {tabId: projectId}, written once the workspace has two projects. must match
// TabProjectsMetaKey in pkg/molten/projectviews
export const TabProjectsMetaKey = "molten:tabprojects";

// must match the limits in pkg/molten/bookmarks/bookmarks.go
export const BookmarkLimits = {
    // At one place.
    items: 300,
    folders: 50,
    title: 200,
    url: 2048,
    description: 1000,
    folderName: 60,
    // In the whole app, and at the places of one bookmark.
    records: 3000,
    places: 32,
};

export const LevelApp = "app";
export const LevelContext = "context";
export const LevelWorkspace = "workspace";
export const LevelProject = "project";
export const Levels = [LevelApp, LevelContext, LevelWorkspace, LevelProject] as const;
export type PlaceLevel = (typeof Levels)[number];

// A place without its folder: the level and its id ("" for the app, the context's id, the workspace's oid, and for a
// project "<workspace oid>/<project id>").
export type PlaceRef = { level: PlaceLevel; id: string };
export type Place = PlaceRef & { folder: string };
export type BookmarkFolder = { id: string; name: string };
export type Bookmark = { id: string; url: string; title: string; description: string; places: Place[] };
export type BookmarkStore = { records: Bookmark[]; folders: Record<string, BookmarkFolder[]> };

// Where the developer stands: the window's context and workspace, and the project of the panel's tab (null for a workspace
// with none).
export type Here = { contextId: string; workspaceId: string; projectId: string };

// What a bookmark's text is, before it is placed: the popover, the panel and Settings collect it.
export type BookmarkDraft = { url: string; title: string; description: string };

// A problem is an i18n key, so the component says it in the current language.
export type BookmarkProblem = string;
export type BookmarkResult<T> = { value: T; problem?: undefined } | { value?: undefined; problem: BookmarkProblem };

export function problemKey(problem: BookmarkProblem): string {
    return problem;
}

// The problem in words, with the numbers it names.
export function problemMessage(
    problem: BookmarkProblem,
    translate: (key: string, vars?: Record<string, string | number>) => string
): string {
    return translate(problem, problemVars(problem));
}

// The numbers a problem's text names.
export function problemVars(problem: string): Record<string, number> {
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
        case "browser.bookmarks.problem.tooManyBookmarks":
            return { max: BookmarkLimits.records };
        case "browser.bookmarks.problem.tooManyPlaces":
            return { max: BookmarkLimits.places };
        default:
            return {};
    }
}

export type IdMaker = (prefix: "b" | "f") => string;

export function makeBookmarkId(prefix: "b" | "f"): string {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export const EmptyStore: BookmarkStore = { records: [], folders: {} };

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

export function projectPlaceId(workspaceId: string, projectId: string): string {
    return `${workspaceId}/${projectId}`;
}

// The workspace and the project a project place's id names.
export function splitProjectPlaceId(id: string): { workspaceId: string; projectId: string } {
    const at = (id ?? "").lastIndexOf("/");
    return at < 0 ? { workspaceId: "", projectId: "" } : { workspaceId: id.slice(0, at), projectId: id.slice(at + 1) };
}

export function placeKey(ref: PlaceRef): string {
    return ref.level === LevelApp ? LevelApp : `${ref.level}:${ref.id}`;
}

export function sameRef(a: PlaceRef, b: PlaceRef): boolean {
    return a != null && b != null && a.level === b.level && a.id === b.id;
}

export function parsePlaceKey(key: string): PlaceRef {
    if (key === LevelApp) {
        return { level: LevelApp, id: "" };
    }
    const at = key.indexOf(":");
    const level = key.slice(0, at);
    const id = key.slice(at + 1);
    if (at < 1 || id === "" || !(Levels as readonly string[]).includes(level) || level === LevelApp) {
        return null;
    }
    return { level: level as PlaceLevel, id };
}

// The places of here, widest first: the app, the context, the workspace and, with a project, the project.
export function refsHere(here: Here): PlaceRef[] {
    const refs: PlaceRef[] = [{ level: LevelApp, id: "" }];
    if (here.contextId) {
        refs.push({ level: LevelContext, id: here.contextId });
    }
    if (here.workspaceId) {
        refs.push({ level: LevelWorkspace, id: here.workspaceId });
        if (here.projectId) {
            refs.push({ level: LevelProject, id: projectPlaceId(here.workspaceId, here.projectId) });
        }
    }
    return refs;
}

// The project a panel's tab belongs to: its owner in the workspace's tab map, else the current project (as wavesrv
// answers `molten bookmarks list`, pkg/molten/bookmarks). null for a workspace without a project.
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

export function hereOf(
    ws: { oid?: string; meta?: Record<string, any> },
    contexts: readonly ContextInfo[],
    tabId: string
): Here {
    return {
        contextId: contextIdOf(contexts, ws?.meta),
        workspaceId: ws?.oid ?? "",
        projectId: projectIdOfTab(ws ?? {}, tabId),
    };
}

function readFolders(raw: unknown): Record<string, BookmarkFolder[]> {
    const folders: Record<string, BookmarkFolder[]> = {};
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return folders;
    }
    for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
        if (parsePlaceKey(key) == null || !Array.isArray(list)) {
            continue;
        }
        const seen = new Set<string>();
        const kept: BookmarkFolder[] = [];
        for (const f of list as any[]) {
            const id = text(f?.id);
            const name = singleLine(typeof f?.name === "string" ? f.name : "").slice(0, BookmarkLimits.folderName);
            if (id === "" || name === "" || seen.has(id) || kept.length >= BookmarkLimits.folders) {
                continue;
            }
            seen.add(id);
            kept.push({ id, name });
        }
        if (kept.length > 0) {
            folders[key] = kept;
        }
    }
    return folders;
}

// What the client holds is read as untrusted data: any program that can edit the client's meta can write this key, so a
// bookmark the window shows or opens is checked again here, as on its way in. A record whose address is not a safe web
// address is ignored, the texts are cut to their limits, a place keeps no more than the limits allow and names a folder
// that exists at that place, else none.
export function readStore(clientMeta: Record<string, any>): BookmarkStore {
    const raw = clientMeta?.[BookmarksMetaKey];
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return EmptyStore;
    }
    const folders = readFolders(raw.folders);
    const records: Bookmark[] = [];
    const ids = new Set<string>();
    const counts = new Map<string, number>();
    for (const r of Array.isArray(raw.records) ? raw.records : []) {
        if (records.length >= BookmarkLimits.records) {
            break;
        }
        const id = text(r?.id);
        const address = bookmarkAddress(typeof r?.url === "string" ? r.url : "");
        if (id === "" || address.problem != null || ids.has(id)) {
            continue;
        }
        const places: Place[] = [];
        const taken = new Set<string>();
        for (const p of Array.isArray(r?.places) ? r.places : []) {
            const level = text(p?.level);
            const placeId = level === LevelApp ? "" : text(p?.id);
            if (!(Levels as readonly string[]).includes(level) || (level !== LevelApp && placeId === "")) {
                continue;
            }
            const key = placeKey({ level: level as PlaceLevel, id: placeId });
            if (taken.has(key) || places.length >= BookmarkLimits.places || (counts.get(key) ?? 0) >= BookmarkLimits.items) {
                continue;
            }
            taken.add(key);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            const folder = text(p?.folder);
            places.push({
                level: level as PlaceLevel,
                id: placeId,
                folder: (folders[key] ?? []).some((f) => f.id === folder) ? folder : "",
            });
        }
        if (places.length === 0) {
            continue;
        }
        ids.add(id);
        const title = singleLine(typeof r?.title === "string" ? r.title : "").slice(0, BookmarkLimits.title);
        records.push({
            id,
            url: address.value,
            title: title || address.value.slice(0, BookmarkLimits.title),
            description: plainText(typeof r?.description === "string" ? r.description : "").slice(
                0,
                BookmarkLimits.description
            ),
            places,
        });
    }
    return records.length === 0 && Object.keys(folders).length === 0 ? EmptyStore : { records, folders };
}

// The value to write under molten:bookmarks; null deletes the key once nothing is kept.
export function storeValue(store: BookmarkStore): { records: Bookmark[]; folders: Record<string, BookmarkFolder[]> } {
    if (store.records.length === 0 && Object.keys(store.folders).length === 0) {
        return null;
    }
    return { records: store.records, folders: store.folders };
}

export function placeOf(b: Bookmark, ref: PlaceRef): Place {
    return b.places.find((p) => sameRef(p, ref)) ?? null;
}

export function isAt(b: Bookmark, ref: PlaceRef): boolean {
    return placeOf(b, ref) != null;
}

// The bookmarks visible from here: those with a place at its app, its context, its workspace or its project.
export function visibleFrom(store: BookmarkStore, here: Here): Bookmark[] {
    const refs = refsHere(here);
    return store.records.filter((b) => b.places.some((p) => refs.some((r) => sameRef(r, p))));
}

// The places of a bookmark that are visible from here.
export function visiblePlaces(b: Bookmark, here: Here): Place[] {
    const refs = refsHere(here);
    return b.places.filter((p) => refs.some((r) => sameRef(r, p)));
}

export function foldersAt(store: BookmarkStore, ref: PlaceRef): BookmarkFolder[] {
    return store.folders[placeKey(ref)] ?? [];
}

export function folderNameAt(store: BookmarkStore, ref: PlaceRef, folderId: string): string {
    return foldersAt(store, ref).find((f) => f.id === folderId)?.name ?? "";
}

// The bookmarks of one place that sit directly in it (folder ""), or in one of its folders.
export function bookmarksAt(store: BookmarkStore, ref: PlaceRef, folderId = ""): Bookmark[] {
    return store.records.filter((b) => {
        const place = placeOf(b, ref);
        return place != null && place.folder === folderId;
    });
}

export function countAt(store: BookmarkStore, ref: PlaceRef): number {
    return store.records.reduce((n, b) => (isAt(b, ref) ? n + 1 : n), 0);
}

// Every place that holds this bookmark, as a count for the shortcut mark.
export function placeCount(b: Bookmark): number {
    return b.places.length;
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

// The address of the page a panel shows when the add button offers to bookmark it, else "": a web page, not the start page
// or another kind of page. A web page whose address cannot be kept (too long, a user name in it) is still offered, as it
// was typed, so the popover can say why instead of the button going missing.
export function bookmarkablePage(url: string): string {
    const typed = singleLine(url ?? "");
    const address = bookmarkAddress(typed);
    if (address.problem == null) {
        return address.value;
    }
    return address.problem === "browser.bookmarks.problem.addressTooLong" ||
        address.problem === "browser.bookmarks.problem.credentials"
        ? typed
        : "";
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

// The bookmark of an address visible from here: the one the add button fills for, and edits.
export function findVisibleByAddress(store: BookmarkStore, here: Here, url: string): Bookmark {
    return visibleFrom(store, here).find((b) => sameBookmarkAddress(b.url, url)) ?? null;
}

// A bookmark of an address anywhere in the app, visible from here or not.
export function findByAddress(store: BookmarkStore, url: string): Bookmark {
    return store.records.find((b) => sameBookmarkAddress(b.url, url)) ?? null;
}

// What the add button shows for the page: bookmarked here, bookmarked only elsewhere (the popover offers to place it
// here or to copy it), or not bookmarked.
export type PageState =
    | { kind: "here"; bookmark: Bookmark }
    | { kind: "elsewhere"; bookmark: Bookmark }
    | { kind: "none" };

export function pageState(store: BookmarkStore, here: Here, url: string): PageState {
    const visible = findVisibleByAddress(store, here, url);
    if (visible != null) {
        return { kind: "here", bookmark: visible };
    }
    const elsewhere = findByAddress(store, url);
    return elsewhere != null ? { kind: "elsewhere", bookmark: elsewhere } : { kind: "none" };
}

function hostTitle(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

export function folderNameProblem(
    store: BookmarkStore,
    ref: PlaceRef,
    name: string,
    exceptId?: string
): BookmarkProblem {
    const clean = singleLine(name);
    if (clean === "") {
        return "browser.bookmarks.problem.noFolderName";
    }
    if (clean.length > BookmarkLimits.folderName) {
        return "browser.bookmarks.problem.folderNameTooLong";
    }
    const taken = findFolderByName(store, ref, clean);
    if (taken != null && taken.id !== exceptId) {
        return "browser.bookmarks.problem.folderTaken";
    }
    return null;
}

function findFolderByName(store: BookmarkStore, ref: PlaceRef, name: string): BookmarkFolder {
    const wanted = name.trim().toLowerCase();
    return foldersAt(store, ref).find((f) => f.name.toLowerCase() === wanted) ?? null;
}

function withFolders(store: BookmarkStore, ref: PlaceRef, list: BookmarkFolder[]): BookmarkStore {
    const folders = { ...store.folders };
    if (list.length === 0) {
        delete folders[placeKey(ref)];
    } else {
        folders[placeKey(ref)] = list;
    }
    return { ...store, folders };
}

export function createFolder(
    store: BookmarkStore,
    ref: PlaceRef,
    name: string,
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<{ store: BookmarkStore; folder: BookmarkFolder }> {
    const clean = singleLine(name);
    const problem = folderNameProblem(store, ref, clean);
    if (problem != null) {
        return { problem };
    }
    const list = foldersAt(store, ref);
    if (list.length >= BookmarkLimits.folders) {
        return { problem: "browser.bookmarks.problem.tooManyFolders" };
    }
    const folder = { id: makeId("f"), name: clean };
    return { value: { store: withFolders(store, ref, [...list, folder]), folder } };
}

export function renameFolder(
    store: BookmarkStore,
    ref: PlaceRef,
    folderId: string,
    name: string
): BookmarkResult<BookmarkStore> {
    const list = foldersAt(store, ref);
    if (!list.some((f) => f.id === folderId)) {
        return { problem: "browser.bookmarks.problem.gone" };
    }
    const problem = folderNameProblem(store, ref, name, folderId);
    if (problem != null) {
        return { problem };
    }
    const clean = singleLine(name);
    return { value: withFolders(store, ref, list.map((f) => (f.id === folderId ? { ...f, name: clean } : f))) };
}

// Deleting a folder loses nothing: its bookmarks stay at the place.
export function deleteFolder(store: BookmarkStore, ref: PlaceRef, folderId: string): BookmarkStore {
    const list = foldersAt(store, ref).filter((f) => f.id !== folderId);
    const records = store.records.map((b) =>
        b.places.some((p) => sameRef(p, ref) && p.folder === folderId)
            ? { ...b, places: b.places.map((p) => (sameRef(p, ref) ? { ...p, folder: "" } : p)) }
            : b
    );
    return withFolders({ ...store, records }, ref, list);
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

// The folder a placement asks for: an existing folder of the place, or one created by name (an existing folder of that
// name is reused).
export type FolderChoice = { folder?: string; newFolder?: string };

function chooseFolder(
    store: BookmarkStore,
    ref: PlaceRef,
    choice: FolderChoice,
    makeId: IdMaker
): BookmarkResult<{ store: BookmarkStore; folder: string }> {
    const newName = singleLine(choice?.newFolder ?? "");
    if (newName === "") {
        const known = foldersAt(store, ref).some((f) => f.id === choice?.folder);
        return { value: { store, folder: known ? choice.folder : "" } };
    }
    const existing = findFolderByName(store, ref, newName);
    if (existing != null) {
        return { value: { store, folder: existing.id } };
    }
    const created = createFolder(store, ref, newName, makeId);
    return created.problem != null
        ? { problem: created.problem }
        : { value: { store: created.value.store, folder: created.value.folder.id } };
}

function holdsAddress(store: BookmarkStore, ref: PlaceRef, url: string, exceptId?: string): boolean {
    return store.records.some((b) => b.id !== exceptId && isAt(b, ref) && sameBookmarkAddress(b.url, url));
}

// Adds a bookmark at one place; an address the place holds already is refused (the caller offers the existing one).
export function addBookmark(
    store: BookmarkStore,
    draft: BookmarkDraft,
    ref: PlaceRef,
    choice: FolderChoice = {},
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<{ store: BookmarkStore; bookmark: Bookmark }> {
    const checked = checkDraft(draft);
    if (checked.problem != null) {
        return { problem: checked.problem };
    }
    if (holdsAddress(store, ref, checked.value.url)) {
        return { problem: "browser.bookmarks.problem.alreadyThere" };
    }
    if (countAt(store, ref) >= BookmarkLimits.items) {
        return { problem: "browser.bookmarks.problem.tooMany" };
    }
    if (store.records.length >= BookmarkLimits.records) {
        return { problem: "browser.bookmarks.problem.tooManyBookmarks" };
    }
    const placed = chooseFolder(store, ref, choice, makeId);
    if (placed.problem != null) {
        return { problem: placed.problem };
    }
    const bookmark: Bookmark = {
        id: makeId("b"),
        ...checked.value,
        places: [{ level: ref.level, id: ref.id, folder: placed.value.folder }],
    };
    return { value: { store: { ...placed.value.store, records: [...placed.value.store.records, bookmark] }, bookmark } };
}

// The shown page added at a place, as the panel's "Add the page" does: a bookmark of that address the place already holds
// is refused, one that exists elsewhere is placed here (the same bookmark, never a silent duplicate), else a new one is made.
export function addPage(
    store: BookmarkStore,
    draft: BookmarkDraft,
    ref: PlaceRef,
    choice: FolderChoice = {},
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<{ store: BookmarkStore; bookmark: Bookmark }> {
    const checked = checkDraft(draft);
    if (checked.problem != null) {
        return { problem: checked.problem };
    }
    const existing = findByAddress(store, checked.value.url);
    if (existing == null) {
        return addBookmark(store, draft, ref, choice, makeId);
    }
    if (isAt(existing, ref)) {
        return { problem: "browser.bookmarks.problem.alreadyThere" };
    }
    const placed = placeBookmark(store, existing.id, ref, choice, makeId);
    return placed.problem != null
        ? { problem: placed.problem }
        : { value: { store: placed.value, bookmark: existing } };
}

function replaceRecord(store: BookmarkStore, id: string, next: Bookmark): BookmarkStore {
    return { ...store, records: store.records.map((b) => (b.id === id ? next : b)) };
}

// Changes the one record: its title and note change at every place. An address another bookmark of one of its places
// already holds is refused.
export function updateBookmark(store: BookmarkStore, id: string, draft: BookmarkDraft): BookmarkResult<BookmarkStore> {
    const current = store.records.find((b) => b.id === id);
    if (current == null) {
        return { problem: "browser.bookmarks.problem.gone" };
    }
    const checked = checkDraft(draft);
    if (checked.problem != null) {
        return { problem: checked.problem };
    }
    if (current.places.some((p) => holdsAddress(store, p, checked.value.url, id))) {
        return { problem: "browser.bookmarks.problem.alreadyThere" };
    }
    return { value: replaceRecord(store, id, { ...current, ...checked.value }) };
}

// Places the same bookmark at a place, or moves it to another folder of a place it already has.
export function placeBookmark(
    store: BookmarkStore,
    id: string,
    ref: PlaceRef,
    choice: FolderChoice = {},
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<BookmarkStore> {
    const current = store.records.find((b) => b.id === id);
    if (current == null) {
        return { problem: "browser.bookmarks.problem.gone" };
    }
    const there = placeOf(current, ref);
    if (there == null) {
        if (current.places.length >= BookmarkLimits.places) {
            return { problem: "browser.bookmarks.problem.tooManyPlaces" };
        }
        if (holdsAddress(store, ref, current.url, id)) {
            return { problem: "browser.bookmarks.problem.alreadyThere" };
        }
        if (countAt(store, ref) >= BookmarkLimits.items) {
            return { problem: "browser.bookmarks.problem.tooMany" };
        }
    }
    const chosen = chooseFolder(store, ref, choice, makeId);
    if (chosen.problem != null) {
        return { problem: chosen.problem };
    }
    const place: Place = { level: ref.level, id: ref.id, folder: chosen.value.folder };
    const places = there == null ? [...current.places, place] : current.places.map((p) => (sameRef(p, ref) ? place : p));
    return { value: replaceRecord(chosen.value.store, id, { ...current, places }) };
}

// Removes the bookmark from one place only; one left with no place is deleted, since it would be seen nowhere.
export function unplaceBookmark(store: BookmarkStore, id: string, ref: PlaceRef): BookmarkStore {
    const current = store.records.find((b) => b.id === id);
    if (current == null || !isAt(current, ref)) {
        return store;
    }
    const places = current.places.filter((p) => !sameRef(p, ref));
    return places.length === 0 ? deleteBookmark(store, id) : replaceRecord(store, id, { ...current, places });
}

// Moves the bookmark from one place to another (and into a folder of it): it keeps its other places. Moving it onto a
// place it already has changes its folder there.
export function moveBookmark(
    store: BookmarkStore,
    id: string,
    from: PlaceRef,
    to: PlaceRef,
    choice: FolderChoice = {},
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<BookmarkStore> {
    const current = store.records.find((b) => b.id === id);
    if (current == null || !isAt(current, from)) {
        return { problem: "browser.bookmarks.problem.gone" };
    }
    const placed = placeBookmark(store, id, to, choice, makeId);
    if (placed.problem != null || sameRef(from, to)) {
        return placed;
    }
    return { value: unplaceBookmark(placed.value, id, from) };
}

export function deleteBookmark(store: BookmarkStore, id: string): BookmarkStore {
    return { ...store, records: store.records.filter((b) => b.id !== id) };
}

// A separate bookmark, with its own name, at one place: what Copy does, and the popover's Copy.
export function copyBookmarkTo(
    store: BookmarkStore,
    id: string,
    ref: PlaceRef,
    choice: FolderChoice = {},
    makeId: IdMaker = makeBookmarkId
): BookmarkResult<{ store: BookmarkStore; bookmark: Bookmark }> {
    const original = store.records.find((b) => b.id === id);
    if (original == null) {
        return { problem: "browser.bookmarks.problem.gone" };
    }
    return addBookmark(
        store,
        { url: original.url, title: original.title, description: original.description },
        ref,
        choice,
        makeId
    );
}
