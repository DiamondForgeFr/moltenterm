// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The popover of connect mode (FR-MC-032-AC2, DS-MC-029): the hint beside the target, past its buds; a refused join or
// a failed group command shows its message in the same place for a few seconds.

import { useAtomValue } from "jotai";
import { useLayoutEffect, useState } from "react";
import { connectTargetSelector, RailConnectHint, RailConnectModel } from "./rail-connect";

type Place = { top: number; left: number };

// Right of the element's bud chain when it is out, else right of the element.
function placeBeside(element: Element): Place {
    if (element == null) {
        return null;
    }
    const bud = element.querySelector(".molten-rail-bud");
    const item =
        element.querySelector(".molten-rail-anchor, button[data-workspace-id], button[data-rail-product]") ?? element;
    const itemRect = item.getBoundingClientRect();
    const budRect = bud?.getBoundingClientRect();
    const right = budRect != null && budRect.width > 0 ? Math.max(budRect.right, itemRect.right) : itemRect.right;
    return { top: itemRect.top + itemRect.height / 2, left: right + 8 };
}

export function RailConnectPopover({ navRef, revision }: { navRef: React.RefObject<HTMLElement>; revision: string }) {
    const model = RailConnectModel.getInstance();
    const target = useAtomValue(model.targetAtom);
    const message = useAtomValue(model.messageAtom);
    const [place, setPlace] = useState<Place>(null);
    const [tick, setTick] = useState(0);
    const selector = message?.anchor ?? connectTargetSelector(target);
    const text = message?.text ?? (target != null ? RailConnectHint : null);
    useLayoutEffect(() => {
        if (selector == null || text == null) {
            setPlace(null);
            return;
        }
        setPlace(placeBeside(document.querySelector(selector)));
    }, [selector, text, revision, tick]);
    useLayoutEffect(() => {
        if (selector == null) {
            return;
        }
        const nav = navRef.current;
        const bump = () => setTick((t) => t + 1);
        nav?.addEventListener("scroll", bump, { passive: true });
        window.addEventListener("resize", bump);
        // The chain's buds slide out after the click: place the popover again once they settled.
        const settle = setTimeout(bump, 320);
        return () => {
            nav?.removeEventListener("scroll", bump);
            window.removeEventListener("resize", bump);
            clearTimeout(settle);
        };
    }, [navRef, selector]);
    if (place == null || text == null) {
        return null;
    }
    return (
        <div
            // The polite live region already says it (RailConnectModel).
            aria-hidden
            data-testid="rail-connect-hint"
            className="molten-rail-connect-hint pointer-events-none fixed z-[9500] max-w-[28rem] -translate-y-1/2 rounded-10 border border-border bg-surface-3 px-2 py-1 text-12 text-primary shadow-e2"
            style={{ top: place.top, left: place.left }}
        >
            {text}
        </div>
    );
}
