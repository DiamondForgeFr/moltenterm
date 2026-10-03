// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Opening one of MoltenTerm's views from the shell (the notification center, the status bar): the one already in the
// active tab gets the focus, else a new block opens.

import { createBlock } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getActiveTabModel } from "@/app/store/tab-model";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";

export async function openMoltentermView(view: string): Promise<void> {
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
            return;
        }
    }
    await createBlock({ meta: { view } });
}
