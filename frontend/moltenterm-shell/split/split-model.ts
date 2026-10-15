// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Split any panel, then choose its content (FR-SHELL-042, DS-SHELL-064): the rules, pure so they are tested without
// the app. split.ts carries them out on the layout.

export type SplitDirection = "right" | "down" | "left" | "up";

// The block meta key of a new panel's picker: the panel it was split from (DS-SHELL-066).
export const SplitFromMetaKey = "molten:splitfrom";

// Wave's layout refuses to resize a panel below 40 px (layoutModel.ts MinNodeSizePx); a split keeps both panels above.
export const MinPanelPx = 40;

export const HalfSplit = 0.5;

// Wave's split actions: horizontal puts the panels side by side, vertical one above the other.
export function splitAxis(direction: SplitDirection): {
    axis: "horizontal" | "vertical";
    position: "before" | "after";
} {
    switch (direction) {
        case "left":
            return { axis: "horizontal", position: "before" };
        case "up":
            return { axis: "vertical", position: "before" };
        case "down":
            return { axis: "vertical", position: "after" };
        default:
            return { axis: "horizontal", position: "after" };
    }
}

// The layout sizes of the source and the new panel: the new one takes its share of the source's own size, so the
// other panels of the row or column keep theirs (Wave's split gives the new panel a default size and shrinks them all).
export function splitSizes(sourceSize: number, fraction: number): { source: number; added: number } {
    const f = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : HalfSplit;
    return { source: sourceSize * (1 - f), added: sourceSize * f };
}

// What Enter on Terminal opens: a shell in the source panel's folder and on its connection, as Wave's Cmd+D did
// (keymodel.ts getDefaultNewBlockDef). A shell without cmd:cwd starts in the workspace folder (FR-SHELL-009, #82).
export function terminalBlockDefFrom(source: MetaType): BlockDef {
    const meta: MetaType = { view: "term", controller: "shell" };
    if (source?.view === "term" && source?.["cmd:cwd"] != null) {
        meta["cmd:cwd"] = source["cmd:cwd"];
    }
    if (source?.connection != null) {
        meta.connection = source.connection;
    }
    return { meta };
}

// The panel kinds the picker offers first, in this order (DS-SHELL-066); the configured widgets keep their own order
// after them.
export const PanelKindOrder = [
    "term",
    "molten-browser",
    "preview",
    "molten-project",
    "molten-linemap",
    "molten-cicd",
    "molten-reviews",
    "molten-companion",
    "molten-sessions",
    "sysinfo",
    "processviewer",
];

export function panelKindRank(view: string): number {
    const i = PanelKindOrder.indexOf(view);
    return i === -1 ? PanelKindOrder.length : i;
}

// The picker of a new panel shows at least this many panel rows (FR-SHELL-046-AC6, DS-SHELL-084): its search, a
// section title, the rows and its key hints. A panel with less room gets the picker as a popover instead.
export const PickerMinRows = 6;
export const PickerRowPx = 32;
export const PickerChromePx = 44 + 8 + 26 + 34;
export const PickerMinPx = PickerChromePx + PickerMinRows * PickerRowPx;
export const PickerPopoverWidthPx = 360;
const PopoverMarginPx = 8;

export function pickerFitsInline(availablePx: number): boolean {
    return availablePx >= PickerMinPx;
}

// The popover of a short panel's picker: 360 px wide, centred on the new panel from its top, kept inside the window;
// a panel too low for the popover below its top gets it raised so its bottom stays on screen.
export function pickerPopoverRect(
    panel: { left: number; top: number; width: number },
    win: { width: number; height: number }
): { left: number; top: number; width: number; height: number } {
    const width = Math.min(PickerPopoverWidthPx, win.width - 2 * PopoverMarginPx);
    const height = Math.min(PickerMinPx, win.height - 2 * PopoverMarginPx);
    const centred = panel.left + (panel.width - width) / 2;
    const left = Math.min(Math.max(centred, PopoverMarginPx), win.width - PopoverMarginPx - width);
    const top = Math.min(Math.max(panel.top, PopoverMarginPx), win.height - PopoverMarginPx - height);
    return { left, top, width, height };
}
