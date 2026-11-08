// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The browser panel's own shortcuts (#1722, FR-SHELL-007): the keys every browser answers, per platform, in Wave's key
// notation (keyutil.ts, where "Cmd" is Command on macOS and Alt elsewhere, so the other platforms spell Ctrl out).
// Keys pressed in a page reach its guest webContents, not MoltenTerm's window: emain holds back the ones listed by
// browserPageKeys and sends them back with the page's webContents id, and routeBrowserPageKey hands them to the panel
// that holds the page, before the window's own shortcuts, whatever panel the layout believes is focused.

import { checkKeyPressed } from "@/util/keyutil";

export const BrowserKeyReload = "reload";
export const BrowserKeyHardReload = "hard-reload";
export const BrowserKeyBack = "back";
export const BrowserKeyForward = "forward";
export const BrowserKeyFind = "find";
export const BrowserKeyZoomIn = "zoom-in";
export const BrowserKeyZoomOut = "zoom-out";
export const BrowserKeyZoomReset = "zoom-reset";
export const BrowserKeyAddress = "address";
export const BrowserKeyStop = "stop";

type KeyTable = { action: string; mac: string[]; other: string[] }[];

// Zoom takes "=" and "+" because "+" needs Shift on some layouts and not on others, and the numpad's sends "+".
const BrowserKeyTable: KeyTable = [
    { action: BrowserKeyHardReload, mac: ["Cmd:Shift:r", "Shift:F5"], other: ["Ctrl:Shift:r", "Ctrl:F5", "Shift:F5"] },
    { action: BrowserKeyReload, mac: ["Cmd:r", "F5"], other: ["Ctrl:r", "F5"] },
    { action: BrowserKeyBack, mac: ["Cmd:[", "Cmd:ArrowLeft"], other: ["Alt:ArrowLeft"] },
    { action: BrowserKeyForward, mac: ["Cmd:]", "Cmd:ArrowRight"], other: ["Alt:ArrowRight"] },
    { action: BrowserKeyFind, mac: ["Cmd:f"], other: ["Ctrl:f"] },
    {
        action: BrowserKeyZoomIn,
        mac: ["Cmd:=", "Cmd:+", "Cmd:Shift:=", "Cmd:Shift:+"],
        other: ["Ctrl:=", "Ctrl:+", "Ctrl:Shift:=", "Ctrl:Shift:+"],
    },
    { action: BrowserKeyZoomOut, mac: ["Cmd:-", "Cmd:Shift:-"], other: ["Ctrl:-", "Ctrl:Shift:-"] },
    { action: BrowserKeyZoomReset, mac: ["Cmd:0"], other: ["Ctrl:0"] },
    { action: BrowserKeyAddress, mac: ["Cmd:l"], other: ["Ctrl:l"] },
    { action: BrowserKeyStop, mac: ["Escape"], other: ["Escape"] },
];

// Chromium's zoom levels, within the 30–300 % the panel allows.
export const BrowserZoomSteps = [30, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];

export function browserKeyAction(e: WaveKeyboardEvent, mac: boolean): string {
    if (e == null || e.type !== "keydown") {
        return null;
    }
    for (const row of BrowserKeyTable) {
        for (const keys of mac ? row.mac : row.other) {
            if (checkKeyPressed(e, keys)) {
                return row.action;
            }
        }
    }
    return null;
}

// The keys emain holds back from a page so that the panel answers them; Escape is already one of the window's.
export function browserPageKeys(mac: boolean): string[] {
    const rtn: string[] = [];
    for (const row of BrowserKeyTable) {
        rtn.push(...(mac ? row.mac : row.other));
    }
    return rtn;
}

export function nextZoomStep(percent: number, direction: 1 | -1): number {
    const current = percent > 0 ? percent : 100;
    if (direction > 0) {
        return BrowserZoomSteps.find((s) => s > current) ?? BrowserZoomSteps[BrowserZoomSteps.length - 1];
    }
    for (let i = BrowserZoomSteps.length - 1; i >= 0; i--) {
        if (BrowserZoomSteps[i] < current) {
            return BrowserZoomSteps[i];
        }
    }
    return BrowserZoomSteps[0];
}

export type BrowserKeyTarget = {
    viewType: string;
    pageKeyDownHandler?: (e: WaveKeyboardEvent) => boolean;
    historyKeyHandler?: (direction: 1 | -1) => boolean;
};

// Back and forward from the window's own keys (#1744, FR-SHELL-139): a browser window is a view and its tab a panel, so
// ⌘[ and ⌘] (Alt+← and Alt+→ off macOS) are the page's while the focus is in a browser panel, its page or its own
// controls, and switch views anywhere else.
export type HistoryFocus = {
    // The panel that holds the DOM focus, not the one the layout believes is focused: a click on the sidebar leaves the
    // layout's focus behind, and the key must then keep switching views.
    focusedBlockId: () => string;
    modelOf: (blockId: string) => BrowserKeyTarget;
};

// true: the browser panel holding the focus took the key (it never falls through to a view switch, even with no history
// to go to, as in a browser); false: the window handles it.
export function pageHistoryKey(direction: 1 | -1, focus: HistoryFocus): boolean {
    const blockId = focus.focusedBlockId();
    if (blockId == null) {
        return false;
    }
    const model = focus.modelOf(blockId);
    if (model?.historyKeyHandler == null) {
        return false;
    }
    return model.historyKeyHandler(direction);
}

// Alt+← and Alt+→ are the browsers' own back and forward off macOS, where the window's ⌘[ and ⌘] are Alt+[ and Alt+],
// keys no browser answers. Nothing else binds them, so a focus outside a browser panel leaves them to the program.
export function registerHistoryKeys(
    keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>,
    mac: boolean,
    onKey: (direction: 1 | -1) => boolean
): void {
    if (mac) {
        return;
    }
    keyMap.set("Alt:ArrowLeft", () => onKey(-1));
    keyMap.set("Alt:ArrowRight", () => onKey(1));
}

type PageElement = { getWebContentsId(): number; closest(selector: string): { getAttribute(name: string): string } };

// The block holding the page whose webContents sent the key, found among the window's webviews.
export function blockIdOfPage(webContentsId: number, pages: Iterable<PageElement>): string {
    if (webContentsId == null) {
        return null;
    }
    for (const page of pages) {
        let id: number = null;
        try {
            id = page.getWebContentsId();
        } catch {
            continue; // a webview throws until its first dom-ready
        }
        if (id === webContentsId) {
            return page.closest("[data-blockid]")?.getAttribute("data-blockid") ?? null;
        }
    }
    return null;
}

// A key sent back from a page goes to the browser panel holding that page first; false lets the window handle it.
export function routeBrowserPageKey(
    e: WaveKeyboardEvent,
    webContentsId: number,
    pages: Iterable<PageElement>,
    modelOf: (blockId: string) => BrowserKeyTarget
): boolean {
    const blockId = blockIdOfPage(webContentsId, pages);
    if (blockId == null) {
        return false;
    }
    const model = modelOf(blockId);
    if (model?.pageKeyDownHandler == null) {
        return false;
    }
    return model.pageKeyDownHandler(e);
}
