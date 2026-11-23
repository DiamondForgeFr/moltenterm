// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Dragging in the Views list (FR-SHELL-080, FR-SHELL-081, #2484). A view row dragged up or down reorders, out of the
// sidebar onto the panels it joins the view on screen (#414), onto the tiles or the top row it is pinned. Held a moment
// over another view or a folder's row it rings it, and a release there makes a folder or fills one, as on a phone's home
// screen; a release between rows only reorders. A folder's row reorders as a whole. A view of an open folder's grid is
// dragged the same way: out of the grid's frame it leaves the folder, wherever it is released in the list. Escape puts
// the drag back. The dragged row dims in its place and a copy of it follows the pointer.

import { atoms } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useRef, useState } from "react";
import { finishTabPanelDrag, trackTabPanelDrag } from "../split/drop-zones";
import { DragThresholdPx, finishDrop, setDrag, usableHit, zoneAt, ZoneHit } from "./sidebar-drag";
import { dropTargetAt, moveTabBefore } from "./sidebar-model";
import {
    Dwell,
    dwellDone,
    folderCandidateAt,
    FolderDwellMs,
    nextDwell,
    RowSlot,
    SidebarItem,
} from "./view-folders-model";
import {
    addViewToFolder,
    anchorOfFolder,
    closeFolder,
    dropViewOnView,
    moveFolderBefore,
    TakeOutPlace,
    takeViewOut,
} from "./view-folders-store";
import { sameOrder } from "./view-menu-model";

export const ItemAttr = "data-item-key";
// The copy of the dragged row rides a little below and right of the pointer, so that the row under the pointer, its ring
// and its caption, stay in sight.
const GhostOffsetPx = { x: 10, y: 16 };
const TabKeyPrefix = "tab:";
const FolderKeyPrefix = "folder:";

export function tabKey(tabId: string): string {
    return `${TabKeyPrefix}${tabId}`;
}

export function folderKey(folderId: string): string {
    return `${FolderKeyPrefix}${folderId}`;
}

function tabIdOfKey(key: string): string {
    return key?.startsWith(TabKeyPrefix) ? key.slice(TabKeyPrefix.length) : null;
}

function folderIdOfKey(key: string): string {
    return key?.startsWith(FolderKeyPrefix) ? key.slice(FolderKeyPrefix.length) : null;
}

// What the list draws of a drag: the item dragged, the item the drop lands before (null: at the end), whether it is out
// of the list (over the panels or a pin zone), the item rung to make or fill a folder, and, for a view of a folder's
// grid, whether the pointer is out of the grid's frame.
export type ListDragState = {
    key: string;
    before: string;
    out: boolean;
    target: string;
    away: boolean;
    // A view still inside its folder's frame: the list shows no place for it.
    inFrame: boolean;
};

// A view dragged from a folder's grid: the folder, and its frame, out of which the view leaves it.
export type ListDragSource = { folderId: string; frame: () => HTMLElement };

export type ListDrag = {
    onMouseDown: (e: React.MouseEvent, key: string, source?: ListDragSource) => void;
    // A click that ends a drag is not a click on what is under the pointer.
    takeClick: () => boolean;
};

function sameState(a: ListDragState, b: ListDragState): boolean {
    return (
        a === b ||
        (a != null &&
            b != null &&
            a.key === b.key &&
            a.before === b.before &&
            a.out === b.out &&
            a.target === b.target &&
            a.away === b.away &&
            a.inFrame === b.inFrame)
    );
}

function slotsOf(list: HTMLElement): RowSlot[] {
    return Array.from(list?.querySelectorAll<HTMLElement>(`[${ItemAttr}]`) ?? []).map((el) => {
        const r = el.getBoundingClientRect();
        return { key: el.getAttribute(ItemAttr), top: r.top, height: r.height };
    });
}

// The name a row shows (its tab's name, or its first panel's title), for the toast of a pin by drag.
function rowName(list: HTMLElement, tabId: string): string {
    const row = list?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"] .name`);
    return row?.textContent ?? "";
}

// A copy of the row that follows the pointer: the same markup, without what a test or a script finds a row by.
function makeGhost(from: HTMLElement): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "mt-sb mt-fo-ghost";
    ghost.setAttribute("aria-hidden", "true");
    const copy = from.cloneNode(true) as HTMLElement;
    for (const el of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>("*"))]) {
        for (const attr of ["data-testid", ItemAttr, "data-tab-id", "data-folder-id", "id", "tabindex"]) {
            el.removeAttribute(attr);
        }
    }
    ghost.style.width = `${from.getBoundingClientRect().width}px`;
    ghost.appendChild(copy);
    document.body.appendChild(ghost);
    return ghost;
}

function inRect(x: number, y: number, r: DOMRect): boolean {
    return r != null && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

export function useViewListDrag(
    listRef: React.RefObject<HTMLDivElement>,
    asideRef: React.RefObject<HTMLElement>,
    ids: string[],
    items: SidebarItem[]
) {
    const ws = useAtomValue(atoms.workspace);
    const [state, setState] = useState<ListDragState>(null);
    const suppressClickRef = useRef(false);
    const idsRef = useRef(ids);
    idsRef.current = ids;
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const wsRef = useRef(ws);
    wsRef.current = ws;
    const shown = useRef<ListDragState>(null);
    const show = (next: ListDragState) => {
        if (!sameState(shown.current, next)) {
            shown.current = next;
            setState(next);
        }
    };
    const onMouseDown = (e: React.MouseEvent, key: string, source?: ListDragSource) => {
        if (e.button !== 0) {
            return;
        }
        const tabId = tabIdOfKey(key);
        const folderId = folderIdOfKey(key);
        const startX = e.clientX;
        const startY = e.clientY;
        const rowEl = e.currentTarget as HTMLElement;
        const grab = { x: startX - rowEl.getBoundingClientRect().left, y: startY - rowEl.getBoundingClientRect().top };
        let started = false;
        let cancelled = false;
        let before: string = null;
        let out = false;
        let away = false;
        let hit: ZoneHit = null;
        let ghost: HTMLElement = null;
        let dwell: Dwell = null;
        let ringed: string = null;
        let timer: ReturnType<typeof setTimeout> = null;
        const publish = () =>
            show({
                key,
                before,
                out: out || hit != null,
                target: ringed,
                away,
                inFrame: source != null && !away,
            });
        const watch = (candidate: string) => {
            const next = nextDwell(dwell, candidate, Date.now());
            if (next === dwell) {
                return;
            }
            dwell = next;
            ringed = null;
            clearTimeout(timer);
            if (next != null) {
                timer = setTimeout(() => {
                    if (dwell === next && !cancelled) {
                        ringed = next.key;
                        publish();
                    }
                }, FolderDwellMs);
            }
        };
        const onMove = (ev: MouseEvent) => {
            if (!started) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DragThresholdPx) {
                    return;
                }
                started = true;
                ghost = makeGhost(rowEl);
            }
            ghost.style.transform = `translate(${ev.clientX - grab.x + GhostOffsetPx.x}px, ${ev.clientY - grab.y + GhostOffsetPx.y}px) rotate(-2deg)`;
            if (cancelled) {
                return;
            }
            const frame = source?.frame();
            away = source != null && !inRect(ev.clientX, ev.clientY, frame?.getBoundingClientRect());
            if (source != null && !away) {
                before = null;
                out = false;
                hit = null;
                watch(null);
                publish();
                return;
            }
            const right = asideRef.current?.getBoundingClientRect().right ?? Infinity;
            out =
                tabId != null &&
                trackTabPanelDrag(
                    ev,
                    tabId,
                    asideRef.current,
                    () => {},
                    (p) => p.clientX > right
                );
            // Over the tiles or the top row, the view would be pinned there (FR-SHELL-081).
            hit = out || tabId == null ? null : usableHit("row", zoneAt(ev.clientX, ev.clientY), true);
            const slots = slotsOf(listRef.current);
            before =
                out || hit != null
                    ? null
                    : dropTargetAt(
                          ev.clientY,
                          slots.map((s) => ({ id: s.key, ...s }))
                      );
            watch(tabId != null && !out && hit == null ? folderCandidateAt(ev.clientY, slots, key) : null);
            if (tabId != null) {
                setDrag({
                    kind: "row",
                    id: tabId,
                    zone: hit?.zone ?? null,
                    key: hit?.key ?? null,
                    after: hit?.after ?? false,
                    pinnable: true,
                });
            }
            publish();
        };
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key !== "Escape" || !started) {
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            cancelled = true;
            watch(null);
            before = null;
            ringed = null;
            hit = null;
            show(null);
            setDrag(null);
        };
        const onUp = (ev: MouseEvent) => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.removeEventListener("keydown", onKey, true);
            clearTimeout(timer);
            ghost?.remove();
            // A timer a loaded machine delayed past the dwell has not rung the row yet: the release still counts it.
            const target = ringed ?? (dwellDone(dwell, Date.now()) ? dwell.key : null);
            shown.current = null;
            setState(null);
            setDrag(null);
            if (!started) {
                return;
            }
            suppressClickRef.current = true;
            setTimeout(() => {
                suppressClickRef.current = false;
            }, 0);
            const handed = tabId != null ? finishTabPanelDrag(ev) : false;
            if (cancelled || handed || (tabId != null && out)) {
                return;
            }
            if (source != null && !away) {
                return;
            }
            if (tabId != null && hit != null) {
                finishDrop("row", tabId, hit, rowName(listRef.current, tabId));
                if (source != null) {
                    closeFolder();
                }
                return;
            }
            if (tabId != null && target != null) {
                const overTab = tabIdOfKey(target);
                const overFolder = folderIdOfKey(target);
                if (overTab != null) {
                    fireAndForget(() => dropViewOnView(tabId, overTab));
                } else if (overFolder != null) {
                    fireAndForget(() => addViewToFolder(overFolder, tabId));
                }
                if (source != null) {
                    closeFolder();
                }
                return;
            }
            const place = anchorOf(before);
            if (source != null) {
                const where: TakeOutPlace = place != null ? { before: place } : { end: true };
                fireAndForget(() => takeViewOut(tabId, where));
                closeFolder();
                return;
            }
            const current = idsRef.current;
            const workspace = wsRef.current;
            if (folderId != null) {
                fireAndForget(() => moveFolderBefore(folderId, place));
                return;
            }
            if (place === tabId || (place == null && lastTabOf(itemsRef.current, current) === tabId)) {
                return;
            }
            const order = workspace?.tabids ?? [];
            const next = moveTabBefore(order, tabId, place ?? afterLastTemporary(order, current));
            if (!sameOrder(next, order)) {
                fireAndForget(() => RpcApi.UpdateWorkspaceTabIdsCommand(TabRpcClient, workspace.oid, next));
            }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.addEventListener("keydown", onKey, true);
    };
    const takeClick = () => {
        const taken = suppressClickRef.current;
        suppressClickRef.current = false;
        return taken;
    };
    return { state, drag: { onMouseDown, takeClick } as ListDrag };
}

// The tab a drop before an item lands before: the view's own, or the first view of a folder.
function anchorOf(key: string): string {
    if (key == null) {
        return null;
    }
    return tabIdOfKey(key) ?? anchorOfFolder(folderIdOfKey(key));
}

// The tab the Views list ends on: a view's own, or the last view of the folder that ends it.
function lastTabOf(items: SidebarItem[], ids: string[]): string {
    const last = items[items.length - 1];
    if (last == null) {
        return null;
    }
    return last.kind === "view" ? last.tabId : ids[ids.length - 1];
}

// The tab a view dropped after the list's last row lands before: the one following it in the workspace's order.
function afterLastTemporary(order: string[], temporary: string[]): string {
    const last = temporary[temporary.length - 1];
    const at = order.indexOf(last);
    return at >= 0 && at + 1 < order.length ? order[at + 1] : null;
}
