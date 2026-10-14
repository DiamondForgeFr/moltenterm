// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Split right and Split down in every panel's menus (FR-SHELL-042-AC4, DS-SHELL-064), with their keys from the
// shortcut registry.

import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { acceleratorById } from "../shortcuts/format";
import { splitPanel } from "./split";

// The English labels identify the split items; the menus show splitRightLabel() and splitDownLabel().
export const SplitRightLabel = "Split right";
export const SplitDownLabel = "Split down";

export function splitRightLabel(): string {
    return t("split.right");
}

export function splitDownLabel(): string {
    return t("split.down");
}
// Distinct glyphs (FR-SHELL-054, DS-SHELL-095): the columns icon, and the same icon turned into rows (Font Awesome
// Free has no rows glyph). Every menu, the command panel and the header's split buttons use these.
export const SplitRightIcon = "table-columns";
export const SplitDownIcon = "table-columns fa-rotate-270";
export const PanelSection = "Panel";

// A view's own menu items without its split items, for the block menu that already starts with them.
export function withoutSplitItems(items: ContextMenuItem[]): ContextMenuItem[] {
    if (items == null) {
        return items;
    }
    const labels = [SplitRightLabel, SplitDownLabel, splitRightLabel(), splitDownLabel()];
    const kept = items.filter((item) => !labels.includes(item.label));
    while (kept.length > 0 && kept[0].type === "separator") {
        kept.shift();
    }
    return kept;
}

export function splitMenuItems(blockId: string, section = PanelSection): ContextMenuItem[] {
    return [
        {
            label: splitRightLabel(),
            icon: SplitRightIcon,
            section,
            accelerator: acceleratorById("split-right"),
            click: () => fireAndForget(() => splitPanel(blockId, "right")),
        },
        {
            label: splitDownLabel(),
            icon: SplitDownIcon,
            section,
            accelerator: acceleratorById("split-down"),
            click: () => fireAndForget(() => splitPanel(blockId, "down")),
        },
    ];
}
