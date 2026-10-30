// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Menus, popovers and flyouts appear at their place (#1440). floating-ui places a surface with an inline
// `transform: translate(x, y)` by default: an entrance keyframe on `transform` (a short scale or rise from the anchor)
// then overrides that inline style for its duration, and the surface travels from the viewport's corner to its anchor.
// Every floating surface goes through this hook instead of useFloating: the position goes through `left`/`top`, so
// `transform` stays free for an in-place entrance, and the surface stays hidden until floating-ui measured it, so its
// first painted frame is its final place.

import { useFloating, type ReferenceType, type UseFloatingOptions, type UseFloatingReturn } from "@floating-ui/react";
import type { CSSProperties } from "react";

export function placedFloatingStyles(floatingStyles: CSSProperties, isPositioned: boolean): CSSProperties {
    return { ...floatingStyles, visibility: isPositioned ? "visible" : "hidden" };
}

export function useFloatingInPlace<RT extends ReferenceType = ReferenceType>(
    options: Omit<Partial<UseFloatingOptions>, "transform"> = {}
): UseFloatingReturn<RT> {
    const floating = useFloating<RT>({ ...options, transform: false });
    return { ...floating, floatingStyles: placedFloatingStyles(floating.floatingStyles, floating.isPositioned) };
}
