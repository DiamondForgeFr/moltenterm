// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A material's card shows the capture of the panel that showed it (#1560, FR-MAT-002, DS-MAT-010). There is no capture
// of its own: the 360 carpet already captures each panel at rest (view360/carpet-captures.ts) and offers each capture
// here, so the rules of that mechanism hold (one batch when the carpet stops, never while something covers a panel).
// The registry keeps the capture only for the materials the panel shows.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { MoltentermBrowserView, readBrowserState } from "../browser/browser-model";
import { MaterialPanelCaptureCommand, MaterialsRoute } from "./materials-model";

const PreviewView = "preview";
const CallTimeoutMs = 5000;
// A panel's capture is offered again only after this long: the registry keeps one this recent as it is.
export const OfferGapMs = 30_000;

export type ShownByPanel = { urls?: string[]; file?: string };

// What a panel shows that a material can be: the page open in a browser panel's active tab, or the file a preview shows.
export function shownByPanel(meta: Record<string, any>): ShownByPanel {
    if (meta == null) {
        return null;
    }
    if (meta.view === MoltentermBrowserView) {
        const state = readBrowserState(meta, meta.url ?? "");
        const tab = state.tabs.find((t) => t.id === state.activeId);
        return tab?.url ? { urls: [tab.url] } : null;
    }
    if (meta.view === PreviewView && meta.file) {
        return { file: meta.file };
    }
    return null;
}

export type OfferSender = (blockId: string, shown: ShownByPanel, image: string) => void;

// Offers a panel's capture, at most once per OfferGapMs for the same panel showing the same thing.
export function makeCaptureOffers(send: OfferSender, now: () => number = Date.now) {
    const last = new Map<string, { key: string; at: number }>();
    return (blockId: string, shown: ShownByPanel, image: string) => {
        if (shown == null || !image) {
            return;
        }
        const key = JSON.stringify(shown);
        const prev = last.get(blockId);
        if (prev != null && prev.key === key && now() - prev.at < OfferGapMs) {
            return;
        }
        last.set(blockId, { key, at: now() });
        send(blockId, shown, image);
    };
}

function sendToRegistry(_blockId: string, shown: ShownByPanel, image: string) {
    const workspaceId = globalStore.get(atoms.workspaceId);
    if (!workspaceId) {
        return;
    }
    fireAndForget(async () => {
        try {
            await TabRpcClient.wshRpcCall(
                MaterialPanelCaptureCommand,
                { workspaceid: workspaceId, urls: shown.urls, file: shown.file, image },
                { route: MaterialsRoute, timeout: CallTimeoutMs }
            );
        } catch (e) {
            console.log("library: material capture", e);
        }
    });
}

const offer = makeCaptureOffers(sendToRegistry);

// Called with each capture of a carpet column. Only a panel alone in its column is offered: a column with several
// panels is one picture of all of them.
export function offerPanelCapture(blockIds: string[], image: string) {
    if (blockIds.length !== 1) {
        return;
    }
    const blockId = blockIds[0];
    const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    offer(blockId, shownByPanel(block?.meta as Record<string, any>), image);
}
