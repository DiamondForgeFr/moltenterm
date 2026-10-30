// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A menu that belongs to a button opens under that button, not where the event says the pointer was (#1439): a script
// click or an Enter or Space on the button carries clientX and clientY of 0, which would put the menu in the window's
// corner. The shared menu host places a menu at the event's point, so the event it receives carries the button's lower
// start corner as that point. Its type, detail and target stay, so a keyboard opening still focuses the first row.
// A plain object, not an object inheriting the event: a native event's getters refuse any other receiver.
export type MenuAnchor = { left: number; bottom: number };

type MenuEventLike = {
    type?: string;
    detail?: number;
    altKey?: boolean;
    target?: EventTarget;
    currentTarget?: EventTarget;
    stopPropagation?: () => void;
    preventDefault?: () => void;
};

export function anchoredMenuEvent<T extends MenuEventLike>(event: T, anchor: MenuAnchor): T {
    const source = event as MenuEventLike & Record<string, unknown>;
    const anchored = {
        type: source.type,
        detail: source.detail,
        altKey: source.altKey,
        target: source.target,
        currentTarget: source.currentTarget,
        contextMenuGuestId: source.contextMenuGuestId,
        contextMenuImageToken: source.contextMenuImageToken,
        clientX: anchor.left,
        clientY: anchor.bottom,
        stopPropagation: () => source.stopPropagation?.(),
        preventDefault: () => source.preventDefault?.(),
    };
    return anchored as unknown as T;
}

export function buttonMenuAnchor(target: Element): MenuAnchor {
    const rect = (target.closest("button") ?? target).getBoundingClientRect();
    return { left: rect.left, bottom: rect.bottom };
}
