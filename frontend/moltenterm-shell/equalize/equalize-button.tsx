// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tab bar's equalize button (#825), left of the 360 toggle: a click evens out the tab's panel columns once; a long
// press (the tab close's hold gesture and ring, DS-SHELL-059) turns the tab's auto mode on, and the button stays lit.
// While lit, a click or another long press turns it off.

import { atoms, WOS } from "@/app/store/global";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useRef, useState } from "react";
import {
    announceHoldHint,
    HoldRing,
    HoldTint,
    makeHoldToConfirmController,
    scheduleHoldCompletion,
    useHoldSettings,
    type HoldToConfirmController,
} from "../hold-to-confirm";
import { t, useT } from "../i18n/i18n";
import { formatShortcutById } from "../shortcuts/format";
import "../view360/view360.css";
import { EqualizeShortcutId } from "./equalize-actions";
import type { EqualizeModel } from "./equalize-model";
import "./equalize.css";

const HoldKeys = new Set(["Enter", " "]);

function EqualIcon() {
    return (
        <svg
            className="mt-eq-glyph pointer-events-none relative"
            width="12"
            height="10"
            viewBox="0 0 12 10"
            aria-hidden="true"
        >
            <rect
                x="0.6"
                y="0.6"
                width="10.8"
                height="8.8"
                rx="1.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
            />
            <path d="M4.2 1v8M7.8 1v8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

export function equalizeTitle(auto: boolean, enabled: boolean, shortcut: string): string {
    if (!enabled) {
        return t("equalize.button.disabled");
    }
    const head = shortcut ? `${t("equalize.button.title")} (${shortcut})` : t("equalize.button.title");
    if (auto) {
        return `${t("equalize.button.autoOn")}\n${t("equalize.button.turnOff")}`;
    }
    return `${head}\n${t("equalize.button.click")}\n${t("equalize.button.hold")}`;
}

// A short press equalizes (or turns the lit auto mode off); a completed hold flips the auto mode.
export function equalizePress(model: EqualizeModel): void {
    if (model.auto) {
        model.setAuto(false);
        announceHoldHint(t("equalize.autoOff"));
        return;
    }
    model.equalize();
}

export function equalizeHold(model: EqualizeModel): void {
    const on = !model.auto;
    model.setAuto(on);
    announceHoldHint(on ? t("equalize.autoOn") : t("equalize.autoOff"));
}

function EqualizeButtonInner({ model }: { model: EqualizeModel }) {
    const t = useT();
    const auto = useAtomValue(model.autoAtom);
    const enabled = useAtomValue(model.canEqualizeAtom);
    const settings = useHoldSettings();
    const [holding, setHolding] = useState(false);
    const [completing, setCompleting] = useState(false);
    const completingRef = useRef(false);
    const cancelCompletionRef = useRef<() => void>(null);
    const reducedMotionRef = useRef(settings.reducedMotion);
    reducedMotionRef.current = settings.reducedMotion;
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    const modelRef = useRef(model);
    modelRef.current = model;
    const controllerRef = useRef<HoldToConfirmController>(null);
    if (controllerRef.current == null) {
        controllerRef.current = makeHoldToConfirmController(settings.durationMs, {
            onHoldChange: setHolding,
            onComplete: () => {
                cancelCompletionRef.current = scheduleHoldCompletion(
                    reducedMotionRef.current,
                    () => equalizeHold(modelRef.current),
                    (value) => {
                        completingRef.current = value;
                        setCompleting(value);
                    }
                );
            },
            // A release before the ring completes is a click.
            onHint: () => equalizePress(modelRef.current),
        });
    }
    const controller = controllerRef.current;
    controller.setDuration(settings.durationMs);
    useEffect(() => {
        return () => {
            controller.dispose();
            cancelCompletionRef.current?.();
        };
    }, [controller]);

    // A lit button stays usable to turn auto off even when the tab has a single column left.
    const usable = enabled || auto;
    const press = () => {
        if (!enabledRef.current && !modelRef.current.auto) {
            return;
        }
        if (completingRef.current) {
            return;
        }
        controller.press();
    };

    return (
        <button
            type="button"
            className={cn("mt-v360-toggle mt-eq-button cursor-pointer", auto && "is-on", !usable && "is-disabled")}
            title={equalizeTitle(auto, usable, formatShortcutById(EqualizeShortcutId))}
            aria-label={t("equalize.button.label")}
            aria-pressed={auto}
            aria-disabled={!usable}
            data-testid="mt-equalize"
            data-auto={auto ? "" : undefined}
            data-holding={holding ? "" : undefined}
            data-completing={completing ? "" : undefined}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            draggable={false}
            // The button never takes the focus from the terminal.
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => {
                if (e.button !== 0) {
                    return;
                }
                press();
            }}
            onPointerUp={() => controller.release()}
            onPointerLeave={() => controller.cancel()}
            onPointerCancel={() => controller.cancel()}
            onBlur={() => controller.cancel()}
            onKeyDown={(e) => {
                if (!HoldKeys.has(e.key)) {
                    return;
                }
                e.preventDefault();
                if (e.repeat) {
                    return;
                }
                press();
            }}
            onKeyUp={(e) => {
                if (!HoldKeys.has(e.key)) {
                    return;
                }
                e.preventDefault();
                controller.release();
            }}
            onClick={(e) => {
                e.preventDefault();
                // A click with no pointer behind it comes from assistive technology, which cannot hold.
                if (e.detail === 0 && usable) {
                    equalizePress(model);
                }
            }}
        >
            <span className="mt-eq-disc relative inline-flex h-[18px] w-[18px] items-center justify-center rounded-full">
                <HoldTint holding={holding} durationMs={settings.durationMs} reducedMotion={settings.reducedMotion} />
                <HoldRing holding={holding} durationMs={settings.durationMs} reducedMotion={settings.reducedMotion} />
                <EqualIcon />
            </span>
        </button>
    );
}

function EqualizeForTab({ tabId }: { tabId: string }) {
    const tab = useAtomValue(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    const model = tab != null ? getLayoutModelForStaticTab()?.moltenEqualize : null;
    if (model == null) {
        return null;
    }
    return <EqualizeButtonInner model={model} />;
}

export const EqualizeButton = memo(() => {
    const staticTabId = useAtomValue(atoms.staticTabId);
    if (!staticTabId) {
        return null;
    }
    return <EqualizeForTab tabId={staticTabId} />;
});
EqualizeButton.displayName = "EqualizeButton";
