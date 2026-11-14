// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The developer's entries of a page's right-click (FR-BRW-022 AC1, AC3, AC7, AC8): Inspect, Close inspector while the
// tools are docked, Clear this site's data… on a web page and Clear the browser cache…. Inspect stays while the tools
// are open: it selects the clicked element in them. The toggle shows the platform's keys.

import { isMacOS } from "@/util/platformutil";
import { t } from "../i18n/i18n";
import { acceleratorById } from "../shortcuts/format";

export type InspectorMenuActions = {
    open: boolean;
    // The page is a web page with an origin whose data can be cleared.
    clearable: boolean;
    inspect: () => void;
    close: () => void;
    clearSite: () => void;
    clearCache: () => void;
};

export function inspectorMenuItems(a: InspectorMenuActions, mac = isMacOS()): ContextMenuItem[] {
    const accelerator = acceleratorById(mac ? "browser-inspect" : "browser-inspect-other", mac);
    const items: ContextMenuItem[] = [
        {
            label: t("browser.inspector.inspect"),
            icon: "code",
            accelerator: a.open ? undefined : accelerator,
            click: a.inspect,
        },
    ];
    if (a.open) {
        items.push({ label: t("browser.inspector.close"), icon: "xmark", accelerator, click: a.close });
    }
    if (a.clearable) {
        items.push({ label: t("browser.siteData.clearSite"), icon: "eraser", click: a.clearSite });
    }
    items.push({ label: t("browser.siteData.clearCache"), icon: "broom", click: a.clearCache });
    return items;
}
