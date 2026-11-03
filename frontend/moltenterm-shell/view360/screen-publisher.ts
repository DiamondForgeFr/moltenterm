// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Publishes what the tab this window draws shows (screen-glyph.ts) in the tab's meta, so the sidebar of every window
// can draw the view's icon from it (FR-SHELL-081, #1823). Read-only on the carpet: it watches the layout and the
// columns in view and writes nothing but the description. A tab not drawn in 360 view clears it.

import { atoms, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect } from "react";
import type { CarpetLayout } from "./carpet-model";
import { describeScreen, readScreen, sameScreen, ScreenMetaKey } from "./screen-glyph";
import type { View360Model } from "./view360-model";

// A carpet that is still moving, or a layout pass that follows another, settles before anything is written.
export const ScreenPublishDelayMs = 250;

const NoLayoutAtom = atom(null) as Atom<CarpetLayout>;
const NoIdsAtom = atom([] as string[]);
const NoCountAtom = atom(0);

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
    const visibleIds = useAtomValue(view360?.visibleColumnIdsAtom ?? NoIdsAtom);
    // Zero until the first layout pass has measured the tab: a tab not drawn yet is not a tab without a carpet.
    const columnCount = useAtomValue(view360?.columnCountAtom ?? NoCountAtom);
    useEffect(() => {
        if (!tabId || layoutModel == null || !(columnCount > 0)) {
            return;
        }
        const next = describeScreen(layoutModel.treeState?.rootNode, layout, visibleIds);
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
    }, [tabId, layoutModel, layout, visibleIds, columnCount]);
}
