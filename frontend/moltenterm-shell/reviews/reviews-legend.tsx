// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The legend of the cards' colours (#2332, FR-REV-001 AC20): a calm icon button in the panel's header bar, never an
// element always in sight. Hovering it (after a tooltip's delay) or focusing it with the keyboard shows the card, which
// stays open while the pointer moves onto it; a click pins it open for reading, and Escape or a click outside closes it.
// The card draws each line's rail and state mark with the cards' own components, from their own tone tables.

import { cn } from "@/util/util";
import {
    autoUpdate,
    flip,
    FloatingPortal,
    offset,
    safePolygon,
    shift,
    useClick,
    useDismiss,
    useFocus,
    useHover,
    useInteractions,
    useRole,
} from "@floating-ui/react";
import { useEffect, useRef, useState } from "react";
import { useFloatingInPlace } from "../floating-in-place";
import { useT } from "../i18n/i18n";
import { StateMark } from "../state-mark";
import { RailColours, SentenceClasses, ToneMarks } from "./reviews-card";
import {
    legendChange,
    LegendClosed,
    legendEntries,
    LegendHoverDelay,
    legendReturnsFocus,
    LegendState,
} from "./reviews-legend-model";

// The card's content, apart from the floating surface so that it renders without a window in tests.
export function LegendCard() {
    const t = useT();
    const entries = legendEntries(RailColours, ToneMarks);
    return (
        <div
            className="flex w-[300px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-4 border border-border bg-surface-3 shadow-e3"
            data-testid="reviews-legend"
        >
            <div className="flex flex-col gap-0.5 border-b border-border px-3.5 py-2">
                <span className="text-12 leading-4 font-medium text-primary">{t("reviews.legend.title")}</span>
                <span className="text-11 leading-4 text-muted">{t("reviews.legend.intro")}</span>
            </div>
            <ul className="m-0 flex list-none flex-col p-0">
                {entries.map((entry) => (
                    <li
                        key={entry.tone}
                        className="relative flex flex-col gap-0.5 border-b border-border py-2 pr-3 pl-[15px] last:border-b-0"
                        data-testid="reviews-legend-line"
                        data-tones={entry.tones.join(" ")}
                    >
                        <span
                            className="absolute inset-y-0 left-0 w-[3px]"
                            style={{ background: RailColours[entry.tone] }}
                            aria-hidden
                            data-testid="reviews-legend-rail"
                        />
                        <div
                            className={cn(
                                "flex min-w-0 items-baseline gap-1.5 text-12 leading-4 font-medium",
                                SentenceClasses[entry.tone]
                            )}
                        >
                            <StateMark kind={entry.mark} className="self-center" testId="reviews-legend-dot" />
                            <span data-testid="reviews-legend-label">{t(entry.labelKey)}</span>
                        </div>
                        <p className="m-0 pl-3.5 text-11 leading-4 text-secondary" data-testid="reviews-legend-meaning">
                            {entry.meaningKeys.map((key) => t(key)).join(" ")}
                        </p>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function LegendButton() {
    const t = useT();
    const [state, setState] = useState<LegendState>(LegendClosed);
    const returnFocus = useRef(false);
    const { refs, floatingStyles, context } = useFloatingInPlace({
        open: state.open,
        onOpenChange: (open, _event, reason) => {
            returnFocus.current = legendReturnsFocus(open, reason);
            setState((prev) => legendChange(prev, open, reason));
        },
        placement: "bottom-end",
        middleware: [offset(6), flip(), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    const hover = useHover(context, { move: false, delay: LegendHoverDelay, handleClose: safePolygon() });
    const focus = useFocus(context);
    const click = useClick(context);
    const dismiss = useDismiss(context);
    const role = useRole(context, { role: "tooltip" });
    const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, click, dismiss, role]);
    useEffect(() => {
        if (state.open || !returnFocus.current) {
            return;
        }
        returnFocus.current = false;
        (refs.domReference.current as HTMLElement)?.focus();
    }, [state.open, refs]);
    return (
        <>
            <button
                ref={refs.setReference}
                type="button"
                aria-label={t("reviews.legend.button")}
                aria-pressed={state.pinned}
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-muted hover:bg-hover hover:text-primary"
                data-testid="reviews-legend-button"
                {...getReferenceProps()}
            >
                <i className="fa fa-regular fa-circle-question text-11" />
            </button>
            {state.open ? (
                <FloatingPortal>
                    <div ref={refs.setFloating} style={floatingStyles} className="z-[1000]" {...getFloatingProps()}>
                        <LegendCard />
                    </div>
                </FloatingPortal>
            ) : null}
        </>
    );
}
