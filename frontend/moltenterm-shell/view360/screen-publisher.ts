// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Publishes what the tab this window draws shows (screen-glyph.ts) in the tab's meta, so the sidebar of every window
// can draw the view's icon from it (FR-SHELL-081, #1823). Read-only on the carpet: it watches the layout and the
// columns in view and writes nothing but the description. A tab not drawn in 360 view clears it.
//
// It publishes where the carpet rests, never the screens it passes through (#1924): the cube makes one motion from the
// screen before an action to the screen after it, and a glide that crosses [2,3,4] between [1,2] and [3,4] would make
// it two. The columns come from restColumnIdsAtom (the end of a glide from its first frame), and nothing is written
// while a swipe or a drag still moves the carpet.

import { atoms, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect } from "react";
import type { CarpetLayout } from "./carpet-model";
import { readScreen, sameScreen, ScreenMetaKey, screenToPublish } from "./screen-glyph";
import type { View360Model } from "./view360-model";

// A layout pass that follows another settles before anything is written.
export const ScreenPublishDelayMs = 100;

const NoLayoutAtom = atom(null) as Atom<CarpetLayout>;
const NoIdsAtom = atom([] as string[]);
const NoCountAtom = atom(0);
const NoMovingAtom = atom(false);

function staticLayoutModel() {
    try {
        return getLayoutModelForStaticTab();
    } catch {
        return null;
    }
}

export function useScreenPublisher(): void {
    const tabId = useAtomValue(atoms.staticTabId);
    const layoutModel = tabId ? staticLayoutModel() : null;
    const view360: View360Model = layoutModel?.moltenView360;
    const layout = useAtomValue(view360?.layoutAtom ?? NoLayoutAtom);
    const restIds = useAtomValue(view360?.restColumnIdsAtom ?? NoIdsAtom);
    const moving = useAtomValue(view360?.freeScrollAtom ?? NoMovingAtom);
    const columnCount = useAtomValue(view360?.columnCountAtom ?? NoCountAtom);
    useEffect(() => {
        if (!tabId || layoutModel == null) {
            return;
        }
        const next = screenToPublish(layoutModel.treeState?.rootNode, layout, restIds, moving, columnCount);
        if (next === undefined) {
            return;
        }
        const timer = setTimeout(() => {
            const oref = WOS.makeORef("tab", tabId);
            const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(oref));
            if (tab == null || sameScreen(next, readScreen(tab.meta?.[ScreenMetaKey]))) {
                return;
            }
            fireAndForget(() =>
                RpcApi.SetMetaCommand(TabRpcClient, { oref, meta: { [ScreenMetaKey]: next } as MetaType })
            );
        }, ScreenPublishDelayMs);
        return () => clearTimeout(timer);
    }, [tabId, layoutModel, layout, restIds, moving, columnCount]);
}
