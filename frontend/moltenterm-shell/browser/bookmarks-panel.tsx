// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The bookmarks panel of the web page panel (FR-BRW-019, #2531, mockup section 3): a column browser like a file manager's
// beside the page, opened by the book button. No title or block around it (the active button says where we are): a top
// line with Back, the path, the search and Close, up to three columns, and at the bottom New folder and Add the page.
// Contexts, workspaces and projects are listed to be walked into, never made here.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtom, type PrimitiveAtom } from "jotai";
import {
    ArrowLeft,
    BookmarkPlus,
    ChevronRight,
    Folder,
    FolderPlus,
    Search as SearchIcon,
    X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { BookmarkPopover } from "./bookmark-popover";
import type { PopoverRequest } from "./bookmark-popover-model";
import { BookmarkMark, HighlightedName, PlaceMarker } from "./bookmark-parts";
import { nodeOf, PlaceCatalog } from "./bookmark-places";
import { bookmarkMenu, columnMenu, folderMenu } from "./bookmarks-menus";
import { savePanelWidth } from "./bookmark-prefs";
import { useBookmarkPrefs, useBookmarkStore, useCatalog, useHere } from "./bookmark-world";
import {
    BookmarkClip,
    chooseFolder,
    chooseNode,
    Column,
    columnCapacity,
    ColumnItem,
    dropAction,
    levelHeadingKey,
    PanelDefaultPx,
    PanelMaxPx,
    PanelMinPx,
    panelColumns,
    PanelSelection,
    pathCrumbs,
    searchBookmarks,
    selectionOfHere,
    selectionUp,
    shrinkCrumbs,
    visibleColumns,
} from "./bookmarks-columns";
import {
    addPageAt,
    copyBookmarkAt,
    createFolderAt,
    deleteFolderAt,
    moveBookmarkTo,
    placeBookmarkAt,
    removeBookmarkEverywhere,
    renameFolderAt,
    unplaceBookmarkAt,
} from "./bookmarks-store";
import {
    Bookmark,
    bookmarkablePage,
    BookmarkStore,
    folderNameAt,
    Here,
    placeKey,
    PlaceRef,
    problemMessage,
} from "./bookmarks";
import "./bookmarks.css";

// What the panel needs of the web page panel that holds it.
export type BookmarksPanelHost = {
    tabId: string;
    openPage: (url: string) => void;
    captureFavicon: () => void;
    close: () => void;
};

// The page the panel shows: what Add the page bookmarks.
export type ShownPage = { url: string; title: string };

const DragType = "application/x-molten-bookmark";

// Cut or Copy on a bookmark waits here until a Paste: one clipboard for the window's panels.
export const bookmarkClipAtom = atom(null) as PrimitiveAtom<BookmarkClip>;

export function clampPanelWidth(width: number, room: number): number {
    const max = Math.max(PanelMinPx, Math.min(PanelMaxPx, room));
    return Math.max(PanelMinPx, Math.min(max, Math.round(width)));
}

// The width the panel opens at: the one it was dragged to, else its default (about 640 px).
export function openingWidth(stored: number): number {
    return stored > 0 ? clampPanelWidth(stored, PanelMaxPx) : PanelDefaultPx;
}

type DragInfo = { id: string; from: PlaceRef };

function readDrag(e: React.DragEvent): DragInfo {
    try {
        const raw = JSON.parse(e.dataTransfer.getData(DragType));
        return typeof raw?.id === "string" && raw.from != null ? raw : null;
    } catch {
        return null;
    }
}

type Actions = {
    open: (b: Bookmark) => void;
    selectNode: (columnIndex: number, ref: PlaceRef) => void;
    selectFolder: (columnIndex: number, folderId: string) => void;
    rowMenu: (e: React.MouseEvent, b: Bookmark, column: Column) => void;
    folderMenu: (e: React.MouseEvent, ref: PlaceRef, folderId: string) => void;
    columnMenu: (e: React.MouseEvent, column: Column) => void;
    drop: (e: React.DragEvent, ref: PlaceRef, folder: string) => void;
    // The key of the folder being renamed in its row, and what ends the rename.
    renaming: string;
    rename: (ref: PlaceRef, folderId: string, name: string) => void;
    cancelRename: () => void;
};

function useDropTarget(ref: PlaceRef, folder: string, actions: Actions) {
    const [over, setOver] = useState(false);
    return {
        "data-drop": over ? "true" : undefined,
        onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes(DragType)) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
                setOver(true);
            }
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: React.DragEvent) => {
            setOver(false);
            e.stopPropagation();
            actions.drop(e, ref, folder);
        },
    };
}

function FolderItem({
    item,
    index,
    actions,
}: {
    item: Extract<ColumnItem, { kind: "folder" }>;
    index: number;
    actions: Actions;
}) {
    const t = useT();
    const drop = useDropTarget(item.ref, item.folder.id, actions);
    const [name, setName] = useState(item.folder.name);
    if (actions.renaming === item.key) {
        return (
            <div className="molten-bm-item" data-testid="bookmarks-rename-folder">
                <Folder className="molten-bm-marker" aria-hidden />
                <input
                    autoFocus
                    className="molten-bm-input"
                    value={name}
                    aria-label={t("browser.bookmarks.menu.renameFolder")}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={actions.cancelRename}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            actions.rename(item.ref, item.folder.id, name);
                        } else if (e.key === "Escape") {
                            e.stopPropagation();
                            actions.cancelRename();
                        }
                    }}
                />
            </div>
        );
    }
    return (
        <button
            type="button"
            className={cn("molten-bm-item", item.selected && "mt-selected")}
            data-testid="bookmarks-folder"
            aria-pressed={item.selected}
            onClick={() => actions.selectFolder(index, item.folder.id)}
            onContextMenu={(e) => actions.folderMenu(e, item.ref, item.folder.id)}
            {...drop}
        >
            <Folder className="molten-bm-marker" aria-hidden />
            <span className="molten-bm-item-name">{item.folder.name}</span>
            <span className="molten-bm-count">{item.count}</span>
            <ChevronRight className="molten-bm-chevron" aria-hidden />
        </button>
    );
}

function NodeItem({
    item,
    index,
    actions,
}: {
    item: Extract<ColumnItem, { kind: "node" }>;
    index: number;
    actions: Actions;
}) {
    const t = useT();
    const drop = useDropTarget(item.node.ref, "", actions);
    return (
        <button
            type="button"
            className={cn("molten-bm-item", item.selected && "mt-selected")}
            data-testid="bookmarks-node"
            data-level={item.node.ref.level}
            aria-pressed={item.selected}
            onClick={() => actions.selectNode(index, item.node.ref)}
            {...drop}
        >
            <span className="molten-bm-tile">
                <PlaceMarker level={item.node.ref.level} color={item.node.color} />
            </span>
            <span className="molten-bm-item-name">{item.node.name}</span>
            {item.here ? (
                <span className="molten-bm-here" title={t("browser.bookmarks.panel.here")} data-testid="bookmarks-here" />
            ) : null}
            <ChevronRight className="molten-bm-chevron" aria-hidden />
        </button>
    );
}

function BookmarkItem({
    item,
    column,
    actions,
}: {
    item: Extract<ColumnItem, { kind: "bookmark" }>;
    column: Column;
    actions: Actions;
}) {
    const t = useT();
    const b = item.bookmark;
    return (
        <button
            type="button"
            draggable
            className="molten-bm-item"
            data-testid="bookmarks-bookmark"
            title={b.description || b.url}
            onClick={() => actions.open(b)}
            onContextMenu={(e) => actions.rowMenu(e, b, column)}
            onDragStart={(e) => {
                e.dataTransfer.setData(DragType, JSON.stringify({ id: b.id, from: { level: item.ref.level, id: item.ref.id } }));
                e.dataTransfer.effectAllowed = "copyMove";
            }}
        >
            <BookmarkMark bookmark={b} />
            <span className="molten-bm-item-name">{b.title}</span>
            {b.places.length > 1 ? (
                <span className="molten-bm-count" title={t("browser.bookmarks.panel.shared", { count: b.places.length })}>
                    {b.places.length}
                </span>
            ) : null}
        </button>
    );
}

function ColumnView({
    column,
    index,
    actions,
    creating,
    onCreate,
    onCancelCreate,
    catalog,
}: {
    column: Column;
    index: number;
    actions: Actions;
    creating: boolean;
    onCreate: (name: string) => void;
    onCancelCreate: () => void;
    catalog: PlaceCatalog;
}) {
    const t = useT();
    const drop = useDropTarget(column.ref, column.folder, actions);
    const name = nodeOf(catalog, column.ref)?.name ?? "";
    return (
        <div
            className="molten-bm-col"
            role="list"
            aria-label={name}
            data-testid="bookmarks-column"
            data-column={column.key}
            onContextMenu={(e) => actions.columnMenu(e, column)}
            {...drop}
        >
            {creating ? <NewFolderInput onCreate={onCreate} onCancel={onCancelCreate} /> : null}
            {column.items.map((item) => {
                switch (item.kind) {
                    case "heading":
                        return (
                            <div key={item.key} className="molten-bm-heading">
                                {t(levelHeadingKey(item.level))}
                            </div>
                        );
                    case "folder":
                        return <FolderItem key={item.key} item={item} index={index} actions={actions} />;
                    case "node":
                        return <NodeItem key={item.key} item={item} index={index} actions={actions} />;
                    default:
                        return <BookmarkItem key={item.key} item={item} column={column} actions={actions} />;
                }
            })}
            {column.items.length === 0 && !creating ? (
                <div className="molten-bm-empty">{t("browser.bookmarks.panel.empty")}</div>
            ) : null}
        </div>
    );
}

function NewFolderInput({ onCreate, onCancel }: { onCreate: (name: string) => void; onCancel: () => void }) {
    const t = useT();
    const [name, setName] = useState("");
    return (
        <div className="molten-bm-item" data-testid="bookmarks-new-folder">
            <Folder className="molten-bm-marker" aria-hidden />
            <input
                autoFocus
                className="molten-bm-input"
                value={name}
                placeholder={t("browser.bookmarks.folder.newName")}
                aria-label={t("browser.bookmarks.folder.newName")}
                onChange={(e) => setName(e.target.value)}
                onBlur={onCancel}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        onCreate(name);
                    } else if (e.key === "Escape") {
                        e.stopPropagation();
                        onCancel();
                    }
                }}
            />
        </div>
    );
}

export function Path({
    catalog,
    selection,
    store,
    room,
    onGo,
}: {
    catalog: PlaceCatalog;
    selection: PanelSelection;
    store: BookmarkStore;
    room: number;
    onGo: (selection: PanelSelection) => void;
}) {
    const t = useT();
    const crumbs = pathCrumbs(catalog, selection, (ref, id) => folderNameAt(store, ref, id));
    const { shown, hidden, folded } = shrinkCrumbs(crumbs, room);
    const last = shown[shown.length - 1];
    const crumb = (c: (typeof crumbs)[number]) => (
        <button
            key={c.key}
            type="button"
            className="molten-bm-crumb"
            data-testid="bookmarks-crumb"
            aria-current={c === last ? "location" : undefined}
            onClick={() => onGo(c.selection)}
        >
            {c.name}
        </button>
    );
    const items: React.ReactNode[] = [];
    shown.forEach((c, i) => {
        if (i > 0) {
            items.push(<ChevronRight key={`s${c.key}`} className="molten-bm-chevron" aria-hidden />);
        }
        if (i === 1 && folded) {
            items.push(
                <button
                    key="more"
                    type="button"
                    className="molten-bm-crumb"
                    data-testid="bookmarks-crumb-more"
                    aria-haspopup="menu"
                    aria-label={t("browser.bookmarks.panel.hidden")}
                    title={t("browser.bookmarks.panel.hidden")}
                    onClick={(e) =>
                        ContextMenuModel.getInstance().showContextMenu(
                            hidden.map((h): ContextMenuItem => ({ label: h.name, click: () => onGo(h.selection) })),
                            e
                        )
                    }
                >
                    …
                </button>,
                <ChevronRight key="s-more" className="molten-bm-chevron" aria-hidden />
            );
        }
        items.push(crumb(c));
    });
    return (
        <nav className="molten-bm-path" aria-label={t("browser.bookmarks.panel.path")} data-testid="bookmarks-path">
            {items}
        </nav>
    );
}

function SearchResults({
    store,
    catalog,
    typed,
    onOpen,
    onMenu,
}: {
    store: BookmarkStore;
    catalog: PlaceCatalog;
    typed: string;
    onOpen: (b: Bookmark) => void;
    onMenu: (e: React.MouseEvent, b: Bookmark) => void;
}) {
    const t = useT();
    const hits = useMemo(() => searchBookmarks(store, catalog, typed), [store, catalog, typed]);
    return (
        <div className="molten-bm-results" data-testid="bookmarks-results">
            {hits.length === 0 ? (
                <div className="molten-bm-empty" role="status">
                    {typed.trim() === ""
                        ? t("browser.bookmarks.panel.searchHint")
                        : t("browser.bookmarks.panel.noResults")}
                </div>
            ) : null}
            {hits.map((hit) => (
                <button
                    key={hit.bookmark.id}
                    type="button"
                    className="molten-bm-item molten-bm-hit"
                    data-testid="bookmarks-hit"
                    title={hit.bookmark.description || hit.bookmark.url}
                    onClick={() => onOpen(hit.bookmark)}
                    onContextMenu={(e) => onMenu(e, hit.bookmark)}
                >
                    <BookmarkMark bookmark={hit.bookmark} />
                    <span className="molten-bm-item-text">
                        <span className="molten-bm-item-name">
                            <HighlightedName name={hit.bookmark.title} positions={hit.positions} />
                        </span>
                        <span className="molten-bm-item-path">{hit.paths.join("  ·  ")}</span>
                    </span>
                </button>
            ))}
        </div>
    );
}

type EditRequest = { anchor: Element; request: PopoverRequest };

// Where the panel starts, for the places that open it on something other than the current place (the tests).
export type PanelStart = { selection?: PanelSelection; searching?: boolean; typed?: string };

export function BookmarksPanel({ host, page, start }: { host: BookmarksPanelHost; page: ShownPage; start?: PanelStart }) {
    const t = useT();
    const store = useBookmarkStore();
    const here: Here = useHere(host.tabId);
    const catalog = useCatalog();
    const [clip, setClip] = useAtom(bookmarkClipAtom);
    const [selection, setSelection] = useState<PanelSelection>(() => start?.selection ?? selectionOfHere(catalog, here));
    const prefs = useBookmarkPrefs();
    const [width, setWidth] = useState(() => openingWidth(prefs.width));
    const [bodyWidth, setBodyWidth] = useState(width);
    const [searching, setSearching] = useState(start?.searching ?? false);
    const [typed, setTyped] = useState(start?.typed ?? "");
    const [creating, setCreating] = useState(false);
    const [renaming, setRenaming] = useState<string>(null);
    const [problem, setProblem] = useState<string>(null);
    const [editing, setEditing] = useState<EditRequest>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const pathRef = useRef<HTMLDivElement>(null);
    const [pathRoom, setPathRoom] = useState(60);
    const drag = useRef<{ x: number; width: number }>(null);

    useEffect(() => {
        const body = bodyRef.current;
        if (body == null || typeof ResizeObserver === "undefined") {
            return;
        }
        const measure = () => setBodyWidth(body.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(body);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        const line = pathRef.current;
        if (line == null || typeof ResizeObserver === "undefined") {
            return;
        }
        const measure = () => setPathRoom(Math.max(12, Math.floor(line.clientWidth / 7)));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(line);
        return () => observer.disconnect();
    }, [searching]);

    const columns = useMemo(() => panelColumns(store, catalog, selection, here), [store, catalog, selection, here]);
    const capacity = columnCapacity(bodyWidth);
    const shown = visibleColumns(columns, capacity);
    const firstShown = columns.length - shown.length;
    const deepest = columns[columns.length - 1];
    const report = (p: string) => setProblem(p);
    const run = (action: Promise<string>) => fireAndForget(async () => report(await action));
    const pageUrl = bookmarkablePage(page?.url);

    const addPage = (ref: PlaceRef, folder: string) => {
        if (pageUrl === "") {
            return;
        }
        host.captureFavicon();
        fireAndForget(async () => {
            const added = await addPageAt({ url: page.url, title: page.title, description: "" }, ref, { folder });
            report(added.problem);
        });
    };
    const paste = (ref: PlaceRef, folder: string) => {
        if (clip == null) {
            return;
        }
        if (clip.mode === "cut") {
            setClip(null);
            run(moveBookmarkTo(clip.id, clip.from, ref, { folder }));
            return;
        }
        fireAndForget(async () => report((await copyBookmarkAt(clip.id, ref, { folder })).problem));
    };
    const openEditor = (e: React.MouseEvent | null, b: Bookmark, anchor?: Element) => {
        const target = anchor ?? (e?.currentTarget as Element) ?? panelRef.current;
        setEditing({ anchor: target, request: { kind: "bookmark", id: b.id, fresh: false } });
    };

    const actions: Actions = {
        open: (b) => host.openPage(b.url),
        selectNode: (i, ref) => setSelection((s) => chooseNode(s, firstShown + i, ref)),
        selectFolder: (i, id) => setSelection((s) => chooseFolder(s, firstShown + i, id)),
        rowMenu: (e, b, column) => {
            e.preventDefault();
            e.stopPropagation();
            const anchor = e.currentTarget as Element;
            const menu = bookmarkMenu(
                t,
                b,
                { catalog, store, from: column.ref },
                {
                    edit: () => openEditor(null, b, anchor),
                    go: setSelection,
                    cut: () => setClip({ id: b.id, mode: "cut", from: column.ref }),
                    copy: () => setClip({ id: b.id, mode: "copy", from: column.ref }),
                    remove: () => run(unplaceBookmarkAt(b.id, column.ref)),
                    removeEverywhere: () => run(removeBookmarkEverywhere(b.id)),
                }
            );
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        renaming,
        rename: (ref, folderId, name) =>
            fireAndForget(async () => {
                const failed = await renameFolderAt(ref, folderId, name);
                report(failed);
                if (failed == null) {
                    setRenaming(null);
                }
            }),
        cancelRename: () => setRenaming(null),
        folderMenu: (e, ref, folderId) => {
            e.preventDefault();
            e.stopPropagation();
            const menu = folderMenu(
                t,
                { canAddPage: pageUrl !== "", canPaste: clip != null },
                {
                    addPage: () => addPage(ref, folderId),
                    paste: () => paste(ref, folderId),
                    rename: () => setRenaming(`f:${placeKey(ref)}:${folderId}`),
                    remove: () => {
                        setSelection((s) => (s.folder === folderId ? selectionUp(s) : s));
                        run(deleteFolderAt(ref, folderId));
                    },
                }
            );
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        columnMenu: (e, column) => {
            e.preventDefault();
            const menu = columnMenu(
                t,
                { canAddPage: pageUrl !== "", canPaste: clip != null },
                {
                    newFolder: () => setCreating(true),
                    addPage: () => addPage(column.ref, column.folder),
                    paste: () => paste(column.ref, column.folder),
                }
            );
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        drop: (e, ref, folder) => {
            const dragged = readDrag(e);
            if (dragged == null) {
                return;
            }
            e.preventDefault();
            const action = dropAction(store, dragged, { ref, folder }, e.altKey);
            if (action.kind === "move") {
                run(moveBookmarkTo(action.id, action.from, action.to, { folder: action.folder }));
            } else if (action.kind === "place") {
                run(placeBookmarkAt(action.id, action.to, { folder: action.folder }));
            }
        },
    };

    const startResize = (e: React.PointerEvent) => {
        if (e.button !== 0) {
            return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, width };
    };
    const moveResize = (e: React.PointerEvent) => {
        const d = drag.current;
        if (d == null) {
            return;
        }
        const room = panelRef.current?.parentElement?.clientWidth ?? PanelMaxPx;
        setWidth(clampPanelWidth(d.width + (d.x - e.clientX), room - 160));
    };
    const endResize = () => {
        if (drag.current != null) {
            drag.current = null;
            fireAndForget(() => savePanelWidth(width));
        }
    };

    const startSearch = () => {
        setSearching(true);
        setTyped("");
    };
    const stopSearch = () => {
        setSearching(false);
        setTyped("");
    };
    const searchMenu = (e: React.MouseEvent, b: Bookmark) => {
        e.preventDefault();
        const anchor = e.currentTarget as Element;
        const menu = bookmarkMenu(
            t,
            b,
            { catalog, store, from: null },
            {
                edit: () => openEditor(null, b, anchor),
                go: (s) => {
                    stopSearch();
                    setSelection(s);
                },
                cut: () => {},
                copy: () => {},
                remove: () => {},
                removeEverywhere: () => run(removeBookmarkEverywhere(b.id)),
            }
        );
        ContextMenuModel.getInstance().showContextMenu(menu, e);
    };

    return (
        <aside
            ref={panelRef}
            className="molten-bm-panel"
            style={{ width }}
            aria-label={t("browser.bookmarks.panel.aria")}
            data-testid="bookmarks-panel"
        >
            <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t("browser.bookmarks.panel.resize")}
                aria-valuemin={PanelMinPx}
                aria-valuemax={PanelMaxPx}
                aria-valuenow={width}
                tabIndex={0}
                className="molten-bm-grip"
                data-testid="bookmarks-grip"
                onPointerDown={startResize}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onLostPointerCapture={endResize}
                onKeyDown={(e) => {
                    const step = e.key === "ArrowLeft" ? 24 : e.key === "ArrowRight" ? -24 : 0;
                    if (step !== 0) {
                        e.preventDefault();
                        const next = clampPanelWidth(width + step, PanelMaxPx);
                        setWidth(next);
                        fireAndForget(() => savePanelWidth(next));
                    }
                }}
            />
            <div className="molten-bm-top" data-testid="bookmarks-top">
                <button
                    type="button"
                    className="molten-bm-tool"
                    aria-label={t("browser.bookmarks.panel.back")}
                    title={t("browser.bookmarks.panel.back")}
                    data-testid="bookmarks-back"
                    onClick={() => (searching ? stopSearch() : setSelection(selectionUp(selection)))}
                >
                    <ArrowLeft aria-hidden />
                </button>
                <div ref={pathRef} className="molten-bm-top-line">
                    {searching ? (
                        <input
                            autoFocus
                            className="molten-bm-search-field"
                            value={typed}
                            placeholder={t("browser.bookmarks.panel.searchPlaceholder")}
                            aria-label={t("browser.bookmarks.panel.searchPlaceholder")}
                            data-testid="bookmarks-search"
                            onChange={(e) => setTyped(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    stopSearch();
                                }
                            }}
                        />
                    ) : (
                        <Path catalog={catalog} selection={selection} store={store} room={pathRoom} onGo={setSelection} />
                    )}
                </div>
                <button
                    type="button"
                    className="molten-bm-tool molten-bm-tool-bordered"
                    aria-label={t("browser.bookmarks.panel.search")}
                    title={t("browser.bookmarks.panel.search")}
                    aria-pressed={searching}
                    data-testid="bookmarks-search-button"
                    onClick={() => (searching ? stopSearch() : startSearch())}
                >
                    <SearchIcon aria-hidden />
                </button>
                <button
                    type="button"
                    className="molten-bm-tool"
                    aria-label={t("browser.bookmarks.panel.close")}
                    title={t("browser.bookmarks.panel.close")}
                    data-testid="bookmarks-close"
                    onClick={host.close}
                >
                    <X aria-hidden />
                </button>
            </div>
            <div ref={bodyRef} className="molten-bm-body">
                {searching ? (
                    <SearchResults store={store} catalog={catalog} typed={typed} onOpen={actions.open} onMenu={searchMenu} />
                ) : (
                    <div className="molten-bm-cols" data-testid="bookmarks-columns" data-count={shown.length}>
                        {shown.map((column, i) => (
                            <ColumnView
                                key={column.key}
                                column={column}
                                index={i}
                                actions={actions}
                                catalog={catalog}
                                creating={creating && column === deepest}
                                onCreate={(name) =>
                                    fireAndForget(async () => {
                                        const failed = await createFolderAt(column.ref, name);
                                        report(failed);
                                        if (failed == null) {
                                            setCreating(false);
                                        }
                                    })
                                }
                                onCancelCreate={() => setCreating(false)}
                            />
                        ))}
                    </div>
                )}
            </div>
            {problem != null ? (
                <div role="alert" className="molten-bm-alert" data-testid="bookmarks-problem">
                    {problemMessage(problem, t)}
                </div>
            ) : null}
            <div className="molten-bm-bottom">
                <button
                    type="button"
                    className="molten-btn-secondary molten-bm-small"
                    disabled={searching}
                    data-testid="bookmarks-new-folder-button"
                    onClick={() => {
                        setProblem(null);
                        setCreating(true);
                    }}
                >
                    <FolderPlus aria-hidden />
                    {t("browser.bookmarks.panel.newFolder")}
                </button>
                <button
                    type="button"
                    className="molten-btn molten-bm-small cursor-pointer rounded-4 px-3 py-1 text-12"
                    disabled={searching || pageUrl === ""}
                    title={pageUrl === "" ? t("browser.bookmarks.panel.addPageNone") : undefined}
                    data-testid="bookmarks-add-page"
                    onClick={() => {
                        setProblem(null);
                        addPage(deepest.ref, deepest.folder);
                    }}
                >
                    <BookmarkPlus aria-hidden />
                    {t("browser.bookmarks.panel.addPage")}
                    <MoltenWave />
                </button>
            </div>
            {editing != null ? (
                <BookmarkPopover
                    anchor={editing.anchor}
                    tabId={host.tabId}
                    request={editing.request}
                    setRequest={(request) => setEditing({ anchor: editing.anchor, request })}
                    onClose={() => setEditing(null)}
                />
            ) : null}
        </aside>
    );
}
