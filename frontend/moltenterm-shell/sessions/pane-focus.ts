// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Showing a pane anywhere (FR-SHELL-020): in this tab, focus it; in another tab of this workspace, switch tab; in
// another workspace, switch workspace. A tab's layout belongs to that tab's renderer, so a pane in another tab is
// focused by the renderer that shows it: wavesrv leaves a request in the tab's meta (molten:focusblock) and the
// PaneFocusKeeper of that tab applies it, then clears it.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { activeTabIdAtom } from "@/app/store/tab-model";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget, NullAtom } from "@/util/util";
import { Atom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { FocusRequest, freshFocusRequest, paneShowStep } from "./pane-focus-model";
import { FocusBlockMetaKey, SessionLocation } from "./sessions-model";

// The pane of a tab just shown may not be laid out yet.
const FocusRetryMs = 150;
const FocusMaxTries = 20;

function focusBlockHere(blockId: string): boolean {
    const layoutModel = getLayoutModelForStaticTab();
    const node = blockId ? layoutModel?.getNodeByBlockId(blockId) : null;
    if (node == null) {
        return false;
    }
    layoutModel.focusNode(node.id);
    return true;
}

// Takes the window to a pane wavesrv located (and, for another tab, asked to focus).
export function showPane(loc: SessionLocation): void {
    const workspace = globalStore.get(atoms.workspace);
    switch (paneShowStep(loc, workspace?.oid, globalStore.get(activeTabIdAtom))) {
        case "workspace":
            getApi().switchWorkspace(loc.workspaceid);
            return;
        case "tab":
            getApi().setActiveTab(loc.tabid);
            return;
        case "focus":
            focusBlockHere(loc.blockid);
            return;
    }
}

function clearFocusRequest(tabId: string) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("tab", tabId),
            meta: { [FocusBlockMetaKey]: null } as MetaType,
        })
    );
}

function applyFocusRequest(tabId: string, blockId: string) {
    let tries = 0;
    const attempt = () => {
        if (focusBlockHere(blockId) || ++tries >= FocusMaxTries) {
            clearFocusRequest(tabId);
            return;
        }
        setTimeout(attempt, FocusRetryMs);
    };
    attempt();
}

// Mounted with the rail of every tab: each renderer applies the requests for its own tab.
export function PaneFocusKeeper() {
    const staticTabId = useAtomValue(atoms.staticTabId);
    const tab = useAtomValue(
        staticTabId == null ? (NullAtom as Atom<Tab>) : getWaveObjectAtom<Tab>(makeORef("tab", staticTabId))
    );
    const request = tab?.meta?.[FocusBlockMetaKey] as FocusRequest;
    const requestKey = request ? `${request.blockid}:${request.ts}` : "";
    useEffect(() => {
        if (!requestKey || !staticTabId) {
            return;
        }
        const blockId = freshFocusRequest(tab?.meta, Date.now());
        if (blockId == null) {
            clearFocusRequest(staticTabId);
            return;
        }
        applyFocusRequest(staticTabId, blockId);
    }, [requestKey, staticTabId]);
    return null;
}
