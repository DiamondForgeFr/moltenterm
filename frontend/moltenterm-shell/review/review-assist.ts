// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Assisted review with the agent on the left (FR-REV-033, #1352). Once the developer accepted the confirmation, the
// Reviews view opens the PR's Review tab and leaves the ask in the tab's meta: each tab of a window is a page of its
// own, and a Review tab just created has no page yet. The Review tab's page takes the ask once and opens the AI panel
// left of the diff with the agent's terminal under it (DS-REV-012).

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";

export const ReviewAssistMetaKey = "molten:review:assist";

// An ask older than this is not honoured: the tab was opened much later, by other means.
export const ReviewAssistMaxAgeMs = 2 * 60 * 1000;

export type ReviewAssistRequest = { at: number };

export function readAssistRequest(value: any, now: number): ReviewAssistRequest {
    if (value == null || typeof value.at !== "number") {
        return null;
    }
    if (Math.abs(now - value.at) > ReviewAssistMaxAgeMs) {
        return null;
    }
    return value as ReviewAssistRequest;
}

export async function requestAssist(tabId: string): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [ReviewAssistMetaKey]: { at: Date.now() } } as MetaType,
    });
}

async function clearAssist(tabId: string): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [ReviewAssistMetaKey]: null } as MetaType,
    });
}

// watchAssistRequests starts the agent asked in the tab's meta, once per ask; the returned function stops watching.
export function watchAssistRequests(tabId: string, assist: () => Promise<void>): () => void {
    if (!tabId) {
        return () => {};
    }
    const tabAtom = WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId));
    const done = new Set<number>();
    const check = () => {
        const meta = globalStore.get(tabAtom)?.meta as Record<string, any>;
        const request = readAssistRequest(meta?.[ReviewAssistMetaKey], Date.now());
        if (request == null || done.has(request.at)) {
            return;
        }
        done.add(request.at);
        fireAndForget(async () => {
            await clearAssist(tabId);
            await assist();
        });
    };
    const unsub = globalStore.sub(tabAtom, check);
    check();
    return unsub;
}
