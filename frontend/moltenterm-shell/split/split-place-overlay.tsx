// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The split placement mode on one panel (#677): four zones, triangles from the centre to each edge; the zone under the
// pointer, or the one picked with the arrows, shows the half the new panel would take with its label. A click or Enter
// splits, Escape or a click outside the panel cancels. The overlay covers the panel only and is announced to screen
// readers as a dialog.

import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import React, { useEffect, useRef } from "react";
import { useT } from "../i18n/i18n";
import type { SplitDirection } from "./split-model";
import { cancelSplitPlacement, confirmSplitPlacement, setSplitPlacementSide, splitPlacementAtom } from "./split-place";
import { placeLabelKey, previewInsets, sideForKey, SplitSides, zoneAt, zonePoints } from "./split-place-model";
import "./split-place-overlay.css";

export function SplitPlaceOverlay({ blockId }: { blockId: string }) {
    const placement = useAtomValue(splitPlacementAtom);
    const active = placement != null && placement.blockId === blockId;
    if (!active) {
        return null;
    }
    return <SplitPlaceOverlayInner side={placement.side} />;
}

function SplitPlaceOverlayInner({ side }: { side: SplitDirection }) {
    const t = useT();
    const reducedMotion = useAtomValue(atoms.prefersReducedMotionAtom);
    const rootRef = useRef<HTMLDivElement>(null);

    // Keys and outside clicks are taken on the window, in the capture phase: the panel's own view (a terminal) never
    // sees the arrows, Enter or Escape while the mode is on.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const picked = sideForKey(e.key);
            if (picked == null && e.key !== "Enter" && e.key !== "Escape") {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
                cancelSplitPlacement();
            } else if (e.key === "Enter") {
                confirmSplitPlacement();
            } else {
                setSplitPlacementSide(picked);
            }
        };
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current?.contains(e.target as Node)) {
                return;
            }
            cancelSplitPlacement();
        };
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("pointerdown", onPointerDown, true);
        return () => {
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("pointerdown", onPointerDown, true);
        };
    }, []);

    const sideAt = (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = rootRef.current.getBoundingClientRect();
        return zoneAt(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    };

    const label = side != null ? t(placeLabelKey(side)) : null;
    const insets = side != null ? previewInsets(side) : null;
    return (
        <div
            ref={rootRef}
            role="dialog"
            aria-modal="false"
            aria-label={t("split.place.title")}
            tabIndex={-1}
            className="molten-split-place cursor-pointer"
            data-reduced-motion={reducedMotion ? "" : undefined}
            data-side={side ?? undefined}
            onPointerMove={(e) => setSplitPlacementSide(sideAt(e))}
            onPointerDown={(e) => {
                e.stopPropagation();
                if (e.button !== 0) {
                    e.preventDefault();
                    cancelSplitPlacement();
                }
            }}
            onClick={(e) => {
                e.stopPropagation();
                confirmSplitPlacement(sideAt(e));
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
            }}
        >
            <svg className="molten-split-place-zones" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                {SplitSides.map((s) => (
                    <polygon
                        key={s}
                        points={zonePoints(s)}
                        data-side={s}
                        data-active={s === side ? "" : undefined}
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
            </svg>
            {insets != null ? (
                <div className="molten-split-place-preview" style={insets} aria-hidden>
                    <span className="molten-split-place-label">{label}</span>
                </div>
            ) : null}
            <div className="molten-split-place-hint" aria-hidden>
                {t("split.place.hint")}
            </div>
            <span className="sr-only" aria-live="polite">
                {label ?? t("split.place.announce")}
            </span>
        </div>
    );
}
