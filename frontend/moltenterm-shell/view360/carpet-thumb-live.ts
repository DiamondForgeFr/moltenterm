// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The app-bound half of the carpet's thumbnail rules (#1814, carpet-thumb-state.ts): reads a panel's page address and
// load state from the stores the browser panel already keeps (its view model, or its saved block meta while the model
// is not registered yet), and watches them.

import { globalStore } from "@/app/store/jotaiStore";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import type { Atom } from "jotai";
import type { BrowserErrorModel } from "../browser/browser-error";
import type { BrowserLifecycleModel } from "../browser/browser-lifecycle";
import type { BrowserLoadModel } from "../browser/browser-loading";
import { MoltentermBrowserView, readBrowserState, type BrowserState } from "../browser/browser-model";
import { activePageTab, carpetPageModel } from "./carpet-page-store";
import { ColumnPanel, plainPanel } from "./carpet-thumb-state";

// The parts of the browser panel's view model the thumbnails read.
type ThumbPageModel = {
    stateAtom: Atom<BrowserState>;
    loads: BrowserLoadModel;
    errors: BrowserErrorModel;
    lifecycle: BrowserLifecycleModel;
    webviews: Map<string, unknown>;
};

function pageModelOf(blockId: string): ThumbPageModel {
    return carpetPageModel(blockId) as unknown as ThumbPageModel;
}

export function readLivePanel(blockId: string): ColumnPanel {
    const block = globalStore.get(getWaveObjectAtom<Block>(makeORef("block", blockId)));
    const meta = block?.meta as Record<string, any>;
    if (meta?.view !== MoltentermBrowserView) {
        return plainPanel(blockId);
    }
    const model = pageModelOf(blockId);
    const tab = activePageTab(
        model != null ? globalStore.get(model.stateAtom) : readBrowserState(meta, "", () => "saved")
    );
    if (model == null || tab == null) {
        return { ...plainPanel(blockId), page: true, url: tab?.url ?? "", ready: false };
    }
    const load = globalStore.get(model.loads.loadsAtom)[tab.id];
    return {
        blockId,
        page: true,
        url: tab.url ?? "",
        ready: model.webviews.has(tab.id),
        handedOff: !!tab.engine,
        loading: !!load?.loading,
        failed: globalStore.get(model.errors.errorsAtom)[tab.id]?.error != null,
        crashed: !!load?.crashed,
        unloaded:
            globalStore.get(model.lifecycle.discardedAtom)[tab.id] != null ||
            globalStore.get(model.lifecycle.restoringAtom)[tab.id] != null,
    };
}

export function watchLivePanel(blockId: string, onChange: () => void): () => void {
    const model = pageModelOf(blockId);
    if (model == null) {
        return null;
    }
    const stops = [
        model.stateAtom,
        model.loads.loadsAtom,
        model.errors.errorsAtom,
        model.lifecycle.discardedAtom,
        model.lifecycle.restoringAtom,
    ].map((a) => globalStore.sub(a as Atom<unknown>, onChange));
    return () => stops.forEach((stop) => stop());
}
