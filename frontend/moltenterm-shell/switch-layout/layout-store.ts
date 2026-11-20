// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where a workspace's remembered layout is kept (#2407): on the workspace itself, in its meta, so that it outlives a
// restart (the pages' session is kept in memory only, #1763: its localStorage is gone after one), with a copy in localStorage that every
// view of this run reads at once, before the workspace object has reached it.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as WOS from "@/app/store/wos";
import { parseLayout, readLayout, RememberedLayout, writeLayout } from "./layout-memory";

export const LayoutMetaKey = "molten:switchlayout";

function fromMeta(workspaceId: string): RememberedLayout {
    try {
        const ws = WOS.getObjectValue<Workspace>(WOS.makeORef("workspace", workspaceId));
        const raw = (ws?.meta as Record<string, any>)?.[LayoutMetaKey];
        if (raw == null) {
            return null;
        }
        const layout = parseLayout(typeof raw === "string" ? raw : JSON.stringify(raw));
        return layout?.workspaceId === workspaceId ? layout : null;
    } catch {
        return null;
    }
}

// The newest of the two copies.
export function loadLayout(workspaceId: string): RememberedLayout {
    if (!workspaceId) {
        return null;
    }
    const local = readLayout(workspaceId);
    const saved = fromMeta(workspaceId);
    if (local == null) {
        return saved;
    }
    return saved != null && saved.at > local.at ? saved : local;
}

export function saveLayout(layout: RememberedLayout) {
    if (layout == null) {
        return;
    }
    writeLayout(layout);
    const write = async () => {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("workspace", layout.workspaceId),
            meta: { [LayoutMetaKey]: layout } as MetaType,
        });
    };
    write().catch((e) => console.log("switch layout: could not save on the workspace", e));
}
