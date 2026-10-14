// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where a tab keeps its 360 view (FR-SHELL-065, FR-SHELL-066): in its meta, so its manual choice and the fixed zone's
// width survive a restart and any tab can be switched, not only the one shown.

import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { parsePins, type TabPins } from "./pin-model";
import { manualChoice } from "./view360-decision";

export const View360MetaKey = "molten:view360";
export const View360FixedPxMetaKey = "molten:view360fixedpx";

// The tab's manual choice (FR-SHELL-066): true on, false off, null when the tab follows the setting.
export function tabManualView360(tab: Tab): boolean {
    return manualChoice((tab?.meta as Record<string, unknown>)?.[View360MetaKey]);
}

export function storedFixedPx(tab: Tab): number {
    const raw = (tab?.meta as Record<string, unknown>)?.[View360FixedPxMetaKey];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

// null drops the manual choice: the tab follows the setting again.
export function setTabView360(tabId: string, choice: boolean): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [View360MetaKey]: choice == null ? null : choice } as MetaType,
    });
}

// The panels pinned to the fixed zone (FR-SHELL-067, DS-SHELL-118), by block id.
export const View360PinsMetaKey = "molten:view360pins";

export function storedPins(tab: Tab): TabPins {
    return parsePins((tab?.meta as Record<string, unknown>)?.[View360PinsMetaKey]);
}

export function setTabPins(tabId: string, pins: TabPins): Promise<void> {
    const empty = pins == null || Object.keys(pins).length === 0;
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [View360PinsMetaKey]: empty ? null : pins } as MetaType,
    });
}

export function setTabFixedPx(tabId: string, px: number): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [View360FixedPxMetaKey]: Math.round(px) } as MetaType,
    });
}
