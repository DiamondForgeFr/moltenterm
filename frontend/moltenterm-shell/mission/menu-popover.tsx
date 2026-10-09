// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The menus Mission Control opens under a button (Build local, Release): portalled out of the pane so no overflow
// hides them, placed under the button's start, flipped above or shifted sideways when they would leave the pane, and
// capped to the room left, scrolling inside.

import { cn } from "@/util/util";
import {
    autoUpdate,
    flip,
    FloatingPortal,
    offset,
    type Placement,
    shift,
    size,
    useDismiss,
    useFloating,
    useInteractions,
} from "@floating-ui/react";

const EdgePadding = 8;
const MinMenuHeight = 160;

// The pane holding the button: the menu stays inside it, else inside the window.
function paneOf(el: Element): Element {
    return el?.closest("[data-blockid]") ?? document.body;
}

// The line map (FR-MC-022) opens its details the same way, on hover: anchored to an SVG mark, above it by default, and
// told when the pointer enters or leaves so the detail stays open while it is read.
export function MenuPopover({
    anchor,
    onClose,
    className,
    children,
    placement = "bottom-start",
    onPointerEnter,
    onPointerLeave,
}: {
    anchor: Element;
    onClose: () => void;
    className?: string;
    children: React.ReactNode;
    placement?: Placement;
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
}) {
    const boundary = paneOf(anchor);
    const { refs, floatingStyles, context } = useFloating({
        open: true,
        onOpenChange: (open) => {
            if (!open) {
                onClose();
            }
        },
        placement,
        strategy: "fixed",
        elements: { reference: anchor },
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(4),
            flip({ boundary, padding: EdgePadding, fallbackPlacements: ["bottom-end", "top-start", "top-end"] }),
            shift({ boundary, padding: EdgePadding, crossAxis: true }),
            size({
                boundary,
                padding: EdgePadding,
                apply({ availableWidth, availableHeight, elements }) {
                    elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
                    elements.floating.style.maxHeight = `${Math.max(MinMenuHeight, availableHeight)}px`;
                },
            }),
        ],
    });
    const { getFloatingProps } = useInteractions([useDismiss(context)]);
    return (
        <FloatingPortal>
            <div
                ref={refs.setFloating}
                style={floatingStyles}
                {...getFloatingProps({ onPointerEnter, onPointerLeave })}
                className={cn(
                    "z-[9500] overflow-y-auto rounded-10 border border-border bg-surface-3 p-3 shadow-e2",
                    className
                )}
                data-testid="menu-popover"
            >
                {children}
            </div>
        </FloatingPortal>
    );
}
