// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How many of the filter's names the panel's header has room for (FR-REV-034 AC12, #2207). The header is measured, not
// guessed: the title, the pill and the end buttons do not give way, so the room is what they leave, whatever the names
// currently drawn take.

import { ownersNamesFit } from "./reviews-owners-model";

const NamesGapPx = 4;
const NamesSlackPx = 2;

// headerRoomPx: the width the header leaves its text: its inside, less its other items and the gaps between them.
export function headerRoomPx(header: Element): number {
    const style = getComputedStyle(header);
    const inner = header.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    let used = 0;
    let items = 0;
    for (const child of Array.from(header.children)) {
        const childStyle = getComputedStyle(child);
        const boxless = childStyle.display === "none" || childStyle.display === "contents";
        if (boxless || childStyle.position === "absolute" || childStyle.position === "fixed") {
            continue;
        }
        items++;
        if (!child.classList.contains("block-frame-textelems-wrapper")) {
            used += (child as HTMLElement).offsetWidth;
        }
    }
    return inner - used - (parseFloat(style.columnGap) || 0) * Math.max(0, items - 1);
}

// ownersNamesFitting: the count for the names, read with the font the header draws them in.
export function ownersNamesFitting(header: Element, names: readonly string[]): number {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx == null) {
        return names.length;
    }
    const style = getComputedStyle(header.querySelector(".mt-owners-list") ?? header);
    ctx.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    const measure = (text: string) => ctx.measureText(text).width;
    const room = headerRoomPx(header) - measure("·") - NamesGapPx - NamesSlackPx;
    return ownersNamesFit(names, room, measure);
}
