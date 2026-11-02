// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One click closes a temporary view, with Undo (FR-SHELL-025 revision #1656). The view is set aside rather than
// closed: hidden and marked in the workspace's meta (view-set-aside-model.ts), so its blocks, shells and agents keep
// running and Undo gives it back with its panels, layout and place. When the toast leaves without Undo the view closes
// for good, recorded in Put-away views like any close. A view whose mark lost its toast (a quit) closes at the next
// look of the view on screen.

import { atoms, getApi, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { deleteLayoutModelForTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { HiddenTabsMetaKey } from "../hidden-tabs";
import { t } from "../i18n/i18n";
import { OpenerTabMetaKey } from "../opener-tab";
import { recordingTabClose, reopenLastQuietly } from "../reopen/reopen-store";
import { ToastDismissReason } from "../toast-model";
import { dismissToast } from "../toast-store";
import { showUndoToast } from "./sidebar-undo";
import {
    readSetAside,
    SetAsideMark,
    SetAsideMetaKey,
    setAsideStep,
    setAsideSurvivor,
    withHidden,
} from "./view-set-aside-model";

type Showing = { id: string; toastId: string; settled: boolean };

// The toast this renderer shows; one at most.
let showing: Showing = null;
// The marks whose view is closing for good: a workspace update during the close must not close it twice.
const finishing = new Set<string>();

function workspace(): Workspace {
    return globalStore.get(atoms.workspace);
}

function setWorkspaceMeta(workspaceId: string, meta: Record<string, any>): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("workspace", workspaceId),
        meta: meta as MetaType,
    });
}

// Sets the view aside in place of closing it; false when it cannot (no other view would show), and the caller closes
// it as before. A view set aside before closes for good first: one Undo at a time.
export async function setAsideView(workspaceId: string, tabId: string): Promise<boolean> {
    let ws = workspace();
    if (ws?.oid !== workspaceId || !(ws.tabids ?? []).includes(tabId)) {
        return false;
    }
    const previous = readSetAside(ws);
    if (previous != null && previous.tabid !== tabId) {
        dropShownToast();
        await finishSetAside(previous);
        ws = workspace();
    }
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    const wasactive = ws.activetabid === tabId;
    const survivor = setAsideSurvivor(ws, tabId, (tab?.meta as Record<string, any>)?.[OpenerTabMetaKey]);
    if (survivor == null) {
        return false;
    }
    const mark: SetAsideMark = { tabid: tabId, at: Date.now(), id: `${Date.now()}-${Math.random()}`, wasactive };
    await setWorkspaceMeta(workspaceId, {
        [SetAsideMetaKey]: mark,
        [HiddenTabsMetaKey]: withHidden(ws, tabId, true),
    });
    if (wasactive) {
        getApi().setActiveTab(survivor);
    }
    return true;
}

// The view closes for good, recorded so Put-away views and ⌘⇧T still bring it back.
async function finishSetAside(mark: SetAsideMark): Promise<void> {
    const ws = workspace();
    if (ws == null || readSetAside(ws)?.id !== mark.id || finishing.has(mark.id)) {
        return;
    }
    finishing.add(mark.id);
    let closed = false;
    try {
        closed = await recordingTabClose(getApi().closeTab)(ws.oid, mark.tabid, false);
    } catch (e) {
        console.log("closing a view set aside", e);
    }
    if (closed) {
        deleteLayoutModelForTab(mark.tabid);
    }
    const now = workspace() ?? ws;
    // A view that did not close comes back rather than staying hidden for good.
    await setWorkspaceMeta(ws.oid, {
        [SetAsideMetaKey]: null,
        ...(closed ? {} : { [HiddenTabsMetaKey]: withHidden(now, mark.tabid, false) }),
    });
}

// Undo: the view comes back as it was, on screen if it was there. Already closed (its mark went stale), it reopens
// through Put-away views.
export async function undoSetAside(mark: SetAsideMark): Promise<void> {
    const ws = workspace();
    if (ws == null) {
        return;
    }
    if (!(ws.tabids ?? []).includes(mark.tabid)) {
        await reopenLastQuietly();
        return;
    }
    await setWorkspaceMeta(ws.oid, {
        [SetAsideMetaKey]: null,
        [HiddenTabsMetaKey]: withHidden(ws, mark.tabid, false),
    });
    if (mark.wasactive) {
        getApi().setActiveTab(mark.tabid);
    }
}

function dropShownToast() {
    const entry = showing;
    if (entry == null) {
        return;
    }
    showing = null;
    entry.settled = true;
    dismissToast(entry.toastId);
}

function showSetAsideToast(mark: SetAsideMark, ownTabId: string) {
    const entry: Showing = { id: mark.id, toastId: null, settled: false };
    showing = entry;
    const onEnd = (reason: ToastDismissReason) => {
        if (entry.settled) {
            return;
        }
        entry.settled = true;
        if (showing === entry) {
            showing = null;
        }
        // "gone": ⌘Z's Undo took the toast away, and runs the undo itself.
        if (reason !== "gone") {
            fireAndForget(() => finishSetAside(mark));
        }
    };
    entry.toastId = showUndoToast(
        t("sidebar.views.closedOne"),
        async () => {
            entry.settled = true;
            if (showing === entry) {
                showing = null;
            }
            dismissToast(entry.toastId);
            await undoSetAside(mark);
        },
        undefined,
        onEnd
    );
    const ws = workspace();
    if (ws != null && readSetAside(ws)?.id === mark.id) {
        fireAndForget(() => setWorkspaceMeta(ws.oid, { [SetAsideMetaKey]: { ...mark, shownby: ownTabId } }));
    }
}

// Each renderer, whenever its workspace changes: the view on screen shows the toast (taking it over from another
// view), closes a view whose toast was lost, or forgets a view shown again by another path.
export function followSetAside(ownTabId: string): void {
    const ws = workspace();
    if (ws == null || !ownTabId) {
        return;
    }
    const step = setAsideStep(ws, { ownTabId, showingId: showing?.id ?? null, now: Date.now() });
    const mark = readSetAside(ws);
    switch (step) {
        case "drop":
            dropShownToast();
            followSetAside(ownTabId);
            return;
        case "forget":
            fireAndForget(() => setWorkspaceMeta(ws.oid, { [SetAsideMetaKey]: null }));
            return;
        case "finish":
            fireAndForget(() => finishSetAside(mark));
            return;
        case "show":
            showSetAsideToast(mark, ownTabId);
            return;
    }
}
