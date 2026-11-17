// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The hello beside the folded avatar (FR-BOSS-009, AC74, #2217): a small bubble under the avatar, drawn over the page so
// that the sidebar or the title row cannot clip it. Under the hanging avatar, at the window's right, it lines up on the
// avatar's right edge; elsewhere on its left edge. It takes no pointer and no focus.

import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AvatarVariant } from "./brokk-avatar-model";
import "./brokk-hello-bubble.css";

export const HelloGapPx = 6;

export function helloBubblePlace(
    rect: { left: number; right: number; bottom: number },
    variant: AvatarVariant,
    viewportWidth: number
): React.CSSProperties {
    const top = rect.bottom + HelloGapPx;
    if (variant === "hanging") {
        return { top, right: Math.max(viewportWidth - rect.right, 0) };
    }
    return { top, left: Math.max(rect.left, 0) };
}

export function HelloBubbleView({
    text,
    anchor,
    variant,
}: {
    text: string;
    anchor: React.RefObject<HTMLElement>;
    variant: AvatarVariant;
}) {
    const [place, setPlace] = useState<React.CSSProperties>(null);
    useLayoutEffect(() => {
        const rect = anchor.current?.getBoundingClientRect();
        if (rect != null) {
            setPlace(helloBubblePlace(rect, variant, window.innerWidth));
        }
    }, [anchor, variant]);
    return createPortal(
        <div
            className="mt-brokk-hello"
            role="status"
            data-testid="brokk-hello"
            style={place ?? { visibility: "hidden" }}
        >
            {text}
        </div>,
        document.body
    );
}
