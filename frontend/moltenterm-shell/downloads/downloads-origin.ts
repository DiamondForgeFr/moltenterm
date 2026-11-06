// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Reading and following a download's way back (#1992, downloads-origin-model.ts for the rules). The place of a panel
// belongs to the renderer of its view: a request left in the view's meta is applied by that renderer once it shows
// (PaneFocusKeeper for a panel to focus, OpenPageKeeper for a page to open), exactly as the sessions' "Go to" does.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService, WorkspaceService } from "@/app/store/services";
import { activeTabIdAtom } from "@/app/store/tab-model";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { paneShowStep } from "../sessions/pane-focus-model";
import { FocusBlockMetaKey } from "../sessions/sessions-model";
import type { DownloadOrigin } from "./downloads-model";
import { OpenPageMetaKey, OriginFacts, reopenTarget } from "./downloads-origin-model";

export type OriginIo = {
    getWorkspace: (id: string) => Promise<Workspace>;
    getTab: (id: string) => Promise<Tab>;
    setTabMeta: (tabId: string, meta: Record<string, unknown>) => Promise<void>;
    setWorkspaceActiveTab: (workspaceId: string, tabId: string) => Promise<void>;
    switchWorkspace: (workspaceId: string) => void;
    setActiveTab: (tabId: string) => void;
    here: () => { workspaceId: string; tabId: string };
    now: () => number;
};

export const realOriginIo: OriginIo = {
    getWorkspace: (id) => WorkspaceService.GetWorkspace(id),
    getTab: async (id) => (await ObjectService.GetObject(makeORef("tab", id))) as Tab,
    setTabMeta: (tabId, meta) =>
        RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("tab", tabId), meta: meta as MetaType }),
    setWorkspaceActiveTab: (workspaceId, tabId) => WorkspaceService.SetActiveTab(workspaceId, tabId),
    switchWorkspace: (workspaceId) => getApi().switchWorkspace(workspaceId),
    setActiveTab: (tabId) => getApi().setActiveTab(tabId),
    here: () => ({
        workspaceId: globalStore.get(atoms.workspace)?.oid,
        tabId: globalStore.get(activeTabIdAtom),
    }),
    now: () => Date.now(),
};

// What exists now of a download's place, or null when wavesrv cannot say (the row then offers nothing and claims
// nothing). A workspace that wavesrv answers null for was deleted; so was a view that is no longer one of its views.
export async function loadOriginFacts(origin: DownloadOrigin, io: OriginIo = realOriginIo): Promise<OriginFacts> {
    if (!origin?.workspaceId || !origin.tabId) {
        return null;
    }
    try {
        const workspace = await io.getWorkspace(origin.workspaceId);
        if (workspace == null) {
            return { workspace: null, view: null };
        }
        const here = { name: workspace.name ?? "", activeTabId: workspace.activetabid ?? "" };
        if (!(workspace.tabids ?? []).includes(origin.tabId)) {
            return { workspace: here, view: null };
        }
        const tab = await io.getTab(origin.tabId);
        return {
            workspace: here,
            view: tab == null ? null : { name: tab.name ?? "", blockIds: tab.blockids ?? [] },
        };
    } catch (e) {
        console.log("downloads: reading where a download came from failed", e?.message ?? e);
        return null;
    }
}

type Place = { workspaceId: string; tabId: string };

// Takes the window to a view: the workspace first, with that view as the one it shows, or the view in this workspace.
// What to do there waits in the view's meta for its own renderer, so the same request works for a view already in
// front, one in this workspace and one in another.
export async function showPlace(
    place: Place,
    requests: Record<string, unknown>,
    io: OriginIo = realOriginIo
): Promise<void> {
    if (Object.keys(requests).length > 0) {
        await io.setTabMeta(place.tabId, requests);
    }
    const here = io.here();
    const step = paneShowStep(
        { workspaceid: place.workspaceId, tabid: place.tabId, blockid: "" },
        here.workspaceId,
        here.tabId
    );
    if (step === "workspace") {
        await io.setWorkspaceActiveTab(place.workspaceId, place.tabId);
        io.switchWorkspace(place.workspaceId);
        return;
    }
    if (step === "tab") {
        io.setActiveTab(place.tabId);
    }
}

// "Go to the page": its workspace, its view, its page in the panel and, on the 360 carpet, the carpet scrolled so the
// panel is in view and has the focus (view360/carpet-show.ts).
export async function goToPage(origin: DownloadOrigin, io: OriginIo = realOriginIo): Promise<void> {
    await showPlace(
        { workspaceId: origin.workspaceId, tabId: origin.tabId },
        {
            [FocusBlockMetaKey]: {
                blockid: origin.blockId,
                ts: io.now(),
                ...(origin.browserTabId ? { browsertabid: origin.browserTabId } : {}),
            },
        },
        io
    );
}

// "Go to the view": the page is closed, its view is not.
export async function goToView(origin: DownloadOrigin, io: OriginIo = realOriginIo): Promise<void> {
    await showPlace({ workspaceId: origin.workspaceId, tabId: origin.tabId }, {}, io);
}

// "Reopen the page": always in the origin workspace, never in the one the developer is in now. Its own view when it
// still exists, otherwise the view the workspace shows. Returns false when the workspace is gone: nothing is opened
// anywhere.
export async function reopenPage(
    origin: DownloadOrigin,
    facts: OriginFacts,
    io: OriginIo = realOriginIo
): Promise<boolean> {
    const target = reopenTarget(origin, facts);
    if (target == null || !origin.pageUrl) {
        return false;
    }
    await showPlace(target, { [OpenPageMetaKey]: { url: origin.pageUrl, ts: io.now() } }, io);
    return true;
}
