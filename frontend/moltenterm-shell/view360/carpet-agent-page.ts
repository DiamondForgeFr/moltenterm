// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A page an agent shows the developer (#1812, FR-BRW-008, FR-SHELL-065 AC13): the panel of a tab it opened through the
// molten-browser server carries an agent tab id, which tells it from a panel the developer opened.

import * as WOS from "@/app/store/wos";
import { BrowserTabsMetaKey, isAgentTabId } from "../browser/browser-model";

export function isAgentPageMeta(meta: Record<string, any>): boolean {
    const tabs = meta?.[BrowserTabsMetaKey];
    return Array.isArray(tabs) && tabs.some((tab) => isAgentTabId(tab?.id));
}

// A block created a moment ago may reach the layout before the store has loaded it.
export async function isAgentPagePanel(blockId: string): Promise<boolean> {
    if (!blockId) {
        return false;
    }
    const oref = WOS.makeORef("block", blockId);
    const block = WOS.getObjectValue<Block>(oref) ?? (await WOS.reloadWaveObject<Block>(oref));
    return isAgentPageMeta(block?.meta);
}
