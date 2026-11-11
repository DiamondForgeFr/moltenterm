// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's menu (FR-BOSS-009, AC4, AC13 and AC21, #2003, #2032): When Brokk comes to fetch me (Preferences > Brokk, on the
// table), Brokk's preferences, and Turn Brokk off. It was the ⋯ of the panel's header; it is now the context menu of his
// title-bar face and of the square, and the ⋯ at the square's top right opens it. One list for the three, so no door of
// the old panel is lost.

import { fireAndForget } from "@/util/util";
import { openBrainstorm } from "../brainstorm/brainstorm-boot";
import { currentBrainstormAllowed } from "../build/current-build";
import { writeSettings } from "../command-panel/bindings";
import { t } from "../i18n/i18n";
import { openSettingsKey, openSettingsSection } from "../settings/settings-open";
import { BossShowSettingKey } from "./boss-name";

// The first row of the table "Quand Brokk vient me chercher" in Preferences: the key the menu brings into view.
export const BrokkTableFirstKey = "boss:visitsecurity";

export type BrokkMenuEntry = { label?: string; type?: "separator"; click?: () => void };

// `leave`: the item takes the developer somewhere else, so the group closes first. `first`: an entry of the surface that
// shows the menu (the face's Open Brokk), put before the common ones.
export function brokkMenuItems(name: string, leave?: () => void, first?: BrokkMenuEntry): BrokkMenuEntry[] {
    const items: BrokkMenuEntry[] = [];
    if (first != null) {
        items.push(first, { type: "separator" });
    }
    // Brokk's thought in 3D (FR-BOSS-010 AC2, #2246): the developer starts a brainstorm; gold, dev and local builds only.
    if (currentBrainstormAllowed()) {
        items.push(
            {
                label: t("boss.brainstorm.menu", { name }),
                click: () => fireAndForget(() => openBrainstorm()),
            },
            { type: "separator" }
        );
    }
    items.push(
        {
            label: t("boss.panel.menuComing", { name }),
            click: () => {
                leave?.();
                fireAndForget(() => openSettingsKey("boss", BrokkTableFirstKey));
            },
        },
        {
            label: t("boss.panel.menuSettings", { name }),
            click: () => {
                leave?.();
                fireAndForget(() => openSettingsSection("boss"));
            },
        },
        { type: "separator" },
        {
            label: t("boss.panel.menuOff", { name }),
            click: () => {
                leave?.();
                fireAndForget(() => writeSettings({ [BossShowSettingKey]: false }));
            },
        }
    );
    return items;
}
