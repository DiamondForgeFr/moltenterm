// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Clear (FR-SHELL-080, #1253): "↓ Clear" closes the workspace's temporary views, never a pinned one. What their
// terminals run is read once and asked once (the busy-close guard, FR-SHELL-061); a view linked to a worktree keeps
// its own worktree dialog. Every close is recorded, so the toast's Undo (⌘Z too) reopens them through Reopen what was
// closed. The rows fold away before the closes land: the workspace's meta names them, so the view on screen plays it
// even when the clearing window's own view is among them.

import { atoms, getApi, globalStore, WOS } from "@/app/store/global";
import { loadAndPinWaveObject, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { RunningItem } from "../busy-close-model";
import { askBusyClose, busyCloseEnabled, ClosingTerminal, closingTerminalOf, readRunning } from "../busy-close-store";
import { prefersReducedMotion } from "../molten-motion";
import { recordingTabClose } from "../reopen/reopen-store";
import { closeTabAskingFirst } from "../worktree-close";
import { tabWorktrees } from "../worktree-model";
import { SidebarModel } from "./sidebar-store";
import { announceClosedViews, ClosedKindCleared, showSurvivor } from "./view-pins-store";

// The workspace's meta naming the rows folding away, and how long that stays true without its end.
export const ClearingMetaKey = "molten:clearingviews";
export const ClearingFreshMs = 10000;

// The fold of one row, the gap between two rows, and the most the gaps add up to.
export const FoldMs = 200;
export const FoldStaggerMs = 30;
export const FoldStaggerMaxMs = 150;

export type ClearingMark = { ids: string[]; at: number; id: string };

// The delay of the row at index among count folding rows, top first: a long list still folds within the bound.
export function foldDelayMs(index: number, count: number): number {
    if (count <= 1) {
        return 0;
    }
    const step = Math.min(FoldStaggerMs, FoldStaggerMaxMs / (count - 1));
    return Math.round(index * step);
}

// How long count rows take to fold away, the separator's fade waiting for them.
export function foldTotalMs(count: number, reduced = false): number {
    if (reduced || count <= 0) {
        return 0;
    }
    return foldDelayMs(count - 1, count) + FoldMs;
}

// The rows a fresh mark folds; an old one (a clearing window that died) folds nothing.
export function clearingIds(mark: unknown, now: number): Set<string> {
    const m = mark as ClearingMark;
    if (m == null || !Array.isArray(m.ids) || typeof m.at !== "number" || now - m.at > ClearingFreshMs) {
        return new Set();
    }
    return new Set(m.ids);
}

export type ClearView = { tabId: string; blocks: Block[] };

export type ClearDeps = {
    workspaceId: string;
    ownTabId: string;
    temporary: string[];
    loadView: (tabId: string) => Promise<ClearView>;
    busyEnabled: () => boolean;
    readRunning: (terminals: ClosingTerminal[]) => Promise<RunningItem[]>;
    askBusy: (running: RunningItem[]) => Promise<boolean>;
    // Brings a view that stays on screen; false when none does.
    showSurvivor: (closing: string[]) => Promise<boolean>;
    markClearing: (ids: string[]) => Promise<void>;
    endClearing: () => Promise<void>;
    wait: (ms: number) => Promise<void>;
    reducedMotion: () => boolean;
    // A recorded close that asks nothing more (the guard above asked).
    closeTab: (workspaceId: string, tabId: string) => Promise<boolean>;
    // A close with its worktree dialog (closeTabAskingFirst).
    closeAsking: (workspaceId: string, tabId: string) => Promise<boolean>;
    announce: (count: number) => Promise<void>;
};

async function closeEach(ids: string[], close: (tabId: string) => Promise<boolean>): Promise<number> {
    let closed = 0;
    for (const id of ids) {
        try {
            if (await close(id)) {
                closed++;
            }
        } catch (e) {
            console.log("clearing a temporary view", e);
        }
    }
    return closed;
}

// Clears the temporary views; resolves to how many closed (0 when the guard's Cancel kept them all).
export async function clearTemporaryViews(deps: ClearDeps): Promise<number> {
    const ids = [...(deps.temporary ?? [])];
    if (ids.length === 0 || !deps.workspaceId) {
        return 0;
    }
    const views = await Promise.all(ids.map((id) => deps.loadView(id)));
    const linked = new Set(
        views.filter((v) => tabWorktrees(v?.blocks ?? [], () => false).length > 0).map((v) => v.tabId)
    );
    const plain = ids.filter((id) => !linked.has(id));
    const plainBlocks = views.filter((v) => v != null && !linked.has(v.tabId)).flatMap((v) => v.blocks ?? []);
    const running = deps.busyEnabled()
        ? await deps.readRunning(plainBlocks.filter((b) => b != null).map(closingTerminalOf))
        : [];
    if (running.length > 0 && !(await deps.askBusy(running))) {
        return 0;
    }
    const own = deps.ownTabId;
    // A view on screen linked to a worktree asks its dialog here, last, so the window stays where the dialog shows.
    const ownLast = linked.has(own) ? own : null;
    let ownPlain = plain.includes(own) ? own : null;
    if (ownPlain != null && !(await deps.showSurvivor(ids))) {
        // Nothing else would stay: the view on screen does.
        ownPlain = null;
    }
    const folding = plain.filter((id) => id !== own || ownPlain != null);
    if (folding.length > 0) {
        await deps.markClearing(folding);
        await deps.wait(foldTotalMs(folding.length, deps.reducedMotion()));
    }
    const ws = deps.workspaceId;
    let closed = await closeEach(
        plain.filter((id) => id !== own),
        (id) => deps.closeTab(ws, id)
    );
    closed += await closeEach(
        [...linked].filter((id) => id !== own),
        (id) => deps.closeAsking(ws, id)
    );
    if (folding.length > 0) {
        await deps.endClearing();
    }
    if (ownPlain != null) {
        closed++;
    }
    if (closed > 0) {
        await deps.announce(closed);
    }
    if (ownPlain != null) {
        await deps.closeTab(ws, ownPlain);
    } else if (ownLast != null) {
        await deps.closeAsking(ws, ownLast);
    }
    return closed;
}

async function loadView(tabId: string): Promise<ClearView> {
    try {
        const tab = await loadAndPinWaveObject<Tab>(makeORef("tab", tabId));
        const blocks = await Promise.all(
            (tab?.blockids ?? []).map((id) => loadAndPinWaveObject<Block>(makeORef("block", id)))
        );
        return { tabId, blocks: blocks.filter((b) => b != null) };
    } catch (e) {
        console.log("reading a temporary view to clear", e);
        return { tabId, blocks: [] };
    }
}

function setClearingMeta(workspaceId: string, mark: ClearingMark): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("workspace", workspaceId),
        meta: { [ClearingMetaKey]: mark } as MetaType,
    });
}

// The window's Clear: the views the sidebar lists as temporary right now.
export function clearTemporary(): Promise<number> {
    const ws = globalStore.get(atoms.workspace);
    const workspaceId = ws?.oid;
    const close = recordingTabClose(getApi().closeTab);
    return clearTemporaryViews({
        workspaceId,
        ownTabId: globalStore.get(atoms.staticTabId),
        temporary: globalStore.get(SidebarModel.getInstance().tabSplitAtom)?.temporary ?? [],
        loadView,
        busyEnabled: busyCloseEnabled,
        readRunning: (terminals) => readRunning(terminals),
        askBusy: (running) => askBusyClose({ action: "clear", running }),
        showSurvivor,
        markClearing: (ids) =>
            setClearingMeta(workspaceId, { ids, at: Date.now(), id: `${Date.now()}-${Math.random()}` }),
        endClearing: () => setClearingMeta(workspaceId, null),
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        reducedMotion: () => prefersReducedMotion(),
        closeTab: (wsId, tabId) => close(wsId, tabId, false),
        closeAsking: (wsId, tabId) => closeTabAskingFirst(getApi().closeTab, wsId, tabId, false),
        announce: (count) => announceClosedViews(workspaceId, count, ClosedKindCleared),
    });
}
