// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getOrefMetaKeyAtom, globalStore, recordTEvent } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { t } from "../../moltenterm-shell/i18n/i18n"; // MOLTENTERM-PATCH (#623)
import { DeveloperSection } from "../../moltenterm-shell/menu/menu-model"; // MOLTENTERM-PATCH (#408)
import { reopenLastClosed } from "../../moltenterm-shell/reopen/reopen-store"; // MOLTENTERM-PATCH (#512)
import { acceleratorById } from "../../moltenterm-shell/shortcuts/format"; // MOLTENTERM-PATCH (#371)
import { makeORef } from "../store/wos";
import type { TabEnv } from "./tab";

// MOLTENTERM-PATCH (#623): colour names are keys, translated when the menu is built
const FlagColors: { labelKey: string; value: string }[] = [
    { labelKey: "wave.tab.flagGreen", value: "#58C142" },
    { labelKey: "wave.tab.flagTeal", value: "#00FFDB" },
    { labelKey: "wave.tab.flagBlue", value: "#429DFF" },
    { labelKey: "wave.tab.flagPurple", value: "#BF55EC" },
    { labelKey: "wave.tab.flagRed", value: "#FF453A" },
    { labelKey: "wave.tab.flagOrange", value: "#FF9500" },
    { labelKey: "wave.tab.flagYellow", value: "#FFE900" },
];

// MOLTENTERM-PATCH (#408): sections, icons and sentence case (FR-SHELL-054); Copy tab id moved to Developer.
export function buildTabBarContextMenu(env: TabEnv, section?: string): ContextMenuItem[] {
    const currentTabBar = globalStore.get(env.getSettingsKeyAtom("app:tabbar")) ?? "top";
    const tabBarSubmenu: ContextMenuItem[] = [
        {
            label: t("wave.tab.tabBarTop"), // MOLTENTERM-PATCH (#623)
            type: "checkbox",
            checked: currentTabBar === "top",
            click: () => fireAndForget(() => env.rpc.SetConfigCommand(TabRpcClient, { "app:tabbar": "top" })),
        },
        {
            label: t("wave.tab.tabBarLeft"), // MOLTENTERM-PATCH (#623)
            type: "checkbox",
            checked: currentTabBar === "left",
            click: () => fireAndForget(() => env.rpc.SetConfigCommand(TabRpcClient, { "app:tabbar": "left" })),
        },
    ];
    // MOLTENTERM-PATCH (#623)
    return [
        {
            label: t("wave.tab.tabBarPosition"),
            type: "submenu",
            submenu: tabBarSubmenu,
            icon: "border-top-left",
            section,
        },
    ];
}

export function buildTabContextMenu(
    id: string,
    renameRef: React.RefObject<(() => void) | null>,
    onClose: (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null) => void,
    env: TabEnv
): ContextMenuItem[] {
    const menu: ContextMenuItem[] = [];
    menu.push({
        label: t("wave.tab.rename"), // MOLTENTERM-PATCH (#623)
        icon: "pen",
        accelerator: acceleratorById("rename-tab"),
        click: () => renameRef.current?.(),
    });
    const developer: ContextMenuItem = {
        label: t("wave.tab.copyId"), // MOLTENTERM-PATCH (#623)
        icon: "hashtag",
        section: DeveloperSection,
        click: () => fireAndForget(() => navigator.clipboard.writeText(id)),
    };
    const tabORef = makeORef("tab", id);
    const currentFlagColor = globalStore.get(getOrefMetaKeyAtom(tabORef, "tab:flagcolor")) ?? null;
    const flagSubmenu: ContextMenuItem[] = [
        {
            label: t("wave.tab.flagNone"), // MOLTENTERM-PATCH (#623)
            type: "checkbox",
            checked: currentFlagColor == null,
            click: () =>
                fireAndForget(() =>
                    env.rpc.SetMetaCommand(TabRpcClient, { oref: tabORef, meta: { "tab:flagcolor": null } })
                ),
        },
        ...FlagColors.map((fc) => ({
            label: t(fc.labelKey), // MOLTENTERM-PATCH (#623)
            type: "checkbox" as const,
            checked: currentFlagColor === fc.value,
            click: () =>
                fireAndForget(() =>
                    env.rpc.SetMetaCommand(TabRpcClient, { oref: tabORef, meta: { "tab:flagcolor": fc.value } })
                ),
        })),
    ];
    // MOLTENTERM-PATCH (#623)
    menu.push({ label: t("wave.tab.flag"), type: "submenu", submenu: flagSubmenu, icon: "flag" });
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
            label: t("wave.tab.backgroundDefault"), // MOLTENTERM-PATCH (#623)
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
        // MOLTENTERM-PATCH (#623)
        menu.push({ label: t("wave.tab.backgrounds"), type: "submenu", submenu, icon: "image" });
    }
    // MOLTENTERM-PATCH (#623)
    menu.push(...buildTabBarContextMenu(env, t("wave.tab.sectionTabBar")), developer, { type: "separator" });
    // MOLTENTERM-PATCH (#512): the workspace's last closed pane or tab comes back
    menu.push({
        label: t("wave.tab.reopenClosed"), // MOLTENTERM-PATCH (#623)
        icon: "rotate-left",
        accelerator: acceleratorById("reopen-closed"),
        click: () => fireAndForget(reopenLastClosed),
    });
    menu.push({
        label: t("wave.tab.close"), // MOLTENTERM-PATCH (#623)
        icon: "xmark",
        destructive: true,
        accelerator: acceleratorById("close-tab"),
        click: () => onClose(null),
    });
    return menu;
}
