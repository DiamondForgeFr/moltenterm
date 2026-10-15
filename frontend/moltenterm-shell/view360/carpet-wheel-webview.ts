// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A browser panel's page runs in its own process: its wheel never reaches the carpet's listener (#676). The host tells
// the guest page whether its panel lies on a scrollable carpet and has the focus; the page's preload
// (emain/preload-webview.ts) routes each horizontal scroll with carpet-wheel.ts and sends the carpet's share back here.

import { globalStore } from "@/app/store/jotaiStore";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import type { WebviewTag } from "electron";
import {
    CarpetWheelChannel,
    CarpetWheelMessage,
    CarpetWheelState,
    CarpetWheelStateChannel,
    wheelDeltaPx,
} from "./carpet-wheel";

export function carpetWheelState(layoutModel: LayoutModel, blockId: string): CarpetWheelState {
    const view360 = layoutModel?.moltenView360;
    const layout = view360?.layout;
    const focused = globalStore.get(layoutModel.focusedNode)?.data?.blockId === blockId;
    if (layout == null || layout.maxScroll <= 0) {
        return { onCarpet: false, focused };
    }
    const node = layoutModel.getNodeByBlockId(blockId);
    return { onCarpet: node != null && view360.carpetColumnOf(node.id) != null, focused };
}

export function attachCarpetWheel(webview: WebviewTag, blockId: string): () => void {
    const layoutModel = getLayoutModelForStaticTab();
    const view360 = layoutModel?.moltenView360;
    if (view360 == null) {
        return () => {};
    }
    let sent: string = null;
    const push = () => {
        const state = carpetWheelState(layoutModel, blockId);
        const key = JSON.stringify(state);
        if (key === sent) {
            return;
        }
        try {
            webview.send(CarpetWheelStateChannel, state);
            sent = key;
        } catch {
            // not attached yet: dom-ready pushes it
        }
    };
    // A new document starts with a fresh preload that knows nothing yet.
    const onDomReady = () => {
        sent = null;
        push();
    };
    const onMessage = (e: Electron.IpcMessageEvent) => {
        if (e.channel !== CarpetWheelChannel) {
            return;
        }
        const msg = e.args?.[0] as CarpetWheelMessage;
        const layout = view360.layout;
        if (layout == null || typeof msg?.delta !== "number" || !Number.isFinite(msg.delta)) {
            return;
        }
        view360.scrollBy(wheelDeltaPx(msg.delta, msg.deltaMode, layout.viewport.width));
    };
    const unsubLayout = globalStore.sub(view360.layoutAtom, push);
    const unsubFocus = globalStore.sub(layoutModel.focusedNode, push);
    webview.addEventListener("dom-ready", onDomReady);
    webview.addEventListener("ipc-message", onMessage);
    push();
    return () => {
        unsubLayout();
        unsubFocus();
        webview.removeEventListener("dom-ready", onDomReady);
        webview.removeEventListener("ipc-message", onMessage);
    };
}
