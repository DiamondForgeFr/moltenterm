// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// DS-SHELL-059 (#354): the press-and-hold of FR-SHELL-025 as one piece, so every control that must not act on a stray
// click (a tab's close button; the rail pencil until #368) fills the same ring, shows the same hint and reads the same
// settings. The deliberate paths of each control (shortcuts, menus) never go through it.

import { SettingsKeyAtomFnType, useWaveEnv, WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { cn } from "@/util/util";
import { Atom, atom, useAtomValue } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./hold-to-confirm.css";

export const HoldMinMs = 200;
export const HoldMaxMs = 2000;
export const HoldDefaultMs = 600;
export const HoldHintMs = 1500;
export const HoldReducedSteps = 4;
export const HoldFlashMs = 120;
export const HoldReleaseMs = 160;
export const HoldTintMax = 0.25;
// Long enough for a closed tab to be gone, so its × never visibly leaves the flash; a control that stays (the rail
// pencil, a tab whose close was cancelled) is usable again after it.
export const HoldResetMs = 500;

// A 16 px disc: the ring is a 1.5 px stroke on its edge (radius 7.25).
export const HoldDiscViewBox = 16;
export const HoldRingStroke = 1.5;
const RingRadius = (HoldDiscViewBox - HoldRingStroke) / 2;
const RingLength = 2 * Math.PI * RingRadius;
const LiveRegionId = "molten-hold-to-close-live";

export type HoldToConfirmEnv = WaveEnvSubset<{
    atoms: {
        prefersReducedMotionAtom: WaveEnv["atoms"]["prefersReducedMotionAtom"];
    };
    getSettingsKeyAtom: SettingsKeyAtomFnType<"tab:holdtoclose" | "tab:holdtoclosems">;
}>;

export type HoldSettings = {
    enabled: boolean;
    durationMs: number;
    reducedMotion: boolean;
};

export type HoldCallbacks = {
    onHoldChange: (holding: boolean) => void;
    onComplete: () => void;
    onHint: () => void;
};

export function clampHoldMs(value: number): number {
    if (value == null || !Number.isFinite(value)) {
        return HoldDefaultMs;
    }
    return Math.min(HoldMaxMs, Math.max(HoldMinMs, Math.round(value)));
}

export function resolveHoldSettings(enabled: boolean, durationMs: number, reducedMotion: boolean): HoldSettings {
    return { enabled: enabled !== false, durationMs: clampHoldMs(durationMs), reducedMotion: !!reducedMotion };
}

// Completion comes from a timer, never from transitionend: reduced motion or a hidden window can skip the transition.
export class HoldToConfirmController {
    durationMs: number;
    holding = false;
    timer: ReturnType<typeof setTimeout> = null;
    callbacks: HoldCallbacks;

    constructor(durationMs: number, callbacks: HoldCallbacks) {
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

    // A release before the ring completes is a click (or a hold too short): it explains the gesture instead of acting.
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

export function makeHoldToConfirmController(durationMs: number, callbacks: HoldCallbacks): HoldToConfirmController {
    return new HoldToConfirmController(durationMs, callbacks);
}

// What follows a completed hold: under reduced motion the action runs at once; otherwise the surface flashes, the action
// runs after the flash, and the control returns to idle if it is still there. Returns a cancel for unmounting.
export function scheduleHoldCompletion(
    reducedMotion: boolean,
    confirm: () => void,
    setCompleting: (completing: boolean) => void
): () => void {
    if (reducedMotion) {
        confirm();
        return () => {};
    }
    let resetTimer: ReturnType<typeof setTimeout> = null;
    setCompleting(true);
    const flashTimer = setTimeout(() => {
        confirm();
        resetTimer = setTimeout(() => setCompleting(false), HoldResetMs);
    }, HoldFlashMs);
    return () => {
        clearTimeout(flashTimer);
        clearTimeout(resetTimer);
    };
}

// One polite live region for the whole window; the text is cleared first so the same hint is announced again.
export function announceHoldHint(text: string) {
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
const FallbackDurationAtom = atom(HoldDefaultMs) as Atom<number>;
const FallbackReducedMotionAtom = atom(false) as Atom<boolean>;

// One gesture, one setting: the keys keep the names they got with the tab close button (#255).
export function useHoldSettings(): HoldSettings {
    const env = useWaveEnv<HoldToConfirmEnv>();
    const enabled = useAtomValue(env?.getSettingsKeyAtom?.("tab:holdtoclose") ?? FallbackEnabledAtom);
    const durationMs = useAtomValue(env?.getSettingsKeyAtom?.("tab:holdtoclosems") ?? FallbackDurationAtom);
    const reducedMotion = useAtomValue(env?.atoms?.prefersReducedMotionAtom ?? FallbackReducedMotionAtom);
    return resolveHoldSettings(enabled, durationMs, reducedMotion);
}

export function HoldRing({
    holding,
    durationMs,
    reducedMotion,
}: {
    holding: boolean;
    durationMs: number;
    reducedMotion: boolean;
}) {
    const timing = reducedMotion ? `steps(${HoldReducedSteps}, end)` : "var(--mt-ease)";
    const releaseTransition = reducedMotion ? "none" : `stroke-dashoffset ${HoldReleaseMs}ms var(--mt-ease)`;
    return (
        <svg
            aria-hidden
            viewBox={`0 0 ${HoldDiscViewBox} ${HoldDiscViewBox}`}
            data-testid="hold-ring"
            className={cn(
                "molten-hold-ring pointer-events-none absolute inset-0 h-full w-full -rotate-90",
                holding ? "opacity-100" : "opacity-0"
            )}
        >
            <circle
                cx={HoldDiscViewBox / 2}
                cy={HoldDiscViewBox / 2}
                r={RingRadius}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.15}
                strokeWidth={HoldRingStroke}
            />
            <circle
                cx={HoldDiscViewBox / 2}
                cy={HoldDiscViewBox / 2}
                r={RingRadius}
                fill="none"
                className="molten-hold-fill"
                stroke="var(--color-accent)"
                strokeWidth={HoldRingStroke}
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

export function HoldTint({
    holding,
    durationMs,
    reducedMotion,
}: {
    holding: boolean;
    durationMs: number;
    reducedMotion: boolean;
}) {
    const timing = reducedMotion ? `steps(${HoldReducedSteps}, end)` : "linear";
    const releaseTransition = reducedMotion ? "none" : `opacity ${HoldReleaseMs}ms var(--mt-ease)`;
    return (
        <span
            aria-hidden
            data-testid="hold-tint"
            className="molten-hold-tint pointer-events-none absolute inset-0 rounded-full"
            style={{
                opacity: holding ? HoldTintMax : 0,
                transition: holding ? `opacity ${durationMs}ms ${timing}` : releaseTransition,
            }}
        />
    );
}

function HoldHintBubble({ anchor, text }: { anchor: HTMLElement; text: string }) {
    if (anchor == null || typeof document === "undefined") {
        return null;
    }
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left + rect.width / 2, 48), window.innerWidth - 48);
    return createPortal(
        <div
            aria-hidden
            data-testid="hold-hint"
            style={{ top: rect.bottom + 6, left }}
            className="molten-hold-hint pointer-events-none fixed z-[9600] -translate-x-1/2 rounded-10 border border-border bg-surface-3 px-2 py-1 text-11 font-medium whitespace-nowrap text-primary shadow-e2"
        >
            {text}
        </div>,
        document.body
    );
}

export type HoldToConfirmButtonProps = {
    // Called once the hold completes, or on a single click when the setting turns the hold off.
    onConfirm: (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null, button: HTMLButtonElement) => void;
    // The accessible name while the hold applies, e.g. "Close tab, hold to confirm".
    label: string;
    // Shown by the control and announced after a click, e.g. "Hold to close".
    hint: string;
    // Drawn over the tint and the ring; give it the molten-hold-glyph class and a position (relative).
    glyph: React.ReactNode;
    title?: string;
    className?: string;
    discClassName?: string;
    plainTitle?: string;
    plainLabel?: string;
    testId?: string;
    dataRole?: string;
    as?: React.ElementType;
    onMouseDown?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
    onMouseEnter?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
    onMouseLeave?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
};

const HoldKeys = new Set(["Enter", " "]);

export const HoldToConfirmButton = forwardRef<HTMLButtonElement, HoldToConfirmButtonProps>(
    (
        {
            onConfirm,
            label,
            hint: hintText,
            glyph,
            title,
            className,
            discClassName,
            plainTitle,
            plainLabel,
            testId,
            dataRole,
            as: Component = "button",
            onMouseDown,
            onMouseEnter,
            onMouseLeave,
        },
        ref
    ) => {
        const settings = useHoldSettings();
        const [holding, setHolding] = useState(false);
        const [hint, setHint] = useState(false);
        const [completing, setCompleting] = useState(false);
        const completingRef = useRef(false);
        const cancelCompletionRef = useRef<() => void>(null);
        const reducedMotionRef = useRef(settings.reducedMotion);
        reducedMotionRef.current = settings.reducedMotion;
        const buttonRef = useRef<HTMLButtonElement>(null);
        const discRef = useRef<HTMLSpanElement>(null);
        const hintTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
        const onConfirmRef = useRef(onConfirm);
        onConfirmRef.current = onConfirm;
        const hintTextRef = useRef(hintText);
        hintTextRef.current = hintText;
        const controllerRef = useRef<HoldToConfirmController>(null);
        if (controllerRef.current == null) {
            const confirm = () => onConfirmRef.current(null, buttonRef.current);
            controllerRef.current = makeHoldToConfirmController(settings.durationMs, {
                onHoldChange: (value) => {
                    setHolding(value);
                    if (value) {
                        clearTimeout(hintTimerRef.current);
                        setHint(false);
                    }
                },
                onComplete: () => {
                    cancelCompletionRef.current = scheduleHoldCompletion(reducedMotionRef.current, confirm, (value) => {
                        completingRef.current = value;
                        setCompleting(value);
                    });
                },
                onHint: () => {
                    clearTimeout(hintTimerRef.current);
                    setHint(true);
                    announceHoldHint(hintTextRef.current);
                    hintTimerRef.current = setTimeout(() => setHint(false), HoldHintMs);
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
                cancelCompletionRef.current?.();
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
        const discClass = cn(
            "molten-hold-disc relative inline-flex h-4 w-4 items-center justify-center rounded-full",
            discClassName
        );

        if (!settings.enabled) {
            return (
                <Component
                    ref={buttonRef}
                    type="button"
                    className={cn("molten-hold", className)}
                    title={plainTitle}
                    aria-label={plainLabel}
                    data-testid={testId}
                    data-role={dataRole}
                    onMouseDown={handleMouseDown}
                    onMouseEnter={onMouseEnter}
                    onMouseLeave={onMouseLeave}
                    onClick={(event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
                        event.stopPropagation();
                        onConfirm(event, buttonRef.current);
                    }}
                >
                    <span className={discClass}>{glyph}</span>
                </Component>
            );
        }

        return (
            <Component
                ref={buttonRef}
                type="button"
                className={cn("molten-hold", className)}
                title={title}
                aria-label={label}
                data-testid={testId}
                data-role={dataRole}
                data-holding={holding ? "" : undefined}
                data-completing={completing ? "" : undefined}
                data-reduced-motion={settings.reducedMotion ? "" : undefined}
                draggable={false}
                onDragStart={(event: React.DragEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                }}
                onMouseDown={handleMouseDown}
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
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
                <span ref={discRef} className={discClass}>
                    <HoldTint
                        holding={holding}
                        durationMs={settings.durationMs}
                        reducedMotion={settings.reducedMotion}
                    />
                    <HoldRing
                        holding={holding}
                        durationMs={settings.durationMs}
                        reducedMotion={settings.reducedMotion}
                    />
                    {glyph}
                </span>
                {hint ? <HoldHintBubble anchor={discRef.current} text={hintText} /> : null}
            </Component>
        );
    }
);

HoldToConfirmButton.displayName = "HoldToConfirmButton";
