// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Split…" in every panel's menus (FR-SHELL-042-AC4, DS-SHELL-064, #677), with its keys from the shortcut registry.

import { t } from "../i18n/i18n";
import { acceleratorById } from "../shortcuts/format";
import { enterSplitPlacement } from "./split-place";

// The English labels identify the split items (views still add their own); the menus show the translated ones.
export const SplitRightLabel = "Split right";
export const SplitDownLabel = "Split down";
export const SplitPlaceLabel = "Split…";

export function splitRightLabel(): string {
    return t("split.right");
}

export function splitDownLabel(): string {
    return t("split.down");
}

export function splitPlaceLabel(): string {
    return t("split.place.menu");
}
// Distinct glyphs (FR-SHELL-054, DS-SHELL-095): the columns icon, and the same icon turned into rows (Font Awesome
// Free has no rows glyph). Every menu, the command panel and the header's split buttons use these.
export const SplitRightIcon = "table-columns";
export const SplitDownIcon = "table-columns fa-rotate-270";
// The placement mode offers every side: the four-cell glyph.
export const SplitPlaceIcon = "table-cells-large";
export const PanelSection = "Panel";

// A view's own menu items without its split items, for the block menu that already starts with them.
export function withoutSplitItems(items: ContextMenuItem[]): ContextMenuItem[] {
    if (items == null) {
        return items;
    }
    const labels = [
        SplitRightLabel,
        SplitDownLabel,
        SplitPlaceLabel,
        splitRightLabel(),
        splitDownLabel(),
        splitPlaceLabel(),
    ];
    const kept = items.filter((item) => !labels.includes(item.label));
    while (kept.length > 0 && kept[0].type === "separator") {
        kept.shift();
    }
    return kept;
}

// One "Split…" entry enters the split placement mode (#677): the panel shows its four sides and the user picks one.
// The direct keys (Cmd+D, Cmd+Shift+D, Ctrl+Shift+D, Ctrl+Shift+E) stay for speed.
export function splitMenuItems(blockId: string, section = PanelSection): ContextMenuItem[] {
    return [
        {
            label: splitPlaceLabel(),
            icon: SplitPlaceIcon,
            section,
            accelerator: acceleratorById("split-place"),
            click: () => enterSplitPlacement(blockId),
        },
    ];
}
