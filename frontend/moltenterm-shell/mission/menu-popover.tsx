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

export function MenuPopover({
    anchor,
    onClose,
    className,
    children,
}: {
    anchor: HTMLElement;
    onClose: () => void;
    className?: string;
    children: React.ReactNode;
}) {
    const boundary = paneOf(anchor);
    const { refs, floatingStyles, context } = useFloating({
        open: true,
        onOpenChange: (open) => {
            if (!open) {
                onClose();
            }
        },
        placement: "bottom-start",
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
                {...getFloatingProps()}
                className={cn(
                    "z-[9500] overflow-y-auto rounded border border-border bg-modalbg p-3 shadow-lg",
                    className
                )}
                data-testid="menu-popover"
            >
                {children}
            </div>
        </FloatingPortal>
    );
}
