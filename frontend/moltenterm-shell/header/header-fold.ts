// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { type RefObject, useLayoutEffect, useState } from "react";

// A narrow panel header folds from the right in a stable order (#1439): under FoldViewButtonsPx the view's own buttons
// (and the opt-in split buttons) move into the "⋯" menu, under FoldMagnifyPx Magnify does too. One rule decides what
// folds, whether the "⋯" shows and what its menu lists (#1586): the "⋯" used to be shown by a stylesheet that Wave's
// header rules overrode, while its menu was built from another width, so it could show with an empty menu.
export const FoldViewButtonsPx = 340;
export const FoldMagnifyPx = 300;

// 0: nothing folds; 1: the view's buttons fold; 2: Magnify folds too.
export type HeaderFoldLevel = 0 | 1 | 2;

export type FoldableButton = {
    icon?: unknown;
    title?: string;
    disabled?: boolean;
    noAction?: boolean;
    click?: (e: any) => void;
};

export type HeaderFold<T extends FoldableButton> = {
    shown: T[];
    folded: T[];
    foldMagnify: boolean;
};

export type MoreMenuEntry<T extends FoldableButton> =
    | { kind: "button"; button: T; label: string; icon?: string; enabled: boolean }
    | { kind: "magnify" };

// The header's content width, the one a container query would read: a width not measured yet folds nothing.
export function headerFoldLevel(contentWidth: number): HeaderFoldLevel {
    if (!(contentWidth > 0) || contentWidth >= FoldViewButtonsPx) {
        return 0;
    }
    return contentWidth < FoldMagnifyPx ? 2 : 1;
}

// A button folds only when its menu row can name it; one without a title stays in the header at every width.
export function foldHeader<T extends FoldableButton>(
    buttons: T[],
    level: HeaderFoldLevel,
    canFoldMagnify: boolean
): HeaderFold<T> {
    if (level === 0) {
        return { shown: buttons, folded: [], foldMagnify: false };
    }
    const shown: T[] = [];
    const folded: T[] = [];
    for (const button of buttons) {
        if (typeof button.title === "string" && button.title.trim() !== "") {
            folded.push(button);
        } else {
            shown.push(button);
        }
    }
    return { shown, folded, foldMagnify: level === 2 && canFoldMagnify };
}

// Every folded button gets a row (an icon that is not a name, such as a drawn one, leaves the row without an icon);
// a status button with no action reads as a disabled row. The "⋯" shows exactly when this list is not empty.
export function moreMenuEntries<T extends FoldableButton>(fold: HeaderFold<T>): MoreMenuEntry<T>[] {
    const entries: MoreMenuEntry<T>[] = fold.folded.map((button) => ({
        kind: "button",
        button,
        label: button.title,
        icon: typeof button.icon === "string" ? button.icon : undefined,
        enabled: !button.disabled && !button.noAction && button.click != null,
    }));
    if (fold.foldMagnify) {
        entries.push({ kind: "magnify" });
    }
    return entries;
}

// The width a container query on el reads: its content box, without its padding.
export function contentBoxWidth(el: Element): number {
    if (el == null) {
        return 0;
    }
    const style = getComputedStyle(el);
    return el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}

// The fold level of the panel header holding ref, kept current as the panel is resized. Measured before the first
// paint, so a narrow panel never shows its unfolded row for a frame.
export function useHeaderFoldLevel(ref: RefObject<Element>): HeaderFoldLevel {
    const [level, setLevel] = useState<HeaderFoldLevel>(0);
    useLayoutEffect(() => {
        const header = ref.current?.closest(".block-frame-default-header");
        if (header == null) {
            return;
        }
        const update = () => setLevel(headerFoldLevel(contentBoxWidth(header)));
        update();
        const observer = new ResizeObserver(update);
        observer.observe(header);
        return () => observer.disconnect();
    }, []);
    return level;
}
