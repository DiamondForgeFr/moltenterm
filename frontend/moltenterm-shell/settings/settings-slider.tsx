// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { t } from "../i18n/i18n";
import { dismissToast, showToast } from "../toast-store";
import { SettingEntry } from "./settings-catalog";
import { SliderWrites } from "./slider-writes";

const Writers = new Map<string, SliderWrites>();
const EmptyState = { intent: null, failed: false, writing: false };
const NoSubscribe = () => () => {};
const EmptySnapshot = () => EmptyState;
const RangeKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

export function useSliderWrites(entry: SettingEntry, value: unknown, persist: (value: unknown) => Promise<void>) {
    const writer = useMemo(() => {
        if (entry.control !== "slider") {
            return null;
        }
        const key = `${entry.scope}:${entry.key}`;
        let current = Writers.get(key);
        if (current == null) {
            const toastId = `settings-slider:${key}`;
            current = new SliderWrites(
                persist,
                (retry) =>
                    showToast({
                        id: toastId,
                        kind: "error",
                        title: t("settings.error.sliderNotSaved"),
                        message: entry.key,
                        actions: [{ id: "retry", label: t("settings.retry"), run: retry }],
                    }),
                () => dismissToast(toastId)
            );
            Writers.set(key, current);
        }
        return current;
    }, [entry.scope, entry.key, entry.control]);
    const state = useSyncExternalStore(writer?.subscribe ?? NoSubscribe, writer?.snapshot ?? EmptySnapshot);
    useEffect(() => {
        writer?.observe(value);
    }, [writer, value]);
    useEffect(() => () => writer?.flush(), [writer]);
    return { writer, state };
}

// The slider writes at most every 60 ms while it moves, and always its last value.
export function SettingsSlider({
    entry,
    value,
    onSet,
    flush,
}: {
    entry: SettingEntry;
    value: unknown;
    onSet: (v: unknown) => void;
    flush: () => void;
}) {
    const shown = Number(value ?? entry.range?.min ?? 0);
    const range = entry.range ?? { min: 0, max: 1, step: 0.05 };
    return (
        <span className="inline-flex items-center gap-2">
            <input
                type="range"
                aria-label={entry.label}
                min={range.min}
                max={range.max}
                step={range.step}
                value={shown}
                onChange={(e) => onSet(Number(e.target.value))}
                onPointerUp={flush}
                onPointerCancel={flush}
                onBlur={flush}
                onKeyUp={(e) => RangeKeys.has(e.key) && flush()}
                className="h-4 w-28 cursor-pointer accent-[var(--mt-accent)]"
            />
            <span className="w-10 text-right text-12 tabular-nums text-secondary">
                {range.max <= 1 ? `${Math.round(shown * 100)} %` : shown}
            </span>
        </span>
    );
}
