// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The width a top tab would take for its content (FR-SHELL-056): its padding, icon, agent mark and badges as laid out,
// plus the full width of its name. The name itself is measured as text, since its box is the tab's width minus the
// rest and so says nothing about the name. The close control floats over the end of the tab and takes no room.

import { TabLayoutItem } from "./tab-layout";

let canvas: HTMLCanvasElement = null;

function textWidth(text: string, font: string): number {
    if (canvas == null) {
        canvas = document.createElement("canvas");
    }
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
        return text.length * 7;
    }
    ctx.font = font;
    return ctx.measureText(text).width;
}

function px(value: string): number {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

export function measureTab(tab: HTMLElement): TabLayoutItem {
    if (tab == null) {
        return { natural: 0 };
    }
    const pinned = tab.dataset.moltenPinned === "true";
    const inner = tab.querySelector<HTMLElement>(".tab-inner");
    if (inner == null) {
        return { natural: 0, pinned };
    }
    const tabStyle = getComputedStyle(tab);
    const width = px(tabStyle.paddingLeft) + px(tabStyle.paddingRight) + rowWidth(inner) + closeRoom(inner);
    // One pixel of slack: canvas and layout round text differently, and a rounding miss would ellipsize the name.
    return { natural: width + 1, pinned };
}

// The close control floats over the end of the tab; the room it needs beyond the tab's own padding is kept, so a
// name never runs under it unless the tab is at its widest (then the name fades out under it).
const CloseGap = 2;

function closeRoom(inner: HTMLElement): number {
    const close = inner.querySelector<HTMLElement>(":scope > .close");
    if (close == null) {
        return 0;
    }
    const style = getComputedStyle(close);
    if (style.display === "none") {
        return 0;
    }
    const room = px(style.width) + px(style.right) + CloseGap - px(getComputedStyle(inner).paddingRight);
    return Math.max(0, room);
}

// A flex row's content width: its padding, gaps and children, the name as text and the body (which stretches to the
// tab) by its own children.
function rowWidth(row: HTMLElement): number {
    const style = getComputedStyle(row);
    const gap = px(style.columnGap);
    let width = px(style.paddingLeft) + px(style.paddingRight);
    let count = 0;
    for (const child of Array.from(row.children) as HTMLElement[]) {
        const childStyle = getComputedStyle(child);
        if (childStyle.position === "absolute" || childStyle.display === "none") {
            continue;
        }
        count++;
        if (child.classList.contains("name")) {
            width +=
                textWidth(child.textContent ?? "", childStyle.font) +
                px(childStyle.paddingLeft) +
                px(childStyle.paddingRight);
        } else if (child.classList.contains("molten-tab-body")) {
            width += rowWidth(child);
        } else {
            width += child.getBoundingClientRect().width;
        }
    }
    return width + gap * Math.max(0, count - 1);
}
