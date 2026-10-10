// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Drag to split (FR-SHELL-060, DS-SHELL-102), wired to the app: the panels of the shown tab are hit-tested from the
// page, a drop is carried out on the layout, and the tab bar's own drag (tabbar.tsx) hands its tab over here once the
// pointer leaves the strip downwards. drop-zones-overlay.tsx draws the ghost; react-dnd file drags and the Sessions
// rows' HTML5 drags are followed there.

import { atoms, getApi, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { LayoutTreeResizeNodeAction } from "@/layout/index";
import { deleteLayoutModelForTab, getLayoutModelForStaticTab, LayoutTreeActionType } from "@/layout/index";
import { goHistory } from "@/util/historyutil";
import { atom, PrimitiveAtom } from "jotai";
import type { DragEvent } from "react";
import { DurableSessions } from "../sessions/sessions-store";
import { DragItem, DropAction, DropTarget, halfSizes, SessionDragType, tabDraggedOut } from "./drop-model";
import { DropSession, DropState } from "./drop-session";
import { insertBlockBeside } from "./split";

// pkg/molten/panelmove: the route that moves a tab's main panel into the tab shown.
const PanelMoveRoute = "molten:panelmove";
const PanelMoveCommand = "moltenpanelmove";
const PanelMoveTimeoutMs = 8000;
// A session reattached by wavesrv is laid out by the tab's renderer a moment later; its size is set once it shows.
const NodeWaitMs = 3000;

export const DraggingClass = "molten-panel-dragging";

type PanelMoveResult = { blockid: string; sourceempty?: boolean; workspaceid?: string };

export const panelDropStateAtom = atom(null) as PrimitiveAtom<DropState>;

function blockMeta(blockId: string): MetaType {
    return globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))?.meta;
}

// The topmost panel of the shown tab under the point: a magnified panel covers the others.
export function hitTestPanels(x: number, y: number): DropTarget {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(".block[data-blockid]:not(.block-preview)"));
    const magnified = blocks.filter((elem) => elem.classList.contains("magnified"));
    const candidates = magnified.length > 0 ? magnified : blocks;
    for (const elem of candidates) {
        if (elem.closest(".tile-preview") != null) {
            continue;
        }
        const r = elem.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || x < r.left || x > r.right || y < r.top || y > r.bottom) {
            continue;
        }
        const blockId = elem.dataset.blockid;
        const meta = blockMeta(blockId);
        return {
            blockId,
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            view: meta?.view ?? "",
            connection: meta?.connection ?? "",
            folder: elem.querySelector(".dir-table") != null,
        };
    }
    return null;
}

async function waitForNode(blockId: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (getLayoutModelForStaticTab()?.getNodeByBlockId(blockId) != null) {
            return true;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return false;
}

async function moveTabPanel(action: Extract<DropAction, { type: "move-tab-panel" }>) {
    const toTabId = globalStore.get(atoms.staticTabId);
    const res: PanelMoveResult = await TabRpcClient.wshRpcCall(
        PanelMoveCommand,
        { fromtabid: action.tabId, totabid: toTabId },
        { route: PanelMoveRoute, timeout: PanelMoveTimeoutMs }
    );
    if (!res?.blockid) {
        return;
    }
    insertBlockBeside(action.targetBlockId, action.direction, res.blockid);
    if (res.sourceempty && res.workspaceid) {
        // The block left the tab first, so closing the empty tab deletes nothing.
        const closed = await getApi().closeTab(res.workspaceid, action.tabId, false);
        if (closed) {
            deleteLayoutModelForTab(action.tabId);
        }
    }
}

async function openFile(action: Extract<DropAction, { type: "open-file" }>) {
    const blockId = await ObjectService.CreateBlock(action.blockDef, { termsize: { rows: 25, cols: 80 } });
    if (!insertBlockBeside(action.targetBlockId, action.direction, blockId)) {
        await ObjectService.DeleteBlock(blockId);
    }
}

// The preview under the pointer opens the file, through its history (the back button returns to what it showed).
async function openFileHere(action: Extract<DropAction, { type: "open-file-here" }>) {
    const meta = blockMeta(action.targetBlockId);
    const update = goHistory("file", (meta?.file as string) ?? "", action.path, meta);
    if (update == null) {
        return;
    }
    await ObjectService.UpdateObjectMeta(WOS.makeORef("block", action.targetBlockId), update);
}

async function resumeSession(action: Extract<DropAction, { type: "resume-session" }>) {
    const layoutModel = getLayoutModelForStaticTab();
    const targetSize = layoutModel?.getNodeByBlockId(action.targetBlockId)?.size;
    const loc = await DurableSessions.getInstance().showBeside(action.id, action.targetBlockId, action.direction);
    if (!loc?.created || !loc.blockid || !(await waitForNode(loc.blockid, NodeWaitMs))) {
        return;
    }
    const target = layoutModel.getNodeByBlockId(action.targetBlockId);
    const added = layoutModel.getNodeByBlockId(loc.blockid);
    if (target == null || added == null) {
        return;
    }
    const sizes = halfSizes(targetSize);
    layoutModel.treeReducer({
        type: LayoutTreeActionType.ResizeNode,
        resizeOperations: [
            { nodeId: target.id, size: sizes.target },
            { nodeId: added.id, size: sizes.added },
        ],
    } as LayoutTreeResizeNodeAction);
}

export async function performDrop(action: DropAction): Promise<void> {
    switch (action?.type) {
        case "move-tab-panel":
            return moveTabPanel(action);
        case "open-file":
            return openFile(action);
        case "open-file-here":
            return openFileHere(action);
        case "resume-session":
            return resumeSession(action);
    }
}

export const panelDrop = new DropSession({
    hitTest: hitTestPanels,
    activeTabId: () => globalStore.get(atoms.staticTabId),
    perform: performDrop,
});

// Escape cancels the drag before any other handler of the window (the tab bar's drag has no Escape of its own).
function onKeyDown(e: KeyboardEvent) {
    if (!panelDrop.handleKey(e.key)) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
}

let keyListening = false;
panelDrop.subscribe((state) => {
    globalStore.set(panelDropStateAtom, state);
    const on = state != null;
    document.body.classList.toggle(DraggingClass, on);
    if (on && !keyListening) {
        window.addEventListener("keydown", onKeyDown, true);
        keyListening = true;
    } else if (!on && keyListening) {
        window.removeEventListener("keydown", onKeyDown, true);
        keyListening = false;
    }
});

// A Sessions row that would open in a new pane can be dragged onto a panel; one already in a pane is shown where it is
// (its row's Show), so it has nothing to drop.
export function sessionRowDragProps(session: { id: string; shown: boolean; canshow: boolean }, name: string) {
    if (session == null || session.shown || !session.canshow) {
        return { draggable: false };
    }
    return {
        draggable: true,
        onDragStart: (e: DragEvent<HTMLElement>) => {
            // react-dnd's backend, on the window, cancels any drag it did not start itself.
            e.stopPropagation();
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(SessionDragType, session.id);
            panelDrop.begin({ kind: "session", id: session.id, name });
        },
        onDragEnd: () => {
            // A drop already ended the session; Escape or a release elsewhere ends it here.
            if (panelDrop.state?.item.kind === "session") {
                panelDrop.cancel();
            }
        },
    };
}

// The name the tab bar shows (a generic "T2" is shown as its first panel's title, FR-SHELL-056).
function tabName(tabId: string): string {
    const shown = document.querySelector(`[data-tab-id="${CSS.escape(tabId)}"] .name`)?.textContent?.trim();
    if (shown) {
        return shown;
    }
    return globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)))?.name ?? "Tab";
}

// The tab drag of the tab bar, per mouse move. Below the strip, the tab is dragged onto the panels: true then, and
// the tab bar leaves its tab in its slot instead of reordering. Back on the strip, it reorders again. A drag that
// Escape cancelled stays inert until the button is released.
type TabDragHandover = { tabId: string; cancelled: boolean; out: boolean };
let tabHandover: TabDragHandover = null;

export function trackTabPanelDrag(
    event: Pick<MouseEvent, "clientX" | "clientY">,
    tabId: string,
    strip: HTMLElement,
    keepTabInSlot: () => void
): boolean {
    // The tab shown has no other panels to land on.
    if (!tabId || strip == null || tabId === globalStore.get(atoms.staticTabId)) {
        return false;
    }
    if (tabHandover == null || tabHandover.tabId !== tabId) {
        tabHandover = { tabId, cancelled: false, out: false };
    }
    if (tabHandover.cancelled) {
        return true;
    }
    const out = tabDraggedOut(event.clientY, strip.getBoundingClientRect().bottom);
    if (!out) {
        if (tabHandover.out) {
            tabHandover.out = false;
            panelDrop.cancel();
        }
        return false;
    }
    if (!tabHandover.out) {
        tabHandover.out = true;
        keepTabInSlot();
        const item: DragItem = { kind: "tab", tabId, name: tabName(tabId) };
        const unsubscribe = panelDrop.subscribe((state) => {
            if (state != null) {
                return;
            }
            unsubscribe();
            // Ended without a drop while still out of the strip: Escape.
            if (tabHandover?.tabId === tabId && tabHandover.out) {
                tabHandover.cancelled = true;
            }
        });
        panelDrop.begin(item, event.clientX, event.clientY);
        return true;
    }
    panelDrop.move(event.clientX, event.clientY);
    return true;
}

// The tab bar's mouse up: drops the tab on the panel under the pointer when it was dragged out of the strip. True
// when the drag was handed over (dropped or cancelled), so the tab bar keeps its order as it was.
export function finishTabPanelDrag(event: Pick<MouseEvent, "clientX" | "clientY">): boolean {
    const handover = tabHandover;
    tabHandover = null;
    if (handover == null) {
        return false;
    }
    if (handover.out && !handover.cancelled) {
        handover.out = false;
        panelDrop.drop(event.clientX, event.clientY);
        return true;
    }
    return handover.cancelled;
}
