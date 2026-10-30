// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The carpet's surface and chrome in 360 view (FR-SHELL-065, DS-SHELL-115), drawn by the tile layout around its
// panels: the surface under them, then the edge fades, the fixed zone's grip and the radar scrubber (#617) above them.

import { globalStore } from "@/app/store/jotaiStore";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { CSSProperties, memo, useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { CarpetMarginPx, Rect } from "./carpet-model";
import { canScrollX, horizontalWheelDelta, routeHorizontalWheel, wheelDeltaPx } from "./carpet-wheel";
import { CarpetSensors } from "./view360-offcarpet";
import { View360Radar } from "./view360-radar";
import "./view360.css";

function rectStyle(rect: Rect): CSSProperties {
    return {
        transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
        width: rect.width,
        height: rect.height,
    };
}

export const View360Underlay = memo(({ layoutModel }: { layoutModel: LayoutModel }) => {
    const t = useT();
    const layout = useAtomValue(layoutModel.moltenView360.layoutAtom);
    // The automatic switch's glow on the carpet edge (DS-SHELL-117), only for a switch made while it is drawn.
    const signal = useAtomValue(layoutModel.moltenView360.signalAtom);
    const [mountSignal] = useState(signal);
    if (layout == null) {
        return null;
    }
    return (
        <div className="mt-carpet-surface" style={rectStyle(layout.surface)} data-testid="mt-carpet">
            {signal !== mountSignal && <span key={signal} className="mt-carpet-glow" aria-hidden="true" />}
            {layout.columns.length === 0 && <span className="mt-carpet-empty">{t("view360.empty")}</span>}
            <CarpetSensors layoutModel={layoutModel} layout={layout} />
        </div>
    );
});
View360Underlay.displayName = "View360Underlay";

export const View360Overlay = memo(({ layoutModel }: { layoutModel: LayoutModel }) => {
    const view360 = layoutModel.moltenView360;
    const layout = useAtomValue(view360.layoutAtom);
    const active = layout != null;

    // Trackpad horizontal scroll and Shift + wheel over the carpet scroll it, unless the focused panel under the pointer
    // can still scroll that way (#676); vertical scroll stays with the panels. Browser panels route their own wheel
    // (carpet-wheel-webview.ts): it never reaches this DOM.
    useEffect(() => {
        if (!active) {
            return;
        }
        const root = layoutModel.displayContainerRef.current?.parentElement;
        if (root == null) {
            return;
        }
        const onWheel = (e: WheelEvent) => {
            const current = view360.layout;
            if (current == null || current.maxScroll <= 0) {
                return;
            }
            const delta = horizontalWheelDelta(e);
            if (delta == null) {
                return;
            }
            const bounds = root.getBoundingClientRect();
            const x = e.clientX - bounds.left;
            if (x < current.surface.left || x > current.surface.left + current.surface.width) {
                return;
            }
            const block = e.target instanceof Element ? e.target.closest<HTMLElement>(".block[data-blockid]") : null;
            const focusedId = globalStore.get(layoutModel.focusedNode)?.data?.blockId;
            const focused = block != null && block.dataset.blockid === focusedId;
            if (routeHorizontalWheel(focused, focused && canScrollX(e.target, delta, block)) === "panel") {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            view360.scrollBy(wheelDeltaPx(delta, e.deltaMode, current.viewport.width), e.timeStamp);
        };
        // Panels laid past the carpet's right edge overflow the layout: a focus moving into one of them would let the
        // browser scroll the layout itself, shifting the fixed zone off the window. Only the carpet scrolls.
        const onScroll = () => {
            if (root.scrollLeft !== 0) {
                root.scrollLeft = 0;
            }
        };
        onScroll();
        root.addEventListener("wheel", onWheel, { capture: true, passive: false });
        root.addEventListener("scroll", onScroll);
        return () => {
            root.removeEventListener("wheel", onWheel, { capture: true });
            root.removeEventListener("scroll", onScroll);
        };
    }, [active, layoutModel, view360]);

    if (layout == null) {
        return null;
    }
    const surface = layout.surface;
    const fadeTop = layout.viewport.top;
    const fadeHeight = layout.viewport.height;
    const gripStuck = view360.gripNoRoom() != null;
    return (
        <div className="mt-carpet-chrome">
            {layout.fixedNodeId != null && (
                <div
                    className={cn("mt-fixed-grip", gripStuck && "mt-fixed-grip-stuck")}
                    style={{
                        transform: `translate3d(${layout.fixed.width + CarpetMarginPx / 2 - 2}px, ${layout.fixed.height / 2 - 18}px, 0)`,
                    }}
                />
            )}
            <div
                className="mt-carpet-fade mt-carpet-fade-left"
                style={rectStyle({ top: fadeTop, left: surface.left, width: 28, height: fadeHeight })}
            />
            <div
                className="mt-carpet-fade mt-carpet-fade-right"
                style={rectStyle({
                    top: fadeTop,
                    left: surface.left + surface.width - 28,
                    width: 28,
                    height: fadeHeight,
                })}
            />
            <View360Radar layoutModel={layoutModel} layout={layout} />
        </div>
    );
});
View360Overlay.displayName = "View360Overlay";
