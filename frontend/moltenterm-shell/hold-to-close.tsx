// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-SHELL-025 / DS-SHELL-026: a tab's close button closes only after a press-and-hold, so a click that lands slightly
// too far right on a tab no longer closes it. The deliberate paths (Cmd+W, the menus, middle-click) never go through it.
// The gesture itself is the shared hold-to-confirm piece (DS-SHELL-059, #354); this file gives it the tab's ×.

import { cn } from "@/util/util";
import { forwardRef } from "react";
import "./hold-to-close.css";
import {
    announceHoldHint,
    clampHoldMs,
    HoldCallbacks,
    HoldDefaultMs,
    HoldDiscViewBox,
    HoldFlashMs,
    HoldHintMs,
    HoldMaxMs,
    HoldMinMs,
    HoldReducedSteps,
    HoldReleaseMs,
    HoldRing,
    HoldRingStroke,
    HoldSettings,
    HoldTint,
    HoldTintMax,
    HoldToConfirmButton,
    HoldToConfirmController,
    HoldToConfirmEnv,
    makeHoldToConfirmController,
    resolveHoldSettings,
    useHoldSettings,
} from "./hold-to-confirm";

export const HoldToCloseMinMs = HoldMinMs;
export const HoldToCloseMaxMs = HoldMaxMs;
export const HoldToCloseDefaultMs = HoldDefaultMs;
export const HoldToCloseHintMs = HoldHintMs;
export const HoldToCloseReducedSteps = HoldReducedSteps;
export const HoldToCloseLabel = "Close tab, hold to confirm";
export const HoldToCloseHint = "Hold to close";

export const HoldToCloseFlashMs = HoldFlashMs;
export const HoldToCloseReleaseMs = HoldReleaseMs;
export const HoldToCloseTintMax = HoldTintMax;

export type HoldToCloseEnv = HoldToConfirmEnv;
export type HoldToCloseSettings = HoldSettings;
export type HoldToCloseCallbacks = HoldCallbacks;

export { clampHoldMs };
export const resolveHoldToCloseSettings = resolveHoldSettings;
export const HoldToCloseController = HoldToConfirmController;
export type HoldToCloseController = HoldToConfirmController;
export const makeHoldToCloseController = makeHoldToConfirmController;
export const useHoldToCloseSettings = useHoldSettings;
export const HoldToCloseRing = HoldRing;
export const HoldToCloseTint = HoldTint;

export function announceHoldToCloseHint(text: string = HoldToCloseHint) {
    announceHoldHint(text);
}

// The × is a 6 px stroke centred in the 16 px disc, so its butt ends stay 2 px inside the ring's inner edge (radius 6.5).
export function HoldToCloseGlyph() {
    return (
        <svg
            aria-hidden
            viewBox={`0 0 ${HoldDiscViewBox} ${HoldDiscViewBox}`}
            data-testid="hold-to-close-glyph"
            className="molten-hold-glyph pointer-events-none relative h-full w-full"
        >
            <path d="M5 5L11 11M11 5L5 11" fill="none" stroke="currentColor" strokeWidth={HoldRingStroke} />
        </svg>
    );
}

type HoldToCloseButtonProps = {
    onClose: (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null) => void;
    className?: string;
    plainTitle?: string;
    plainLabel?: string;
    as?: React.ElementType;
    onMouseDown?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
};

export const HoldToCloseButton = forwardRef<HTMLButtonElement, HoldToCloseButtonProps>(
    ({ onClose, className, plainTitle, plainLabel, as, onMouseDown }, ref) => (
        <HoldToConfirmButton
            ref={ref}
            onConfirm={(event) => onClose(event)}
            label={HoldToCloseLabel}
            hint={HoldToCloseHint}
            title={HoldToCloseHint}
            glyph={<HoldToCloseGlyph />}
            className={cn("molten-hold-close", className)}
            plainTitle={plainTitle}
            plainLabel={plainLabel}
            testId="tab-close"
            as={as}
            onMouseDown={onMouseDown}
        />
    )
);

HoldToCloseButton.displayName = "HoldToCloseButton";
