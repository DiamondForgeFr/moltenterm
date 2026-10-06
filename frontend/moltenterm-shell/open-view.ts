// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Opening one of MoltenTerm's views from the shell (the notification center, the status bar): the one already in the
// active tab gets the focus, else a new block opens. A view that was retired opens the one that replaced it.

import { createBlock } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getActiveTabModel } from "@/app/store/tab-model";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { currentMissionView } from "./project/project-model";

// Focuses the view when the active tab holds it; false when it does not.
export async function focusMoltentermView(requested: string): Promise<boolean> {
    const view = currentMissionView(requested);
    const layoutModel = getLayoutModelForStaticTab();
    const tabAtom = getActiveTabModel()?.tabAtom;
    const tab = tabAtom == null ? null : globalStore.get(tabAtom);
    for (const blockId of tab?.blockids ?? []) {
        const block = await RpcApi.GetMetaCommand(TabRpcClient, { oref: makeORef("block", blockId) });
        if (block?.view !== view) {
            continue;
        }
        const node = layoutModel?.getNodeByBlockId(blockId);
        if (node != null) {
            layoutModel.focusNode(node.id);
            return true;
        }
    }
    return false;
}

export async function openMoltentermView(requested: string): Promise<void> {
    if (await focusMoltentermView(requested)) {
        return;
    }
    await createBlock({ meta: { view: currentMissionView(requested) } });
}
