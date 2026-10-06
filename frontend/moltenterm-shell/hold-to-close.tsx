// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-SHELL-025 / DS-SHELL-026: a tab's close button closes only after a press-and-hold, so a click that lands slightly
// too far right on a tab no longer closes it. The deliberate paths (Cmd+W, the menus, middle-click) never go through it.

import { SettingsKeyAtomFnType, useWaveEnv, WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { cn } from "@/util/util";
import { Atom, atom, useAtomValue } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./hold-to-close.css";

export const HoldToCloseMinMs = 200;
export const HoldToCloseMaxMs = 2000;
export const HoldToCloseDefaultMs = 600;
export const HoldToCloseHintMs = 1500;
export const HoldToCloseReducedSteps = 4;
export const HoldToCloseLabel = "Close tab, hold to confirm";
export const HoldToCloseHint = "Hold to close";

export const HoldToCloseFlashMs = 120;
export const HoldToCloseReleaseMs = 160;
export const HoldToCloseTintMax = 0.25;

// A 16 px disc: the ring is a 1.5 px stroke on its edge (radius 7.25), the × a 6 px stroke centred in it, so the butt
// ends of the × stay 2 px inside the ring's inner edge (radius 6.5).
const DiscViewBox = 16;
const RingStroke = 1.5;
const RingRadius = (DiscViewBox - RingStroke) / 2;
const RingLength = 2 * Math.PI * RingRadius;
const LiveRegionId = "molten-hold-to-close-live";

export type HoldToCloseEnv = WaveEnvSubset<{
    atoms: {
        prefersReducedMotionAtom: WaveEnv["atoms"]["prefersReducedMotionAtom"];
    };
    getSettingsKeyAtom: SettingsKeyAtomFnType<"tab:holdtoclose" | "tab:holdtoclosems">;
}>;

export type HoldToCloseSettings = {
    enabled: boolean;
    durationMs: number;
    reducedMotion: boolean;
};

export type HoldToCloseCallbacks = {
    onHoldChange: (holding: boolean) => void;
    onComplete: () => void;
    onHint: () => void;
};

export function clampHoldMs(value: number): number {
    if (value == null || !Number.isFinite(value)) {
        return HoldToCloseDefaultMs;
    }
    return Math.min(HoldToCloseMaxMs, Math.max(HoldToCloseMinMs, Math.round(value)));
}

export function resolveHoldToCloseSettings(
    enabled: boolean,
    durationMs: number,
    reducedMotion: boolean
): HoldToCloseSettings {
    return { enabled: enabled !== false, durationMs: clampHoldMs(durationMs), reducedMotion: !!reducedMotion };
}

// Completion comes from a timer, never from transitionend: reduced motion or a hidden window can skip the transition.
export class HoldToCloseController {
    durationMs: number;
    holding = false;
    timer: ReturnType<typeof setTimeout> = null;
    callbacks: HoldToCloseCallbacks;

    constructor(durationMs: number, callbacks: HoldToCloseCallbacks) {
        this.durationMs = clampHoldMs(durationMs);
        this.callbacks = callbacks;
    }

    setDuration(durationMs: number) {
        this.durationMs = clampHoldMs(durationMs);
    }

    press() {
        if (this.holding) {
            return;
        }
        this.holding = true;
        this.timer = setTimeout(() => this.finish(), this.durationMs);
        this.callbacks.onHoldChange(true);
    }

    // A release before the ring completes is a click (or a hold too short): it explains the gesture instead of closing.
    release() {
        if (!this.holding) {
            return;
        }
        this.stop();
        this.callbacks.onHint();
    }

    cancel() {
        if (!this.holding) {
            return;
        }
        this.stop();
    }

    dispose() {
        clearTimeout(this.timer);
        this.timer = null;
        this.holding = false;
    }

    stop() {
        clearTimeout(this.timer);
        this.timer = null;
        this.holding = false;
        this.callbacks.onHoldChange(false);
    }

    finish() {
        this.timer = null;
        this.holding = false;
        this.callbacks.onHoldChange(false);
        this.callbacks.onComplete();
    }
}

export function makeHoldToCloseController(durationMs: number, callbacks: HoldToCloseCallbacks): HoldToCloseController {
    return new HoldToCloseController(durationMs, callbacks);
}

// One polite live region for the whole window; the text is cleared first so the same hint is announced again.
export function announceHoldToCloseHint(text: string = HoldToCloseHint) {
    if (typeof document === "undefined") {
        return;
    }
    let region = document.getElementById(LiveRegionId);
    if (region == null) {
        region = document.createElement("div");
        region.id = LiveRegionId;
        region.className = "sr-only";
        region.setAttribute("aria-live", "polite");
        region.setAttribute("role", "status");
        document.body.appendChild(region);
    }
    region.textContent = "";
    const target = region;
    setTimeout(() => {
        target.textContent = text;
    }, 50);
}

const FallbackEnabledAtom = atom(true) as Atom<boolean>;
const FallbackDurationAtom = atom(HoldToCloseDefaultMs) as Atom<number>;
const FallbackReducedMotionAtom = atom(false) as Atom<boolean>;

export function useHoldToCloseSettings(): HoldToCloseSettings {
    const env = useWaveEnv<HoldToCloseEnv>();
    const enabled = useAtomValue(env?.getSettingsKeyAtom?.("tab:holdtoclose") ?? FallbackEnabledAtom);
    const durationMs = useAtomValue(env?.getSettingsKeyAtom?.("tab:holdtoclosems") ?? FallbackDurationAtom);
    const reducedMotion = useAtomValue(env?.atoms?.prefersReducedMotionAtom ?? FallbackReducedMotionAtom);
    return resolveHoldToCloseSettings(enabled, durationMs, reducedMotion);
}

export function HoldToCloseRing({
    holding,
    durationMs,
    reducedMotion,
}: {
    holding: boolean;
    durationMs: number;
    reducedMotion: boolean;
}) {
    const timing = reducedMotion ? `steps(${HoldToCloseReducedSteps}, end)` : "ease-out";
    const releaseTransition = reducedMotion ? "none" : `stroke-dashoffset ${HoldToCloseReleaseMs}ms ease-out`;
    return (
        <svg
            aria-hidden
            viewBox={`0 0 ${DiscViewBox} ${DiscViewBox}`}
            data-testid="hold-to-close-ring"
            className={cn(
                "molten-hold-close-ring pointer-events-none absolute inset-0 h-full w-full -rotate-90",
                holding ? "opacity-100" : "opacity-0"
            )}
        >
            <circle
                cx={DiscViewBox / 2}
                cy={DiscViewBox / 2}
                r={RingRadius}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.15}
                strokeWidth={RingStroke}
            />
            <circle
                cx={DiscViewBox / 2}
                cy={DiscViewBox / 2}
                r={RingRadius}
                fill="none"
                className="molten-hold-close-fill"
                stroke="var(--color-accent)"
                strokeWidth={RingStroke}
                strokeLinecap="round"
                strokeDasharray={`${RingLength} ${RingLength}`}
                style={{
                    strokeDashoffset: holding ? 0 : RingLength,
                    transition: holding ? `stroke-dashoffset ${durationMs}ms ${timing}` : releaseTransition,
                }}
            />
        </svg>
    );
}

export function HoldToCloseTint({
    holding,
    durationMs,
    reducedMotion,
}: {
    holding: boolean;
    durationMs: number;
    reducedMotion: boolean;
}) {
    const timing = reducedMotion ? `steps(${HoldToCloseReducedSteps}, end)` : "linear";
    const releaseTransition = reducedMotion ? "none" : `opacity ${HoldToCloseReleaseMs}ms ease-out`;
    return (
        <span
            aria-hidden
            data-testid="hold-to-close-tint"
            className="molten-hold-close-tint pointer-events-none absolute inset-0 rounded-full"
            style={{
                opacity: holding ? HoldToCloseTintMax : 0,
                transition: holding ? `opacity ${durationMs}ms ${timing}` : releaseTransition,
            }}
        />
    );
}

export function HoldToCloseGlyph() {
    return (
        <svg
            aria-hidden
            viewBox={`0 0 ${DiscViewBox} ${DiscViewBox}`}
            data-testid="hold-to-close-glyph"
            className="molten-hold-close-glyph pointer-events-none relative h-full w-full"
        >
            <path d="M5 5L11 11M11 5L5 11" fill="none" stroke="currentColor" strokeWidth={RingStroke} />
        </svg>
    );
}

function HoldToCloseHintBubble({ anchor }: { anchor: HTMLElement }) {
    if (anchor == null || typeof document === "undefined") {
        return null;
    }
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left + rect.width / 2, 48), window.innerWidth - 48);
    return createPortal(
        <div
            aria-hidden
            data-testid="hold-to-close-hint"
            style={{ top: rect.bottom + 6, left }}
            className="molten-hold-close-hint pointer-events-none fixed z-[9600] -translate-x-1/2 rounded border border-border bg-modalbg px-2 py-1 text-[11px] font-medium whitespace-nowrap text-primary shadow-lg"
        >
            {HoldToCloseHint}
        </div>,
        document.body
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

const HoldKeys = new Set(["Enter", " "]);

export const HoldToCloseButton = forwardRef<HTMLButtonElement, HoldToCloseButtonProps>(
    ({ onClose, className, plainTitle, plainLabel, as: Component = "button", onMouseDown }, ref) => {
        const settings = useHoldToCloseSettings();
        const [holding, setHolding] = useState(false);
        const [hint, setHint] = useState(false);
        const [completing, setCompleting] = useState(false);
        const completingRef = useRef(false);
        const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
        const reducedMotionRef = useRef(settings.reducedMotion);
        reducedMotionRef.current = settings.reducedMotion;
        const buttonRef = useRef<HTMLButtonElement>(null);
        const ringRef = useRef<HTMLSpanElement>(null);
        const hintTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
        const onCloseRef = useRef(onClose);
        onCloseRef.current = onClose;
        const controllerRef = useRef<HoldToCloseController>(null);
        if (controllerRef.current == null) {
            controllerRef.current = makeHoldToCloseController(settings.durationMs, {
                onHoldChange: (value) => {
                    setHolding(value);
                    if (value) {
                        clearTimeout(hintTimerRef.current);
                        setHint(false);
                    }
                },
                onComplete: () => {
                    if (reducedMotionRef.current) {
                        onCloseRef.current(null);
                        return;
                    }
                    completingRef.current = true;
                    setCompleting(true);
                    flashTimerRef.current = setTimeout(() => onCloseRef.current(null), HoldToCloseFlashMs);
                },
                onHint: () => {
                    clearTimeout(hintTimerRef.current);
                    setHint(true);
                    announceHoldToCloseHint();
                    hintTimerRef.current = setTimeout(() => setHint(false), HoldToCloseHintMs);
                },
            });
        }
        const controller = controllerRef.current;
        controller.setDuration(settings.durationMs);

        useImperativeHandle(ref, () => buttonRef.current as HTMLButtonElement);

        useEffect(() => {
            return () => {
                controller.dispose();
                clearTimeout(hintTimerRef.current);
                clearTimeout(flashTimerRef.current);
            };
        }, [controller]);

        useEffect(() => {
            if (!settings.enabled) {
                controller.cancel();
            }
        }, [settings.enabled, controller]);

        const handleMouseDown = (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
            event.stopPropagation();
            onMouseDown?.(event);
        };

        if (!settings.enabled) {
            return (
                <Component
                    ref={buttonRef}
                    type="button"
                    className={cn("molten-hold-close", className)}
                    title={plainTitle}
                    aria-label={plainLabel}
                    data-testid="tab-close"
                    onMouseDown={handleMouseDown}
                    onClick={(event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
                        event.stopPropagation();
                        onClose(event);
                    }}
                >
                    <span className="molten-hold-close-disc relative inline-flex h-4 w-4 items-center justify-center rounded-full">
                        <HoldToCloseGlyph />
                    </span>
                </Component>
            );
        }

        return (
            <Component
                ref={buttonRef}
                type="button"
                className={cn("molten-hold-close", className)}
                title={HoldToCloseHint}
                aria-label={HoldToCloseLabel}
                data-testid="tab-close"
                data-holding={holding ? "" : undefined}
                data-completing={completing ? "" : undefined}
                data-reduced-motion={settings.reducedMotion ? "" : undefined}
                draggable={false}
                onDragStart={(event: React.DragEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                }}
                onMouseDown={handleMouseDown}
                onPointerDown={(event: React.PointerEvent<HTMLButtonElement>) => {
                    if (event.button !== 0) {
                        return;
                    }
                    event.stopPropagation();
                    if (completingRef.current) {
                        return;
                    }
                    controller.press();
                }}
                onPointerUp={() => controller.release()}
                onPointerLeave={() => controller.cancel()}
                onPointerCancel={() => controller.cancel()}
                onBlur={() => controller.cancel()}
                onKeyDown={(event: React.KeyboardEvent<HTMLButtonElement>) => {
                    if (!HoldKeys.has(event.key)) {
                        return;
                    }
                    // Without this the button's native activation would click on Enter's keydown or Space's keyup.
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.repeat || completingRef.current) {
                        return;
                    }
                    controller.press();
                }}
                onKeyUp={(event: React.KeyboardEvent<HTMLButtonElement>) => {
                    if (!HoldKeys.has(event.key)) {
                        return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    controller.release();
                }}
                onClick={(event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
                    event.stopPropagation();
                    event.preventDefault();
                    // A click with no pointer behind it comes from assistive technology, which cannot hold.
                    if (event.detail === 0) {
                        controller.callbacks.onHint();
                    }
                }}
            >
                <span
                    ref={ringRef}
                    className="molten-hold-close-disc relative inline-flex h-4 w-4 items-center justify-center rounded-full"
                >
                    <HoldToCloseTint
                        holding={holding}
                        durationMs={settings.durationMs}
                        reducedMotion={settings.reducedMotion}
                    />
                    <HoldToCloseRing
                        holding={holding}
                        durationMs={settings.durationMs}
                        reducedMotion={settings.reducedMotion}
                    />
                    <HoldToCloseGlyph />
                </span>
                {hint ? <HoldToCloseHintBubble anchor={ringRef.current} /> : null}
            </Component>
        );
    }
);

HoldToCloseButton.displayName = "HoldToCloseButton";
