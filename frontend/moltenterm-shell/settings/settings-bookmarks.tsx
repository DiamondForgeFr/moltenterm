// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Browser › Bookmarks (FR-BRW-021, #2531): the bookmarks of the places visible from this workspace, place by place and
// folder by folder: the app, its context, the workspace and each of its projects. A bookmark placed at several places is
// one bookmark: it is listed at each place, its edit changes it everywhere and "Also place at" adds a place. The panel's
// popover and column panel read the same data, so a change shows in both at once. Removing asks for a second click;
// nothing here opens a page.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { BookmarkDialog, BookmarkDialogRequest } from "../browser/bookmark-dialog";
import { BookmarkMark, PlaceMarker, placeTitle } from "../browser/bookmark-parts";
import { childrenOf, nodeOf, PlaceCatalog, PlaceNode } from "../browser/bookmark-places";
import { useBookmarkStore, useCatalog, useHere } from "../browser/bookmark-world";
import {
    Bookmark,
    BookmarkFolder,
    BookmarkProblem,
    bookmarksAt,
    BookmarkStore,
    foldersAt,
    Here,
    LevelApp,
    LevelContext,
    LevelProject,
    LevelWorkspace,
    problemMessage,
    sameRef,
} from "../browser/bookmarks";
import {
    createFolderAt,
    deleteFolderAt,
    placeBookmarkAt,
    removeBookmarkEverywhere,
    renameFolderAt,
    unplaceBookmarkAt,
} from "../browser/bookmarks-store";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { suiteIcon } from "../suite/suite-icons";
import { PageCard } from "./settings-page";

const AddButton = "molten-btn inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-3 text-12";
const SecondaryButton =
    "molten-btn-secondary inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12";
const GhostButton =
    "molten-btn-ghost inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12";
const SelectClass =
    "h-row max-w-40 shrink-0 cursor-pointer rounded-4 border border-border bg-transparent px-2 text-12 text-secondary outline-none focus:border-accent";
const InputClass =
    "h-row min-w-0 flex-1 rounded-4 border border-border bg-transparent px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent";

type Report = (problem: BookmarkProblem) => void;

function makeRunner(report: Report) {
    return (action: Promise<BookmarkProblem>) =>
        fireAndForget(async () => {
            report(await action);
        });
}

// The places this page manages, widest first: the app, the context and the workspace of here, and the projects of the
// workspace.
export function managedPlaces(catalog: PlaceCatalog, here: Here): PlaceNode[] {
    const nodes = [
        nodeOf(catalog, { level: LevelApp, id: "" }),
        nodeOf(catalog, { level: LevelContext, id: here.contextId }),
        nodeOf(catalog, { level: LevelWorkspace, id: here.workspaceId }),
    ];
    const workspace = nodes[2];
    return [...nodes, ...(workspace == null ? [] : childrenOf(catalog, workspace))].filter((n) => n != null);
}

function BookmarkRow({
    place,
    bookmark,
    folders,
    others,
    catalog,
    confirming,
    onConfirm,
    onEdit,
    report,
    nested,
}: {
    place: PlaceNode;
    bookmark: Bookmark;
    folders: BookmarkFolder[];
    others: PlaceNode[];
    catalog: PlaceCatalog;
    confirming: string;
    onConfirm: (id: string) => void;
    onEdit: (b: Bookmark) => void;
    report: Report;
    // In a folder: indented under the folder's name.
    nested: boolean;
}) {
    const t = useT();
    const run = makeRunner(report);
    const here = bookmark.places.find((p) => sameRef(p, place.ref));
    const shared = bookmark.places.length > 1;
    const addableTo = others.filter((o) => !bookmark.places.some((p) => sameRef(p, o.ref)));
    const removeKey = `${bookmark.id}@${place.key}`;
    const everywhereKey = `${bookmark.id}@all`;
    return (
        <div
            className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 py-2 pr-5", nested ? "pl-9" : "pl-5")}
            data-testid={`bookmark-row-${bookmark.id}`}
        >
            <div className="min-w-0 flex-1 basis-56">
                <div className="flex min-w-0 items-center gap-2 text-13 text-primary" title={bookmark.title}>
                    <span className="flex w-4 shrink-0 justify-center text-icon-14" data-testid="bookmark-row-icon">
                        <BookmarkMark bookmark={bookmark} />
                    </span>
                    <span className="min-w-0 truncate">{bookmark.title}</span>
                    {shared ? (
                        <span className="shrink-0 text-11 text-muted" data-testid="bookmark-row-places">
                            {t("browser.bookmarks.panel.shared", { count: bookmark.places.length })}
                        </span>
                    ) : null}
                </div>
                <div className="truncate font-mono text-11 text-muted" title={bookmark.url}>
                    {bookmark.url}
                </div>
                {bookmark.description !== "" ? (
                    <div className="mt-0.5 line-clamp-2 text-12 whitespace-pre-line text-secondary">
                        {bookmark.description}
                    </div>
                ) : null}
            </div>
            <div className="flex max-w-full flex-wrap items-center gap-1.5">
                <button
                    type="button"
                    className={SecondaryButton}
                    aria-label={t("settings.bookmarks.editNamed", { title: bookmark.title })}
                    onClick={() => onEdit(bookmark)}
                >
                    {t("settings.bookmarks.edit")}
                </button>
                {folders.length > 0 ? (
                    <select
                        className={SelectClass}
                        value=""
                        aria-label={t("settings.bookmarks.moveToNamed", { title: bookmark.title })}
                        onChange={(e) =>
                            run(placeBookmarkAt(bookmark.id, place.ref, { folder: e.target.value === "root" ? "" : e.target.value }))
                        }
                    >
                        <option value="" disabled>
                            {t("settings.bookmarks.moveTo")}
                        </option>
                        {here != null && here.folder !== "" ? (
                            <option value="root">{t("settings.bookmarks.moveRoot")}</option>
                        ) : null}
                        {folders
                            .filter((f) => f.id !== here?.folder)
                            .map((f) => (
                                <option key={f.id} value={f.id}>
                                    {f.name}
                                </option>
                            ))}
                    </select>
                ) : null}
                {addableTo.length > 0 ? (
                    <select
                        className={SelectClass}
                        value=""
                        aria-label={t("settings.bookmarks.placeAlsoNamed", { title: bookmark.title })}
                        onChange={(e) => {
                            const target = addableTo.find((n) => n.key === e.target.value);
                            if (target != null) {
                                run(placeBookmarkAt(bookmark.id, target.ref));
                            }
                        }}
                    >
                        <option value="" disabled>
                            {t("settings.bookmarks.placeAlso")}
                        </option>
                        {addableTo.map((n) => (
                            <option key={n.key} value={n.key}>
                                {placeTitle(t, n.ref, n.name)}
                            </option>
                        ))}
                    </select>
                ) : null}
                <button
                    type="button"
                    className={cn(GhostButton, confirming === removeKey && "text-danger")}
                    aria-label={t(shared ? "settings.bookmarks.removeNamed" : "settings.bookmarks.deleteNamed", {
                        title: bookmark.title,
                    })}
                    onBlur={() => confirming === removeKey && onConfirm("")}
                    onClick={() => {
                        if (confirming !== removeKey) {
                            onConfirm(removeKey);
                            return;
                        }
                        onConfirm("");
                        run(unplaceBookmarkAt(bookmark.id, place.ref));
                    }}
                    data-testid={`bookmark-delete-${bookmark.id}`}
                >
                    {confirming === removeKey
                        ? t("settings.bookmarks.confirmDelete")
                        : t(shared ? "settings.bookmarks.remove" : "settings.bookmarks.delete")}
                </button>
                {shared ? (
                    <button
                        type="button"
                        className={cn(GhostButton, confirming === everywhereKey && "text-danger")}
                        aria-label={t("settings.bookmarks.deleteNamed", { title: bookmark.title })}
                        title={t("settings.bookmarks.deleteEverywhereTitle", {
                            places: bookmark.places
                                .map((p) => placeTitle(t, p, nodeOf(catalog, p)?.name ?? ""))
                                .join(", "),
                        })}
                        onBlur={() => confirming === everywhereKey && onConfirm("")}
                        onClick={() => {
                            if (confirming !== everywhereKey) {
                                onConfirm(everywhereKey);
                                return;
                            }
                            onConfirm("");
                            run(removeBookmarkEverywhere(bookmark.id));
                        }}
                        data-testid={`bookmark-delete-everywhere-${bookmark.id}`}
                    >
                        {confirming === everywhereKey
                            ? t("settings.bookmarks.confirmDelete")
                            : t("settings.bookmarks.deleteEverywhere")}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function FolderHeader({
    place,
    folder,
    confirming,
    onConfirm,
    report,
}: {
    place: PlaceNode;
    folder: BookmarkFolder;
    confirming: string;
    onConfirm: (id: string) => void;
    report: Report;
}) {
    const t = useT();
    const run = makeRunner(report);
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(folder.name);
    const key = `folder:${folder.id}`;
    const save = () =>
        fireAndForget(async () => {
            const problem = await renameFolderAt(place.ref, folder.id, name);
            report(problem);
            if (problem == null) {
                setRenaming(false);
            }
        });
    return (
        <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-surface-2/40 px-5 py-1.5"
            data-testid={`bookmark-folder-${folder.id}`}
        >
            <i className="fa fa-solid fa-folder text-11 text-muted" aria-hidden />
            {renaming ? (
                <input
                    className={InputClass}
                    value={name}
                    autoFocus
                    aria-label={t("settings.bookmarks.renameFolderNamed", { name: folder.name })}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            save();
                        } else if (e.key === "Escape") {
                            e.stopPropagation();
                            setName(folder.name);
                            setRenaming(false);
                        }
                    }}
                />
            ) : (
                <span className="min-w-0 flex-1 truncate text-12 font-semibold text-primary">{folder.name}</span>
            )}
            <div className="flex max-w-full flex-wrap items-center gap-1.5">
                {renaming ? (
                    <button type="button" className={SecondaryButton} onClick={save}>
                        {t("settings.bookmarks.save")}
                    </button>
                ) : (
                    <button
                        type="button"
                        className={SecondaryButton}
                        aria-label={t("settings.bookmarks.renameFolderNamed", { name: folder.name })}
                        onClick={() => {
                            setName(folder.name);
                            setRenaming(true);
                        }}
                    >
                        {t("settings.bookmarks.renameFolder")}
                    </button>
                )}
                <button
                    type="button"
                    className={cn(GhostButton, confirming === key && "text-danger")}
                    title={t("settings.bookmarks.deleteFolderTitle", { name: folder.name })}
                    onBlur={() => confirming === key && onConfirm("")}
                    onClick={() => {
                        if (confirming !== key) {
                            onConfirm(key);
                            return;
                        }
                        onConfirm("");
                        run(deleteFolderAt(place.ref, folder.id));
                    }}
                    data-testid={`folder-delete-${folder.id}`}
                >
                    {confirming === key ? t("settings.bookmarks.confirmDeleteFolder") : t("settings.bookmarks.deleteFolder")}
                </button>
            </div>
        </div>
    );
}

function PlaceBlock({
    place,
    store,
    others,
    catalog,
    current,
    ask,
}: {
    place: PlaceNode;
    store: BookmarkStore;
    others: PlaceNode[];
    catalog: PlaceCatalog;
    current: boolean;
    ask: (request: BookmarkDialogRequest) => void;
}) {
    const t = useT();
    const folders = foldersAt(store, place.ref);
    const direct = bookmarksAt(store, place.ref, "");
    const [problem, setProblem] = useState<BookmarkProblem>(null);
    const [confirming, setConfirming] = useState("");
    const [creating, setCreating] = useState(false);
    const [folderName, setFolderName] = useState("");
    const title = placeTitle(t, place.ref, place.name);
    const create = () =>
        fireAndForget(async () => {
            const failed = await createFolderAt(place.ref, folderName);
            setProblem(failed);
            if (failed == null) {
                setCreating(false);
                setFolderName("");
            }
        });
    const edit = (b: Bookmark) =>
        ask({
            ref: place.ref,
            placeName: title,
            mode: "edit",
            editingId: b.id,
            initial: { url: b.url, title: b.title, description: b.description, folder: "" },
        });
    const row = (b: Bookmark, nested: boolean) => (
        <BookmarkRow
            key={b.id}
            nested={nested}
            place={place}
            bookmark={b}
            folders={folders}
            others={others}
            catalog={catalog}
            confirming={confirming}
            onConfirm={setConfirming}
            onEdit={edit}
            report={setProblem}
        />
    );
    const empty = direct.length === 0 && folders.length === 0;
    return (
        <section
            className="border-t border-border first:border-t-0"
            data-testid={`bookmarks-place-${place.key}`}
            data-level={place.ref.level}
        >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-3 pb-2">
                <span className="flex w-4 shrink-0 justify-center text-icon-14">
                    <PlaceMarker level={place.ref.level} color={place.color} />
                </span>
                <h3 className="min-w-0 truncate text-13 font-semibold text-primary">{title}</h3>
                {current ? <span className="text-11 text-muted">{t("settings.bookmarks.currentProject")}</span> : null}
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    <button
                        type="button"
                        className={SecondaryButton}
                        onClick={() => {
                            setProblem(null);
                            setCreating(true);
                        }}
                    >
                        <i className="fa fa-solid fa-folder-plus text-11" aria-hidden />
                        {t("settings.bookmarks.newFolder")}
                    </button>
                    <button
                        type="button"
                        className={AddButton}
                        onClick={() =>
                            ask({
                                ref: place.ref,
                                placeName: title,
                                mode: "new",
                                initial: { url: "", title: "", description: "", folder: "" },
                            })
                        }
                        data-testid={`bookmark-add-${place.key}`}
                    >
                        <i className="fa fa-solid fa-plus text-11" aria-hidden />
                        {t("settings.bookmarks.add")}
                        <MoltenWave />
                    </button>
                </div>
            </header>
            {creating ? (
                <div className="flex items-center gap-2 px-5 pb-2">
                    <input
                        className={InputClass}
                        value={folderName}
                        autoFocus
                        placeholder={t("settings.bookmarks.newFolderName")}
                        aria-label={t("settings.bookmarks.newFolderName")}
                        onChange={(e) => setFolderName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                create();
                            } else if (e.key === "Escape") {
                                e.stopPropagation();
                                setCreating(false);
                            }
                        }}
                        data-testid={`folder-new-${place.key}`}
                    />
                    <button type="button" className={SecondaryButton} onClick={create}>
                        {t("settings.bookmarks.createFolder")}
                    </button>
                </div>
            ) : null}
            {problem != null ? (
                <div role="alert" className="px-5 pb-2 text-12 text-danger">
                    {problemMessage(problem, t)}
                </div>
            ) : null}
            {empty ? <div className="px-5 pb-3 text-12 text-muted">{t("settings.bookmarks.empty")}</div> : null}
            {direct.map((b) => row(b, false))}
            {folders.map((f) => (
                <div key={f.id}>
                    <FolderHeader
                        place={place}
                        folder={f}
                        confirming={confirming}
                        onConfirm={setConfirming}
                        report={setProblem}
                    />
                    {bookmarksAt(store, place.ref, f.id).map((b) => row(b, true))}
                </div>
            ))}
        </section>
    );
}

export function BookmarksCard() {
    const t = useT();
    const store = useBookmarkStore();
    const here = useHere("");
    const catalog = useCatalog();
    const [request, setRequest] = useState<BookmarkDialogRequest>(null);
    const places = managedPlaces(catalog, here);
    const projectPlaces = places.filter((p) => p.ref.level === LevelProject);
    const currentProject = projectPlaces.find((p) => p.ref.id.endsWith(`/${here.projectId}`));
    return (
        <PageCard
            title={t("settings.bookmarks.title")}
            hint={t("settings.bookmarks.hint")}
            icon={suiteIcon("web")}
            scope="workspace"
        >
            <div data-testid="settings-bookmarks">
                {places.map((place) => (
                    <PlaceBlock
                        key={place.key}
                        place={place}
                        store={store}
                        others={places.filter((o) => o.key !== place.key)}
                        catalog={catalog}
                        current={projectPlaces.length > 1 && currentProject != null && place.key === currentProject.key}
                        ask={setRequest}
                    />
                ))}
                {projectPlaces.length === 0 ? (
                    <div className="px-5 py-4 text-12 text-muted">{t("settings.bookmarks.noProject")}</div>
                ) : null}
            </div>
            {request != null ? <BookmarkDialog request={request} onClose={() => setRequest(null)} /> : null}
        </PageCard>
    );
}
