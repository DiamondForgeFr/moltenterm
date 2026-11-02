// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { BrowserAgentControlCommand, BrowserAgentRouteId, BrowserAgentShareCommand, type ShareResult } from "../browser/browser-agent";
import type { SentRow } from "./library-model";

const SentCallTimeoutMs = 3000;

// Remove access is the panel's Stop sharing (the browser agent's stop control): the page stays open, as the
// developer's. It answers the pages it took back.
export async function removeAccess(rows: SentRow[]): Promise<SentRow[]> {
    const removed: SentRow[] = [];
    for (const row of rows) {
        try {
            if (!row.sessionId) continue;
            await TabRpcClient.wshRpcCall(
                BrowserAgentControlCommand,
                { blockid: row.panelBlockId, browsertabid: row.browserTabId, action: "stop", expectedsessionid: row.sessionId },
                { route: BrowserAgentRouteId, timeout: SentCallTimeoutMs }
            );
            removed.push(row);
        } catch (e) {
            console.log("library: remove access", e);
        }
    }
    return removed;
}

// Undo shares the pages again with the original session, while that session lasts. It answers how many it could not
// give back.
export async function giveAccessBack(rows: SentRow[]): Promise<number> {
    let failed = 0;
    for (const row of rows) {
        try {
            if (!row.sessionId) {
                failed++;
                continue;
            }
            const shared: ShareResult = await TabRpcClient.wshRpcCall(
                BrowserAgentShareCommand,
                { blockid: row.panelBlockId, browsertabid: row.browserTabId, sessionid: row.sessionId, move: false },
                { route: BrowserAgentRouteId, timeout: SentCallTimeoutMs }
            );
            if (shared?.result !== "shared") failed++;
        } catch (e) {
            console.log("library: give access back", e);
            failed++;
        }
    }
    return failed;
}
