// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getOrefMetaKeyAtom, globalStore, recordTEvent } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { DeveloperSection } from "../../moltenterm-shell/menu/menu-model"; // MOLTENTERM-PATCH (#408)
import { acceleratorById } from "../../moltenterm-shell/shortcuts/format"; // MOLTENTERM-PATCH (#371)
import { makeORef } from "../store/wos";
import type { TabEnv } from "./tab";

const FlagColors: { label: string; value: string }[] = [
    { label: "Green", value: "#58C142" },
    { label: "Teal", value: "#00FFDB" },
    { label: "Blue", value: "#429DFF" },
    { label: "Purple", value: "#BF55EC" },
    { label: "Red", value: "#FF453A" },
    { label: "Orange", value: "#FF9500" },
    { label: "Yellow", value: "#FFE900" },
];

// MOLTENTERM-PATCH (#408): sections, icons and sentence case (FR-SHELL-054); Copy tab id moved to Developer.
export function buildTabBarContextMenu(env: TabEnv, section?: string): ContextMenuItem[] {
    const currentTabBar = globalStore.get(env.getSettingsKeyAtom("app:tabbar")) ?? "top";
    const tabBarSubmenu: ContextMenuItem[] = [
        {
            label: "Top",
            type: "checkbox",
            checked: currentTabBar === "top",
            click: () => fireAndForget(() => env.rpc.SetConfigCommand(TabRpcClient, { "app:tabbar": "top" })),
        },
        {
            label: "Left",
            type: "checkbox",
            checked: currentTabBar === "left",
            click: () => fireAndForget(() => env.rpc.SetConfigCommand(TabRpcClient, { "app:tabbar": "left" })),
        },
    ];
    return [{ label: "Tab bar position", type: "submenu", submenu: tabBarSubmenu, icon: "border-top-left", section }];
}

export function buildTabContextMenu(
    id: string,
    renameRef: React.RefObject<(() => void) | null>,
    onClose: (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null) => void,
    env: TabEnv
): ContextMenuItem[] {
    const menu: ContextMenuItem[] = [];
    menu.push({
        label: "Rename tab",
        icon: "pen",
        accelerator: acceleratorById("rename-tab"),
        click: () => renameRef.current?.(),
    });
    const developer: ContextMenuItem = {
        label: "Copy tab id",
        icon: "hashtag",
        section: DeveloperSection,
        click: () => fireAndForget(() => navigator.clipboard.writeText(id)),
    };
    const tabORef = makeORef("tab", id);
    const currentFlagColor = globalStore.get(getOrefMetaKeyAtom(tabORef, "tab:flagcolor")) ?? null;
    const flagSubmenu: ContextMenuItem[] = [
        {
            label: "None",
            type: "checkbox",
            checked: currentFlagColor == null,
            click: () =>
                fireAndForget(() =>
                    env.rpc.SetMetaCommand(TabRpcClient, { oref: tabORef, meta: { "tab:flagcolor": null } })
                ),
        },
        ...FlagColors.map((fc) => ({
            label: fc.label,
            type: "checkbox" as const,
            checked: currentFlagColor === fc.value,
            click: () =>
                fireAndForget(() =>
                    env.rpc.SetMetaCommand(TabRpcClient, { oref: tabORef, meta: { "tab:flagcolor": fc.value } })
                ),
        })),
    ];
    menu.push({ label: "Flag tab", type: "submenu", submenu: flagSubmenu, icon: "flag" });
    const fullConfig = globalStore.get(env.atoms.fullConfigAtom);
    const backgrounds = fullConfig?.backgrounds ?? {};
    const bgKeys = Object.keys(backgrounds).filter((k) => backgrounds[k] != null);
    bgKeys.sort((a, b) => {
        const aOrder = backgrounds[a]["display:order"] ?? 0;
        const bOrder = backgrounds[b]["display:order"] ?? 0;
        return aOrder - bOrder;
    });
    if (bgKeys.length > 0) {
        const submenu: ContextMenuItem[] = [];
        const oref = makeORef("tab", id);
        submenu.push({
            label: "Default",
            click: () =>
                fireAndForget(async () => {
                    await env.rpc.SetMetaCommand(TabRpcClient, {
                        oref,
                        meta: { "bg:*": true, "tab:background": null },
                    });
                    env.rpc.ActivityCommand(TabRpcClient, { settabtheme: 1 }, { noresponse: true });
                    recordTEvent("action:settabtheme");
                }),
        });
        for (const bgKey of bgKeys) {
            const bg = backgrounds[bgKey];
            submenu.push({
                label: bg["display:name"] ?? bgKey,
                click: () =>
                    fireAndForget(async () => {
                        await env.rpc.SetMetaCommand(TabRpcClient, {
                            oref,
                            meta: { "bg:*": true, "tab:background": bgKey },
                        });
                        env.rpc.ActivityCommand(TabRpcClient, { settabtheme: 1 }, { noresponse: true });
                        recordTEvent("action:settabtheme");
                    }),
            });
        }
        menu.push({ label: "Backgrounds", type: "submenu", submenu, icon: "image" });
    }
    menu.push(...buildTabBarContextMenu(env, "Tab bar"), developer, { type: "separator" });
    menu.push({
        label: "Close tab",
        icon: "xmark",
        destructive: true,
        accelerator: acceleratorById("close-tab"),
        click: () => onClose(null),
    });
    return menu;
}
