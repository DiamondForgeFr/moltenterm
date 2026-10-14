// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A sheet asked for a Review tab by `molten review publish|merge|restart` (FR-REV-014). Each tab of a window is a page
// of its own, and a Review tab just created has no page yet when the terminal's request arrives: the page that opens
// the tab leaves the request in the tab's meta, and the Review tab's page opens the sheet once its review store is read.
// The sheet only shows the plan; posting, merging or restarting the work stays the developer's click in it.

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { Atom } from "jotai";

export const ReviewSheetMetaKey = "molten:review:sheet";

export type ReviewSheetAction = "publish" | "merge" | "restart";

const SheetActions: ReviewSheetAction[] = ["publish", "merge", "restart"];

export type ReviewSheetRequest = { id: string; action: ReviewSheetAction; at: number };

// A request older than this is not honoured: the tab was opened much later, by other means.
export const ReviewSheetMaxAgeMs = 2 * 60 * 1000;

export type ReviewSheetTarget = {
    stateAtom: Atom<unknown>;
    openPublish(): Promise<void>;
    openValidate(): Promise<void>;
    // Restart work's sheet (FR-REV-011): the round goes to an agent only on its click.
    openRestart(): Promise<void>;
};

export function readSheetRequest(value: any, now: number): ReviewSheetRequest {
    if (value == null || typeof value.id !== "string" || !SheetActions.includes(value.action)) {
        return null;
    }
    if (typeof value.at !== "number" || now - value.at > ReviewSheetMaxAgeMs || value.at - now > ReviewSheetMaxAgeMs) {
        return null;
    }
    return value as ReviewSheetRequest;
}

export async function requestReviewSheet(tabId: string, request: ReviewSheetRequest): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [ReviewSheetMetaKey]: request } as MetaType,
    });
}

async function clearReviewSheet(tabId: string): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [ReviewSheetMetaKey]: null } as MetaType,
    });
}

// watchReviewSheetRequests opens the sheet requested in the tab's meta, once the model read its review store; the
// returned function stops watching.
export function watchReviewSheetRequests(tabId: string, model: ReviewSheetTarget): () => void {
    if (!tabId) {
        return () => {};
    }
    const tabAtom = WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId));
    const done = new Set<string>();
    const check = () => {
        const meta = globalStore.get(tabAtom)?.meta as Record<string, any>;
        const request = readSheetRequest(meta?.[ReviewSheetMetaKey], Date.now());
        if (request == null || done.has(request.id) || globalStore.get(model.stateAtom) == null) {
            return;
        }
        done.add(request.id);
        fireAndForget(async () => {
            await clearReviewSheet(tabId);
            if (request.action === "publish") {
                await model.openPublish();
            } else if (request.action === "restart") {
                await model.openRestart();
            } else {
                await model.openValidate();
            }
        });
    };
    const unsubTab = globalStore.sub(tabAtom, check);
    const unsubState = globalStore.sub(model.stateAtom, check);
    check();
    return () => {
        unsubTab();
        unsubState();
    };
}
