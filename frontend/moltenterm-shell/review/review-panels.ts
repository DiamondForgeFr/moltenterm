// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The panels still open in a worktree the cleanup kept (#672): Show the panel takes the window to it, wherever it is;
// Close the panels and remove closes them before the removal runs again.

import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { showPane } from "../sessions/pane-focus";
import { FocusBlockMetaKey } from "../sessions/sessions-model";

// showPanel asks the panel's tab to focus it (pane-focus.ts), then shows that tab.
export async function showPanel(blockId: string): Promise<void> {
    const info = await RpcApi.BlockInfoCommand(TabRpcClient, blockId);
    if (info?.tabid) {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("tab", info.tabid),
            meta: { [FocusBlockMetaKey]: { blockid: blockId, ts: Date.now() } } as MetaType,
        });
    }
    showPane({ workspaceid: info?.workspaceid, tabid: info?.tabid, blockid: blockId });
}

export async function closePanels(blockIds: string[]): Promise<void> {
    for (const blockid of blockIds) {
        await RpcApi.DeleteBlockCommand(TabRpcClient, { blockid });
    }
}
