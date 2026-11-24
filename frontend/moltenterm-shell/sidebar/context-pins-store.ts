// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A new context starts with a copy of the top row of the context it was made from (FR-SHELL-080, #2526). Manage
// contexts runs in the window of that context, so this window is the one that knows it.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { startingPinsPatch } from "./context-pins-model";

// A failure leaves the context with no row of its own, which reads as an empty top row: the context exists either way.
export async function startContextPins(contextId: string, fromContextId: string): Promise<void> {
    try {
        const clientAtom = ClientModel.getInstance().clientAtom;
        const patch = startingPinsPatch(
            clientAtom == null ? null : globalStore.get(clientAtom)?.meta,
            contextId,
            fromContextId
        );
        if (patch == null) {
            return;
        }
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("client", ClientModel.getInstance().clientId),
            meta: patch as MetaType,
        });
    } catch (e) {
        console.log("contexts: giving the new context its top row", e);
    }
}
