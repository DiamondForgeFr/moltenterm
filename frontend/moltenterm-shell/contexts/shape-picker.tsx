// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The ribbon shape picker (FR-SHELL-159, #2519): the fifteen end shapes drawn in the context's own colour, one radio
// group with a single tab stop moved with the arrow keys, and "Draw another", which draws another shape at random among
// the free ones.

import { cn } from "@/util/util";
import { useRef } from "react";
import { useT } from "../i18n/i18n";
import { gridMove } from "./emblem-model";
import { RibbonShapes } from "./ribbon-shapes";

export const ShapeColumns = 5;

export function ShapePicker({
    value,
    paint,
    onChange,
    onDrawAnother,
}: {
    value: string;
    // The colour the shapes are drawn in: the context's ribbon.
    paint: string;
    onChange: (shape: string) => void;
    onDrawAnother: () => void;
}) {
    const t = useT();
    const gridRef = useRef<HTMLDivElement>(null);

    const onKeyDown = (e: React.KeyboardEvent) => {
        const buttons = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-shape]") ?? []);
        const at = buttons.findIndex((b) => b === document.activeElement);
        const to = at < 0 ? null : gridMove(at, e.key, ShapeColumns, buttons.length);
        if (to == null) {
            return;
        }
        e.preventDefault();
        buttons[to].focus();
    };

    return (
        <div className="flex flex-col gap-2" data-testid="shape-picker">
            <div
                ref={gridRef}
                role="radiogroup"
                aria-label={t("contexts.shape.choose")}
                className="grid gap-1"
                style={{ gridTemplateColumns: `repeat(${ShapeColumns}, minmax(0, 1fr))` }}
                onKeyDown={onKeyDown}
            >
                {RibbonShapes.map((shape) => {
                    const name = t(shape.nameKey);
                    return (
                        <button
                            key={shape.id}
                            type="button"
                            role="radio"
                            aria-checked={shape.id === value}
                            aria-label={name}
                            title={name}
                            data-shape={shape.id}
                            tabIndex={shape.id === value ? 0 : -1}
                            className={cn(
                                "flex h-8 cursor-pointer items-center justify-center rounded-4 border border-transparent hover:bg-hover",
                                shape.id === value && "border-accent bg-hover"
                            )}
                            onClick={() => onChange(shape.id)}
                        >
                            <span
                                className="mt-shape-swatch"
                                style={
                                    {
                                        ["--ribbon-paint" as string]: paint,
                                        ["--ribbon-clip" as string]: shape.clip,
                                    } as React.CSSProperties
                                }
                            />
                        </button>
                    );
                })}
            </div>
            <button
                type="button"
                className="cursor-pointer self-start rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                data-testid="shape-draw-another"
                onClick={onDrawAnother}
            >
                {t("contexts.shape.drawAnother")}
            </button>
        </div>
    );
}
