// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The popover of the add button (FR-BRW-019, #2531, mockup sections 2, 2 bis and 2 ter): the page is bookmarked at once
// and the popover says where, with a checkbox per place and a folder for each; a page already bookmarked elsewhere asks
// whether to place it here or copy it; "Add to another place…" gives way to the place finder. Every change applies at
// once; nothing opens by itself. Built with the suite kit; its call to action is a molten button.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { cn, fireAndForget } from "@/util/util";
import { AppWindow, Bookmark as BookmarkIcon, ChevronDown, MapPin, Plus, Search, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { labelled, useT, useTCount, type TFunction } from "../i18n/i18n";
import { MenuPopover } from "../mission/menu-popover";
import { MoltenWave } from "../molten-button";
import { BlockRows, CheckRow, SectionBlock } from "../suite/suite";
import { AddressIcon } from "../favicon/favicon-mark";
import {
    Bookmark,
    BookmarkFolder,
    BookmarkLimits,
    foldersAt,
    Here,
    PlaceRef,
    problemMessage,
    sameRef,
} from "./bookmarks";
import { useBookmarkStore, useCatalog, useHere } from "./bookmark-world";
import { noteRecentPlace, nodeOf, pathOf, PlaceCatalog, readRecentKeys } from "./bookmark-places";
import {
    defaultPlace,
    finderItems,
    nextFinderIndex,
    placeRows,
    toggleAction,
    type PlaceRow,
    type PopoverRequest,
} from "./bookmark-popover-model";
import { HighlightedName, pathText, PlaceMarker, placeHint, placeTitle } from "./bookmark-parts";
import {
    copyBookmarkAt,
    editBookmark,
    placeBookmarkAt,
    removeBookmarkEverywhere,
    unplaceBookmarkAt,
} from "./bookmarks-store";

type View = "places" | "finder";

// A folder choice for a place: the menu lists the place's folders, "No folder" and "New folder…" (named inline).
function showFolderMenu(
    e: React.MouseEvent,
    t: TFunction,
    folders: readonly BookmarkFolder[],
    current: string,
    onPick: (folderId: string) => void,
    onNew: () => void
) {
    const menu: ContextMenuItem[] = [
        { label: t("browser.bookmarks.folder.none"), type: "radio", checked: current === "", click: () => onPick("") },
        ...folders.map(
            (f): ContextMenuItem => ({
                label: f.name,
                type: "radio",
                checked: current === f.id,
                click: () => onPick(f.id),
            })
        ),
        { type: "separator" },
        {
            label: t("browser.bookmarks.folder.new"),
            icon: "folder-plus",
            enabled: folders.length < BookmarkLimits.folders,
            click: onNew,
        },
    ];
    ContextMenuModel.getInstance().showContextMenu(menu, e);
}

function FolderButton({
    folders,
    current,
    onPick,
    onNew,
}: {
    folders: readonly BookmarkFolder[];
    current: string;
    onPick: (folderId: string) => void;
    onNew: () => void;
}) {
    const t = useT();
    const name = folders.find((f) => f.id === current)?.name ?? t("browser.bookmarks.folder.none");
    const label = labelled(t("browser.bookmarks.folder.label"), name);
    return (
        <button
            type="button"
            className="molten-bm-fold"
            aria-haspopup="menu"
            aria-label={label}
            title={label}
            data-testid="bookmark-folder"
            onClick={(e) => showFolderMenu(e, t, folders, current, onPick, onNew)}
        >
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDown aria-hidden />
        </button>
    );
}

function PlaceRowView({
    row,
    catalog,
    store,
    onToggle,
    onFolder,
    onNewFolder,
}: {
    row: PlaceRow;
    catalog: PlaceCatalog;
    store: ReturnType<typeof useBookmarkStore>;
    onToggle: (ref: PlaceRef, checked: boolean) => void;
    onFolder: (ref: PlaceRef, folderId: string) => void;
    onNewFolder: (ref: PlaceRef) => void;
}) {
    const t = useT();
    const node = nodeOf(catalog, row.ref);
    const name = node?.name ?? "";
    const description = row.elsewhere ? pathText([...pathOf(catalog, row.ref)]) : placeHint(t, row.ref.level);
    return (
        <CheckRow
            checked={row.checked}
            onChange={(checked) => onToggle(row.ref, checked)}
            lead={<PlaceMarker level={row.ref.level} color={node?.color} />}
            label={placeTitle(t, row.ref, name)}
            description={description}
            value={`${row.ref.level}`}
            trailing={
                row.checked ? (
                    <FolderButton
                        folders={foldersAt(store, row.ref)}
                        current={row.folder}
                        onPick={(folderId) => onFolder(row.ref, folderId)}
                        onNew={() => onNewFolder(row.ref)}
                    />
                ) : null
            }
        />
    );
}

function NewFolderRow({ onCreate, onCancel }: { onCreate: (name: string) => void; onCancel: () => void }) {
    const t = useT();
    const [name, setName] = useState("");
    return (
        <div className="molten-bm-row-line">
            <input
                className="molten-bm-input"
                value={name}
                autoFocus
                maxLength={BookmarkLimits.folderName + 1}
                placeholder={t("browser.bookmarks.folder.newName")}
                aria-label={t("browser.bookmarks.folder.newName")}
                data-testid="bookmark-new-folder"
                onChange={(e) => setName(e.target.value)}
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
            <button type="button" className="molten-btn-secondary molten-bm-small" onClick={() => onCreate(name)}>
                {t("browser.bookmarks.folder.create")}
            </button>
        </div>
    );
}

function NameRow({ bookmark, onProblem }: { bookmark: Bookmark; onProblem: (problem: string) => void }) {
    const t = useT();
    const [name, setName] = useState(bookmark.title);
    const editing = useRef(false);
    useEffect(() => {
        if (!editing.current) {
            setName(bookmark.title);
        }
    }, [bookmark.title]);
    const commit = () => {
        editing.current = false;
        if (name.trim() === bookmark.title) {
            return;
        }
        fireAndForget(async () => {
            const problem = await editBookmark(bookmark.id, {
                url: bookmark.url,
                title: name,
                description: bookmark.description,
            });
            onProblem(problem);
        });
    };
    return (
        <div className="molten-bm-row-line" data-testid="bookmark-name-row">
            <span className="molten-bm-row-label">
                <span className="molten-bm-icon">
                    <AddressIcon address={bookmark.url} />
                </span>
                <span className="df-check-label">{t("browser.bookmarks.popover.name")}</span>
            </span>
            <input
                className="molten-bm-input molten-bm-name"
                value={name}
                maxLength={BookmarkLimits.title + 1}
                aria-label={t("browser.bookmarks.popover.name")}
                data-testid="bookmark-title"
                onFocus={() => (editing.current = true)}
                onChange={(e) => setName(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        commit();
                    }
                }}
            />
        </div>
    );
}

function NoteRow({ bookmark, onProblem }: { bookmark: Bookmark; onProblem: (problem: string) => void }) {
    const t = useT();
    const [open, setOpen] = useState(bookmark.description !== "");
    const [note, setNote] = useState(bookmark.description);
    const editing = useRef(false);
    useEffect(() => {
        if (!editing.current) {
            setNote(bookmark.description);
        }
    }, [bookmark.description]);
    const commit = () => {
        editing.current = false;
        if (note.trim() === bookmark.description) {
            return;
        }
        fireAndForget(async () => {
            const problem = await editBookmark(bookmark.id, {
                url: bookmark.url,
                title: bookmark.title,
                description: note,
            });
            onProblem(problem);
        });
    };
    if (!open) {
        return (
            <div className="molten-bm-row-line" data-testid="bookmark-note-row">
                <span className="molten-bm-row-label molten-bm-stack">
                    <span className="df-check-label">{t("browser.bookmarks.popover.note")}</span>
                    <span className="df-check-desc">{t("browser.bookmarks.popover.noteHint")}</span>
                </span>
                <button
                    type="button"
                    className="molten-btn-secondary molten-bm-small"
                    data-testid="bookmark-note-add"
                    onClick={() => setOpen(true)}
                >
                    {t("browser.bookmarks.popover.noteAdd")}
                </button>
            </div>
        );
    }
    return (
        <div className="molten-bm-row-block" data-testid="bookmark-note-row">
            <span className="df-check-label">{t("browser.bookmarks.popover.note")}</span>
            <textarea
                className="molten-bm-input molten-bm-note"
                rows={3}
                value={note}
                autoFocus={bookmark.description === ""}
                maxLength={BookmarkLimits.description + 1}
                placeholder={t("browser.bookmarks.popover.notePlaceholder")}
                aria-label={t("browser.bookmarks.popover.note")}
                data-testid="bookmark-description"
                onFocus={() => (editing.current = true)}
                onChange={(e) => setNote(e.target.value)}
                onBlur={commit}
            />
        </div>
    );
}

export function Finder({
    bookmark,
    catalog,
    here,
    initialTyped = "",
    onBack,
    onProblem,
}: {
    bookmark: Bookmark;
    catalog: PlaceCatalog;
    here: Here;
    initialTyped?: string;
    onBack: () => void;
    onProblem: (problem: string) => void;
}) {
    const t = useT();
    const [typed, setTyped] = useState(initialTyped);
    const [index, setIndex] = useState(0);
    const recent = useMemo(() => readRecentKeys(), []);
    const items = useMemo(
        () => finderItems(catalog, here, bookmark, typed, recent),
        [catalog, here, bookmark, typed, recent]
    );
    useEffect(() => setIndex(0), [typed]);
    const choose = (i: number) => {
        const item = items[i];
        if (item == null) {
            return;
        }
        if (item.there) {
            onBack();
            return;
        }
        fireAndForget(async () => {
            const problem = await placeBookmarkAt(bookmark.id, item.node.ref);
            onProblem(problem);
            if (problem == null) {
                noteRecentPlace(item.node.ref);
                onBack();
            }
        });
    };
    let lastGroup = "";
    return (
        <>
            <SectionBlock icon={Search} title={t("browser.bookmarks.finder.title")} data-testid="bookmark-finder">
                <div className="molten-bm-search">
                    <Search aria-hidden />
                    <input
                        autoFocus
                        className="molten-bm-search-input"
                        value={typed}
                        placeholder={t("browser.bookmarks.finder.search")}
                        aria-label={t("browser.bookmarks.finder.search")}
                        role="combobox"
                        aria-expanded
                        aria-controls="bookmark-finder-list"
                        aria-activedescendant={items[index] != null ? `bookmark-finder-${items[index].node.key}` : undefined}
                        data-testid="bookmark-finder-input"
                        onChange={(e) => setTyped(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                choose(index);
                                return;
                            }
                            const next = nextFinderIndex(e.key, index, items.length);
                            if (next >= 0) {
                                e.preventDefault();
                                setIndex(next);
                            }
                        }}
                    />
                </div>
                <BlockRows id="bookmark-finder-list" role="listbox">
                    {items.length === 0 ? (
                        <div className="molten-bm-empty" role="status">
                            {t("browser.bookmarks.finder.empty")}
                        </div>
                    ) : null}
                    {items.map((item, i) => {
                        const heading = item.group !== lastGroup ? t(`browser.bookmarks.finder.${item.group}`) : null;
                        lastGroup = item.group;
                        const trail = pathOf(catalog, item.node.ref).slice(1);
                        const level = t(`browser.bookmarks.level.${item.node.ref.level}`);
                        return (
                            <Fragment key={item.node.key}>
                                {heading != null ? <div className="molten-bm-heading">{heading}</div> : null}
                                <button
                                    type="button"
                                    role="option"
                                    id={`bookmark-finder-${item.node.key}`}
                                    aria-selected={i === index}
                                    data-selected={i === index ? "true" : undefined}
                                    data-there={item.there ? "true" : undefined}
                                    className="molten-bm-pick"
                                    data-testid="bookmark-finder-item"
                                    onMouseEnter={() => setIndex(i)}
                                    onClick={() => choose(i)}
                                >
                                    <span className="molten-bm-tile">
                                        <PlaceMarker level={item.node.ref.level} color={item.node.color} />
                                    </span>
                                    <span className="molten-bm-pick-text">
                                        <span className="df-check-label">
                                            <HighlightedName name={item.node.name} positions={item.positions} />
                                        </span>
                                        <span className="df-check-desc">
                                            {trail.length > 0
                                                ? t("browser.bookmarks.finder.path", { level, path: pathText(trail) })
                                                : level}
                                        </span>
                                    </span>
                                    {item.there ? (
                                        <span className="molten-bm-there">{t("browser.bookmarks.finder.already")}</span>
                                    ) : i === index ? (
                                        <kbd className="molten-bm-key">↵</kbd>
                                    ) : null}
                                </button>
                            </Fragment>
                        );
                    })}
                </BlockRows>
            </SectionBlock>
            <div className="molten-bm-foot">
                <span className="df-check-desc">{t("browser.bookmarks.finder.hint")}</span>
                <button
                    type="button"
                    className="molten-btn-secondary molten-bm-small"
                    data-testid="bookmark-finder-back"
                    onClick={onBack}
                >
                    {t("browser.bookmarks.finder.back")}
                </button>
            </div>
        </>
    );
}

function ElsewhereView({
    bookmark,
    catalog,
    tabId,
    onPlaced,
    onCopied,
    onProblem,
}: {
    bookmark: Bookmark;
    catalog: PlaceCatalog;
    tabId: string;
    onPlaced: () => void;
    onCopied: (copy: Bookmark) => void;
    onProblem: (problem: string) => void;
}) {
    const t = useT();
    const here = useHere(tabId);
    const target = defaultPlace(here);
    const targetNode = nodeOf(catalog, target);
    const where = bookmark.places
        .map((p) => placeTitle(t, p, nodeOf(catalog, p)?.name ?? ""))
        .join(", ");
    return (
        <SectionBlock icon={MapPin} title={t("browser.bookmarks.elsewhere.title")} data-testid="bookmark-elsewhere">
            <BlockRows>
                <div className="molten-bm-row-line">
                    <span className="molten-bm-row-label molten-bm-stack">
                        <span className="df-check-label">{bookmark.title}</span>
                        <span className="df-check-desc">{t("browser.bookmarks.elsewhere.at", { places: where })}</span>
                    </span>
                    <span className="molten-bm-icon">
                        <AddressIcon address={bookmark.url} />
                    </span>
                </div>
                <div className="molten-bm-row-line">
                    <span className="molten-bm-row-label molten-bm-stack">
                        <span className="df-check-label">{t("browser.bookmarks.elsewhere.placeHere")}</span>
                        <span className="df-check-desc">
                            {t("browser.bookmarks.elsewhere.placeHereHint", {
                                place: placeTitle(t, target, targetNode?.name ?? ""),
                            })}
                        </span>
                    </span>
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
                        data-testid="bookmark-place-here"
                        onClick={() =>
                            fireAndForget(async () => {
                                const problem = await placeBookmarkAt(bookmark.id, target);
                                onProblem(problem);
                                if (problem == null) {
                                    onPlaced();
                                }
                            })
                        }
                    >
                        {t("browser.bookmarks.elsewhere.placeHereAction")}
                        <MoltenWave />
                    </button>
                </div>
                <div className="molten-bm-row-line">
                    <span className="molten-bm-row-label molten-bm-stack">
                        <span className="df-check-label">{t("browser.bookmarks.elsewhere.copy")}</span>
                        <span className="df-check-desc">{t("browser.bookmarks.elsewhere.copyHint")}</span>
                    </span>
                    <button
                        type="button"
                        className="molten-btn-secondary molten-bm-small"
                        data-testid="bookmark-copy-here"
                        onClick={() =>
                            fireAndForget(async () => {
                                const copied = await copyBookmarkAt(bookmark.id, target);
                                onProblem(copied.problem);
                                if (copied.problem == null) {
                                    onCopied(copied.result);
                                }
                            })
                        }
                    >
                        {t("browser.bookmarks.elsewhere.copyAction")}
                    </button>
                </div>
            </BlockRows>
        </SectionBlock>
    );
}

export function BookmarkPopover({
    anchor,
    tabId,
    request,
    setRequest,
    onClose,
}: {
    anchor: Element;
    tabId: string;
    request: PopoverRequest;
    setRequest: (request: PopoverRequest) => void;
    onClose: () => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const store = useBookmarkStore();
    const here = useHere(tabId);
    const catalog = useCatalog();
    const [view, setView] = useState<View>("places");
    const [problem, setProblem] = useState<string>(null);
    const [newFolderFor, setNewFolderFor] = useState<PlaceRef>(null);
    const id = request.kind === "problem" ? "" : request.id;
    const seen = useRef<Bookmark>(request.kind === "bookmark" ? (request.initial ?? null) : null);
    const found = store.records.find((b) => b.id === id) ?? null;
    if (found != null) {
        seen.current = found;
    }
    const bookmark = found ?? seen.current;
    const report = (p: string) => setProblem(p);
    const rows = useMemo(() => (bookmark != null ? placeRows(bookmark, here) : []), [bookmark, here]);

    const toggle = (ref: PlaceRef, checked: boolean) => {
        if (bookmark == null) {
            return;
        }
        const action = toggleAction(bookmark, ref, checked);
        fireAndForget(async () => {
            if (action.kind === "removeEverywhere") {
                const failed = await removeBookmarkEverywhere(bookmark.id);
                report(failed);
                if (failed == null) {
                    onClose();
                }
                return;
            }
            report(
                action.kind === "place"
                    ? await placeBookmarkAt(bookmark.id, ref)
                    : await unplaceBookmarkAt(bookmark.id, ref)
            );
        });
    };
    const pickFolder = (ref: PlaceRef, folderId: string) =>
        fireAndForget(async () => report(await placeBookmarkAt(bookmark.id, ref, { folder: folderId })));
    const createFolder = (ref: PlaceRef, name: string) =>
        fireAndForget(async () => {
            const failed = await placeBookmarkAt(bookmark.id, ref, { newFolder: name });
            report(failed);
            if (failed == null) {
                setNewFolderFor(null);
            }
        });

    let body: React.ReactNode;
    if (request.kind === "problem") {
        body = (
            <SectionBlock icon={BookmarkIcon} title={t("browser.bookmarks.popover.bookmark")}>
                <div role="alert" className="molten-bm-alert" data-testid="bookmark-problem">
                    {problemMessage(request.problem, t)}
                </div>
            </SectionBlock>
        );
    } else if (bookmark == null) {
        body = null;
    } else if (request.kind === "elsewhere") {
        body = (
            <ElsewhereView
                bookmark={bookmark}
                catalog={catalog}
                tabId={tabId}
                onProblem={report}
                onPlaced={() => setRequest({ kind: "bookmark", id: bookmark.id, fresh: false })}
                onCopied={(copy) => setRequest({ kind: "bookmark", id: copy.id, fresh: true, initial: copy })}
            />
        );
    } else if (view === "finder") {
        body = (
            <Finder
                bookmark={bookmark}
                catalog={catalog}
                here={here}
                onBack={() => setView("places")}
                onProblem={report}
            />
        );
    } else {
        body = (
            <>
                <SectionBlock
                    icon={BookmarkIcon}
                    title={t(request.fresh ? "browser.bookmarks.popover.added" : "browser.bookmarks.popover.bookmark")}
                    data-testid="bookmark-popover-bookmark"
                >
                    <BlockRows>
                        <NameRow bookmark={bookmark} onProblem={report} />
                        <NoteRow bookmark={bookmark} onProblem={report} />
                    </BlockRows>
                </SectionBlock>
                <SectionBlock
                    icon={AppWindow}
                    title={t("browser.bookmarks.popover.where")}
                    data-testid="bookmark-popover-places"
                >
                    <span className="molten-bm-scope" data-testid="bookmark-scope">
                        {tCount("browser.bookmarks.popover.placesCount", bookmark.places.length)}
                    </span>
                    <BlockRows>
                        {rows.map((row) => (
                            <Fragment key={`${row.ref.level}:${row.ref.id}`}>
                                <PlaceRowView
                                    row={row}
                                    catalog={catalog}
                                    store={store}
                                    onToggle={toggle}
                                    onFolder={pickFolder}
                                    onNewFolder={(ref) => setNewFolderFor(ref)}
                                />
                                {newFolderFor != null && sameRef(newFolderFor, row.ref) ? (
                                    <NewFolderRow
                                        onCreate={(name) => createFolder(row.ref, name)}
                                        onCancel={() => setNewFolderFor(null)}
                                    />
                                ) : null}
                            </Fragment>
                        ))}
                        <div className="molten-bm-row-line">
                            <button
                                type="button"
                                className="molten-btn-secondary molten-bm-small"
                                data-testid="bookmark-add-elsewhere"
                                onClick={() => setView("finder")}
                            >
                                <Plus aria-hidden />
                                {t("browser.bookmarks.popover.addElsewhere")}
                            </button>
                        </div>
                    </BlockRows>
                </SectionBlock>
                <div className="molten-bm-foot">
                    <button
                        type="button"
                        className={cn("molten-btn-secondary molten-bm-small text-danger")}
                        data-testid="bookmark-remove-everywhere"
                        onClick={() =>
                            fireAndForget(async () => {
                                const failed = await removeBookmarkEverywhere(bookmark.id);
                                report(failed);
                                if (failed == null) {
                                    onClose();
                                }
                            })
                        }
                    >
                        <Trash2 aria-hidden />
                        {t("browser.bookmarks.popover.removeEverywhere")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-4 py-1 text-12"
                        data-testid="bookmark-done"
                        onClick={onClose}
                    >
                        {t("browser.bookmarks.popover.done")}
                        <MoltenWave />
                    </button>
                </div>
            </>
        );
    }
    return (
        <MenuPopover
            anchor={anchor}
            onClose={onClose}
            className="molten-bm-popover flex w-[26.25rem] flex-col gap-0 px-3 pt-0 pb-3"
            role="dialog"
            ariaLabel={t("browser.bookmarks.popover.aria")}
            focusManaged
            placement="bottom-start"
        >
            {body}
            {problem != null && request.kind !== "problem" ? (
                <div role="alert" className="molten-bm-alert" data-testid="bookmark-problem">
                    {problemMessage(problem, t)}
                </div>
            ) : null}
        </MenuPopover>
    );
}
