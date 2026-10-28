// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import type * as electron from "electron";
import {
    readSidebarHidden,
    SidebarHiddenMetaKey,
    sidebarEnabled,
    SidebarSettingKey,
} from "../frontend/moltenterm-shell/sidebar/sidebar-model";
import { fireAndForget } from "../frontend/util/util";
import { ElectronWshClient } from "./emain-wsh";
import { mt } from "./moltenterm-i18n";

export const MoltentermToggleSidebarMenuId = "molten-toggle-sidebar";

// The sidebar's state lives in the window's meta, shared by its tab views, so main flips it without a page in between.
export async function toggleWindowSidebar(windowId: string): Promise<void> {
    if (!windowId) {
        return;
    }
    const oref = `window:${windowId}`;
    const meta = await RpcApi.GetMetaCommand(ElectronWshClient, { oref });
    await RpcApi.SetMetaCommand(ElectronWshClient, {
        oref,
        meta: { [SidebarHiddenMetaKey]: !readSidebarHidden(meta) } as MetaType,
    });
}

// View › Show or hide the sidebar (#1279): with the sidebar closed nothing stays at the window's top left, so the menu
// is one of the ways back, beside the shortcut and the left edge. No accelerator: the page owns the shortcut.
export function makeMoltentermSidebarMenuItem(
    settings: Record<string, unknown>,
    windowIdOf: (window: electron.BaseWindow) => string
): electron.MenuItemConstructorOptions | null {
    if (!sidebarEnabled(settings?.[SidebarSettingKey] as boolean)) {
        return null;
    }
    return {
        id: MoltentermToggleSidebarMenuId,
        label: mt("appMenu.toggleSidebar"),
        click: (_, window) => fireAndForget(() => toggleWindowSidebar(windowIdOf(window as electron.BaseWindow))),
    };
}
