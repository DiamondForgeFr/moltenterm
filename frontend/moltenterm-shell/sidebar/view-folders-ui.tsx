// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Folders of views in the Views list (FR-SHELL-080, #2484, DS-SHELL-125): a folder is one row, an icon of up to four of
// its views in miniature (2 by 2), its name, its number of views and a dot when one of them has news; a click opens its
// views as a grid over the sidebar, the rest dimmed. The name is edited in place, a click on a view opens it and closes
// the folder, a view dragged out of the grid's frame leaves the folder, Escape or a click outside closes it. The arrow
// keys move through the grid, Enter opens, Alt+Shift and an arrow move a view one place. The rules are in
// view-folders-model.ts, the changes in view-folders-store.ts, the drag in view-list-drag.ts.

import { getTabBadgeAtom } from "@/app/store/badge";
import { getApi, globalStore } from "@/app/store/global";
import { getWaveObjectAtom, makeORef, useWaveObjectValue } from "@/app/store/wos";
import { TabBadges } from "@/app/tab/tabbadges";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { agentStatesOfBlocks } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { pageUrlOfMeta, registrableDomain, siteNameOf } from "../favicon/site";
import { useT, useTCount } from "../i18n/i18n";
import { TabAgentMark, TabReviewMark, useTabIdentity } from "../tab-identity-ui";
import { dotMoveKey } from "./sidebar-model";
import { SidebarEnv, useRenameCallback, useViewActions, useViewPin } from "./view-actions";
import { folderShownName, viewHasNews, ViewKindFact, viewKindOf } from "./view-folders-edit";
import { MaxFolderNameLength, MaxMiniatures, SidebarItem, ViewFolder } from "./view-folders-model";
import { dissolveViewFolder, moveViewInFolder, renameViewFolder } from "./view-folders-ops";
import { closeFolder, folderMenuFor, folderRenameAtom, openFolder, openFolderAtom } from "./view-folders-store";
import "./view-folders.css";
import { ViewGlyph, viewGlyphAtom } from "./view-glyph";
import { folderKey, ItemAttr, ListDrag, ListDragState, tabKey } from "./view-list-drag";
import { openViewPopover } from "./view-popover";

// What a folder shows of its views: each one's kind, for its name, and whether one has news (a badge, or an agent that
// waits, ended or failed).
export function useFolderFacts(members: string[]): { kinds: ViewKindFact[]; news: boolean } {
    const key = members.join("\u0001");
    const factsAtom = useMemo(
        () =>
            atom((get) => {
                const states = get(AgentStates.getInstance().dataAtom);
                let news = false;
                const kinds = members.map((id) => {
                    const tab = get(getWaveObjectAtom<Tab>(makeORef("tab", id)));
                    const blockIds = tab?.blockids ?? [];
                    const first = blockIds[0] ? get(getWaveObjectAtom<Block>(makeORef("block", blockIds[0]))) : null;
                    const meta = (first?.meta ?? {}) as Record<string, any>;
                    const agents = agentStatesOfBlocks(states, blockIds);
                    if (
                        viewHasNews(
                            get(getTabBadgeAtom(id)).length,
                            agents.map((a) => a.state)
                        )
                    ) {
                        news = true;
                    }
                    const url = pageUrlOfMeta(meta);
                    return viewKindOf(meta.view ?? "", url, agents.length > 0, registrableDomain(siteNameOf(url)));
                });
                return { kinds, news };
            }),
        [key]
    );
    return useAtomValue(factsAtom);
}

// The icon of a folder: up to four of its views' own icons, in miniature.
function FolderMini({ tabId }: { tabId: string }) {
    const glyph = useAtomValue(viewGlyphAtom(tabId));
    return (
        <span className="mt-fo-mini">
            <ViewGlyph icons={glyph.slice(0, 1)} small />
        </span>
    );
}

export function FolderIcon({ members }: { members: string[] }) {
    return (
        <span className="mt-fo-icon" aria-hidden data-testid="sidebar-folder-icon">
            {members.slice(0, MaxMiniatures).map((id) => (
                <FolderMini key={id} tabId={id} />
            ))}
        </span>
    );
}

// The view on screen that sits in a shut folder takes the rename shortcut: its rename page opens under the folder's row.
function FolderActiveRename({ tabId, anchorRef }: { tabId: string; anchorRef: React.RefObject<HTMLElement> }) {
    const [tab] = useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const pin = useViewPin(tabId, tab, identity.name);
    const env = useWaveEnv<SidebarEnv>();
    const start = useCallback(() => {
        const rect = anchorRef.current?.getBoundingClientRect();
        openViewPopover({
            kind: "rename",
            ref: { tabId },
            name: identity.name,
            icon: pin.icon,
            x: rect?.left ?? 0,
            y: rect?.bottom ?? 0,
        });
    }, [tabId, identity.name, pin.icon, anchorRef]);
    useRenameCallback(tabId, env, start);
    return null;
}

// A folder's row in the Views list.
export function FolderRow({
    folder,
    members,
    activeTabId,
    state,
    drag,
}: {
    folder: ViewFolder;
    members: string[];
    activeTabId: string;
    state: ListDragState;
    drag: ListDrag;
}) {
    const t = useT();
    const tCount = useTCount();
    const env = useWaveEnv<SidebarEnv>();
    const rowRef = useRef<HTMLDivElement>(null);
    const facts = useFolderFacts(members);
    const open = useAtomValue(openFolderAtom) === folder.id;
    const name = folderShownName(folder, facts.kinds, t);
    const active = activeTabId != null && members.includes(activeTabId);
    const key = folderKey(folder.id);
    const dragging = state?.key === key;
    const ringed = state?.target === key;
    const dropBefore =
        state != null && !state.out && !state.inFrame && state.before === key && !dragging && state.target == null;
    const label = [
        tCount("sidebar.folders.rowLabel", members.length, { name }),
        facts.news ? t("sidebar.folders.news") : null,
    ]
        .filter(Boolean)
        .join(", ");
    const toggle = () => {
        if (drag.takeClick()) {
            return;
        }
        if (open) {
            closeFolder();
            return;
        }
        openFolder(folder.id);
    };
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        env.showContextMenu(
            [
                { type: "header", label: `${name} · ${t("sidebar.folders.menu.header")}` },
                { label: t("sidebar.folders.menu.open"), icon: "folder-open", click: () => openFolder(folder.id) },
                {
                    label: t("sidebar.folders.menu.rename"),
                    icon: "pen",
                    click: () => {
                        globalStore.set(folderRenameAtom, true);
                        openFolder(folder.id);
                    },
                },
                { type: "separator" },
                {
                    label: t("sidebar.folders.menu.takeAllOut"),
                    icon: "arrow-up-from-bracket",
                    click: () => fireAndForget(() => dissolveViewFolder(folder.id)),
                },
            ],
            e
        );
    };
    return (
        <div
            ref={rowRef}
            role="button"
            tabIndex={0}
            className={cn(
                "mt-sb-row mt-fo-row relative flex min-h-[30px] w-full shrink-0 cursor-pointer items-center gap-2 rounded-6 px-2 text-left text-12 transition-colors duration-120 ease-mt",
                active
                    ? "mt-selected bg-white/15 text-primary"
                    : open
                      ? "bg-white/[0.12] text-primary"
                      : "text-secondary hover:bg-white/[0.08] hover:text-primary",
                dragging && "mt-sb-dragged"
            )}
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-current={active ? "true" : undefined}
            title={name}
            data-testid="sidebar-folder-row"
            data-folder-id={folder.id}
            data-fo-target={ringed ? "true" : undefined}
            data-fo-cap={ringed ? (state.cap ?? t("sidebar.folders.addTo", { name })) : undefined}
            {...{ [ItemAttr]: key }}
            onClick={toggle}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openFolder(folder.id);
                }
            }}
            onMouseDown={(e) => drag.onMouseDown(e, key)}
            onContextMenu={onContextMenu}
        >
            {dropBefore ? (
                <span className="pointer-events-none absolute -top-px right-1 left-1 h-[2px] rounded-full bg-accent" />
            ) : null}
            <FolderIcon members={members} />
            <span className="name min-w-0 flex-1 truncate font-semibold text-primary">{name}</span>
            <span className="mt-fo-count shrink-0 text-11 text-muted" data-testid="sidebar-folder-count">
                {members.length}
            </span>
            {facts.news ? <span className="mt-fo-dot" data-testid="sidebar-folder-news" aria-hidden /> : null}
            {active && !open ? <FolderActiveRename tabId={activeTabId} anchorRef={rowRef} /> : null}
        </div>
    );
}

// A view of the grid: its icon, its name, its marks; a click opens it and closes the folder.
function FolderCell({
    tabId,
    folderId,
    active,
    focusable,
    index,
    drag,
    state,
    frame,
    onOpened,
}: {
    tabId: string;
    folderId: string;
    active: boolean;
    focusable: boolean;
    index: number;
    drag: ListDrag;
    state: ListDragState;
    frame: () => HTMLElement;
    onOpened: () => void;
}) {
    const [tab] = useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const identity = useTabIdentity(tabId, tab?.name ?? "");
    const pin = useViewPin(tabId, tab, identity.name);
    const glyph = useAtomValue(viewGlyphAtom(tabId));
    const elRef = useRef<HTMLDivElement>(null);
    const startRename = useCallback(() => {
        const rect = elRef.current?.getBoundingClientRect();
        openViewPopover({
            kind: "rename",
            ref: { tabId },
            name: identity.name,
            icon: pin.icon,
            x: rect?.left ?? 0,
            y: rect?.bottom ?? 0,
        });
    }, [tabId, identity.name, pin.icon]);
    const { env, close, onContextMenu } = useViewActions(tabId, active, pin, startRename, false, true, () =>
        folderMenuFor(tabId)
    );
    useRenameCallback(tabId, env, startRename);
    const badges = useAtomValue(getTabBadgeAtom(tabId, env));
    const open = () => {
        if (drag.takeClick()) {
            return;
        }
        getApi().setActiveTab(tabId);
        onOpened();
    };
    return (
        <div
            ref={elRef}
            role="button"
            tabIndex={focusable ? 0 : -1}
            className={cn(
                "mt-fo-cell cursor-pointer",
                active && "mt-selected",
                state?.key === tabKey(tabId) && "mt-sb-dragged"
            )}
            aria-current={active ? "page" : undefined}
            aria-label={identity.name}
            title={identity.name}
            data-testid="sidebar-folder-cell"
            data-tab-id={tabId}
            data-cell-index={index}
            onClick={open}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    getApi().setActiveTab(tabId);
                    onOpened();
                }
            }}
            onMouseDown={(e) => drag.onMouseDown(e, tabKey(tabId), { folderId, frame })}
            onAuxClick={(e) => {
                if (e.button !== 1) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                close();
            }}
            onContextMenu={onContextMenu}
        >
            <span className="mt-fo-cell-icon">
                <ViewGlyph icons={glyph} />
            </span>
            <span className="name mt-fo-cell-name">{identity.name}</span>
            <span className="mt-fo-cell-marks">
                <TabReviewMark done={identity.reviewDone} />
                <TabAgentMark info={identity.agent} />
                <TabBadges badges={badges} className="static w-auto translate-y-0" />
            </span>
        </div>
    );
}

function cellsOf(grid: HTMLElement): HTMLElement[] {
    return Array.from(grid?.querySelectorAll<HTMLElement>("[data-cell-index]") ?? []);
}

// How many cells a grid row holds, read from where the browser laid them.
function columnsOf(cells: HTMLElement[]): number {
    if (cells.length === 0) {
        return 1;
    }
    const top = cells[0].offsetTop;
    const first = cells.findIndex((c) => c.offsetTop !== top);
    return first < 0 ? cells.length : first;
}

// The cell a key moves the focus to, from the one at index among count cells in rows of columns.
export function gridMove(key: string, index: number, count: number, columns: number): number {
    const last = count - 1;
    switch (key) {
        case "ArrowRight":
            return Math.min(last, index + 1);
        case "ArrowLeft":
            return Math.max(0, index - 1);
        case "ArrowDown":
            return index + columns <= last ? index + columns : index;
        case "ArrowUp":
            return index - columns >= 0 ? index - columns : index;
        case "Home":
            return 0;
        case "End":
            return last;
        default:
            return index;
    }
}

export function FolderGrid({
    host,
    folder,
    members,
    activeTabId,
    state,
    drag,
}: {
    host: HTMLElement;
    folder: ViewFolder;
    members: string[];
    activeTabId: string;
    state: ListDragState;
    drag: ListDrag;
}) {
    const t = useT();
    const facts = useFolderFacts(members);
    const shown = folderShownName(folder, facts.kinds, t);
    const frameRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const [top, setTop] = useState(8);
    const [name, setName] = useState(shown);
    const [focused, setFocused] = useState(() => Math.max(0, members.indexOf(activeTabId)));
    const pendingFocus = useRef<string>(null);
    const nameFocused = useRef(false);
    useEffect(() => {
        if (!nameFocused.current) {
            setName(shown);
        }
    }, [shown]);
    // Placed beside its row, kept inside what it dims, before the first paint.
    useLayoutEffect(() => {
        const frame = frameRef.current;
        const row = host.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(folder.id)}"]`);
        if (frame == null) {
            return;
        }
        const rowTop = row == null ? 8 : row.getBoundingClientRect().top - host.getBoundingClientRect().top - 8;
        setTop(Math.max(8, Math.min(rowTop, host.clientHeight - frame.offsetHeight - 8)));
    }, [host, folder.id, members.length]);
    const focusCell = (index: number) => {
        const cells = cellsOf(gridRef.current);
        const cell = cells[Math.max(0, Math.min(cells.length - 1, index))];
        setFocused(Number(cell?.dataset.cellIndex ?? 0));
        cell?.focus();
    };
    // The grid opens with the focus on the view on screen, or on its name field when asked to rename.
    useEffect(() => {
        if (globalStore.get(folderRenameAtom)) {
            globalStore.set(folderRenameAtom, false);
            nameRef.current?.focus();
            nameRef.current?.select();
            return;
        }
        focusCell(Math.max(0, members.indexOf(activeTabId)));
    }, []);
    useEffect(() => {
        const id = pendingFocus.current;
        if (id == null) {
            return;
        }
        pendingFocus.current = null;
        const at = members.indexOf(id);
        if (at >= 0) {
            focusCell(at);
        }
    }, [members.join("\u0001")]);
    const shut = useCallback(() => {
        closeFolder();
        requestAnimationFrame(() =>
            host.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(folder.id)}"]`)?.focus()
        );
    }, [host, folder.id]);
    // Escape closes the folder wherever the focus is: a view closed from the grid takes the focus with it. A field that
    // keeps Escape for itself (the name's) stops it before it reaches the document.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") {
                return;
            }
            e.preventDefault();
            shut();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [shut]);
    // A press anywhere outside the frame closes the folder.
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (!frameRef.current?.contains(e.target as Node)) {
                closeFolder();
            }
        };
        document.addEventListener("mousedown", onDown, true);
        return () => document.removeEventListener("mousedown", onDown, true);
    }, []);
    const commitName = () => {
        nameFocused.current = false;
        const next = name.trim();
        if (next === shown) {
            return;
        }
        fireAndForget(() => renameViewFolder(folder.id, next));
        if (next === "") {
            setName(shown);
        }
    };
    const onGridKey = (e: React.KeyboardEvent) => {
        const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cell-index]");
        if (cell == null) {
            return;
        }
        const index = Number(cell.dataset.cellIndex);
        const tabId = cell.dataset.tabId;
        const step = dotMoveKey(e.nativeEvent);
        if (step != null) {
            e.preventDefault();
            pendingFocus.current = tabId;
            fireAndForget(() => moveViewInFolder(folder.id, tabId, step));
            return;
        }
        if (e.altKey || e.metaKey || e.ctrlKey) {
            return;
        }
        const cells = cellsOf(gridRef.current);
        const next = gridMove(e.key, index, cells.length, columnsOf(cells));
        if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            focusCell(next);
        }
    };
    return (
        <div
            className="mt-fo-overlay"
            data-testid="sidebar-folder-overlay"
            data-away={state?.away ? "true" : undefined}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                    shut();
                }
            }}
        >
            <div
                ref={frameRef}
                role="dialog"
                aria-label={t("sidebar.folders.dialogLabel", { name: shown })}
                className="mt-fo-frame"
                data-testid="sidebar-folder-frame"
                style={{ top }}
            >
                <input
                    ref={nameRef}
                    className="mt-fo-name"
                    value={name}
                    maxLength={MaxFolderNameLength}
                    aria-label={t("sidebar.folders.nameLabel")}
                    spellCheck={false}
                    autoComplete="off"
                    data-testid="sidebar-folder-name"
                    onFocus={() => {
                        nameFocused.current = true;
                    }}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                            e.preventDefault();
                            nameRef.current?.blur();
                            focusCell(focused);
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            setName(shown);
                            nameFocused.current = false;
                            focusCell(focused);
                        }
                    }}
                />
                <div
                    ref={gridRef}
                    role="group"
                    aria-label={t("sidebar.folders.gridLabel", { name: shown })}
                    className="mt-fo-grid"
                    data-testid="sidebar-folder-grid"
                    onKeyDown={onGridKey}
                    onFocus={(e) => {
                        const index = (e.target as HTMLElement).closest<HTMLElement>("[data-cell-index]")?.dataset
                            .cellIndex;
                        if (index != null) {
                            setFocused(Number(index));
                        }
                    }}
                >
                    {members.map((id, i) => (
                        <FolderCell
                            key={id}
                            tabId={id}
                            folderId={folder.id}
                            active={id === activeTabId}
                            focusable={i === focused || (focused >= members.length && i === 0)}
                            index={i}
                            drag={drag}
                            state={state}
                            frame={() => frameRef.current}
                            onOpened={shut}
                        />
                    ))}
                </div>
                <span className="mt-fo-hint">{t("sidebar.folders.hint")}</span>
            </div>
        </div>
    );
}

// The open folder, over the sidebar's scrolling part (FR-SHELL-080): drawn in that part's own box, so the rest of the
// sidebar keeps its place and the dimmed list can still be reached by a drag out of the frame.
export function FolderOverlay({
    asideRef,
    items,
    activeTabId,
    state,
    drag,
}: {
    asideRef: React.RefObject<HTMLElement>;
    items: SidebarItem[];
    activeTabId: string;
    state: ListDragState;
    drag: ListDrag;
}) {
    const openId = useAtomValue(openFolderAtom);
    const [host, setHost] = useState<HTMLElement>(null);
    const item = items.find((i) => i.kind === "folder" && i.folder.id === openId);
    useLayoutEffect(() => {
        setHost(openId == null ? null : (asideRef.current?.querySelector<HTMLElement>(".mt-sb-viewport") ?? null));
    }, [openId, asideRef]);
    useEffect(() => {
        if (openId != null && item == null) {
            closeFolder();
        }
    }, [openId, item == null]);
    if (host == null || item == null || item.kind !== "folder") {
        return null;
    }
    return createPortal(
        <FolderGrid
            key={item.folder.id}
            host={host}
            folder={item.folder}
            members={item.members}
            activeTabId={activeTabId}
            state={state}
            drag={drag}
        />,
        host
    );
}
