// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { BrowserAgentRouteId, BrowserAgentStateCommand, type AgentTab, type PanelAgentState } from "../browser/browser-agent";
import { MoltentermBrowserView, readBrowserState } from "../browser/browser-model";
import type { WorkspaceRailEntry } from "../workspace-rail-model";
import type { SentPanel } from "./library-model";

const SentCallTimeoutMs = 3000;

export async function readSentPanels(entries: WorkspaceRailEntry[], current: () => boolean): Promise<SentPanel[]> {
    const rtn: SentPanel[] = [];
    for (const entry of entries) {
        if (!current()) break;
        const ws = await WOS.reloadWaveObject<Workspace>(WOS.makeORef("workspace", entry.id));
        for (const tabId of ws?.tabids ?? []) {
            if (!current()) break;
            const tab = await WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", tabId));
            for (const blockId of tab?.blockids ?? []) {
                if (!current()) break;
                const block = await WOS.reloadWaveObject<Block>(WOS.makeORef("block", blockId));
                if (!current()) break;
                if (block?.meta?.view !== MoltentermBrowserView) continue;
                let state: PanelAgentState = null;
                try {
                    state = await TabRpcClient.wshRpcCall(
                        BrowserAgentStateCommand,
                        { blockid: blockId },
                        { route: BrowserAgentRouteId, timeout: SentCallTimeoutMs }
                    );
                } catch {
                    continue;
                }
                if (!current()) break;
                const agentTabs: AgentTab[] = state?.tabs ?? [];
                if (agentTabs.length === 0) continue;
                rtn.push({
                    panelBlockId: blockId,
                    tabId,
                    workspaceId: entry.id,
                    agentTabs,
                    browserTabs: readBrowserState(block.meta as Record<string, any>, "").tabs,
                });
            }
        }
    }
    return rtn;
}
