// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where a tab keeps its 360 view (FR-SHELL-065): in its meta, so the choice and the fixed zone's width survive a
// restart and the tab bar can switch any tab, not only the one shown.

import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";

export const View360MetaKey = "molten:view360";
export const View360FixedPxMetaKey = "molten:view360fixedpx";

export function isView360On(tab: Tab): boolean {
    return (tab?.meta as Record<string, unknown>)?.[View360MetaKey] === true;
}

export function storedFixedPx(tab: Tab): number {
    const raw = (tab?.meta as Record<string, unknown>)?.[View360FixedPxMetaKey];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function setTabView360(tabId: string, on: boolean): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [View360MetaKey]: on ? true : null } as MetaType,
    });
}

export function setTabFixedPx(tabId: string, px: number): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [View360FixedPxMetaKey]: Math.round(px) } as MetaType,
    });
}
