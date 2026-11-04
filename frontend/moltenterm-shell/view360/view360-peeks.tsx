// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The carpet's edge peeks (FR-SHELL-065 AC11-AC12, DS-SHELL-152): in each gutter beside the band of places, a sliver
// of the neighbouring panel, tilted like a carousel card. It is the panel's still capture (carpet-captures.ts) or its
// placeholder, never a live view. A peek is keyed by its panel, so a new neighbour mounts and swings in (a CSS
// animation of transform and opacity); it renders when the set of columns in view changes, never per scroll frame.
// At an end of the carpet, where no peek exists, the same gutter holds an add-panel slot (view360-endslot.tsx, #1836).
// This file also runs the captures of the carpet's panels while it rests.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { useAtomValue } from "jotai";
import { CSSProperties, memo, useEffect, useMemo } from "react";
import { useT } from "../i18n/i18n";
import { offerPanelCapture } from "../library/materials-panel-capture";
import {
    CaptureRect,
    CaptureThumbPx,
    carpetCaptureAtom,
    CarpetCaptureScheduler,
    dropCarpetCaptures,
    readCarpetCapture,
    registerCarpetScheduler,
    writeCarpetCapture,
} from "./carpet-captures";
import { CarpetLayout } from "./carpet-model";
import {
    CaptureColumn,
    captureProbePoints,
    captureTargets,
    endSlotSides,
    endSlotsShown,
    overlapsCapture,
    peekNeighbours,
    peekRect,
    PeekSide,
} from "./carpet-peeks";
import { readLivePanel, watchLivePanel } from "./carpet-thumb-live";
import { CarpetThumbTracker } from "./carpet-thumb-state";
import { ElectronThumbBackend } from "./carpet-thumbs";
import type { RadarTick } from "./radar-model";
import { CarpetEndSlot } from "./view360-endslot";
import "./view360-peeks.css";

function halfGapPx(layoutModel: LayoutModel): number {
    const gapAtom = layoutModel.gapSizePx;
    const gap = gapAtom == null ? 0 : (globalStore.get(gapAtom) ?? 0);
    return gap / 2;
}

// The tab strip's cards (a panel's preview, the visible area's hint) float over the columns: one over any part of a
// column would be captured in its thumbnail, a card in a card (#1814).
function coveredByCard(rect: CaptureRect): boolean {
    return [...document.querySelectorAll(".mt-radar-card")].some((el) =>
        overlapsCapture(el.getBoundingClientRect(), rect)
    );
}

// Whatever covers one of a column's probe points (a menu, a popover, a panel being dragged) would be captured as the
// panel: the column is captured only when every point lands in its own panels.
function uncovered(rect: CaptureRect, leafNodeIds: string[]): boolean {
    if (coveredByCard(rect)) {
        return false;
    }
    const ids = new Set(leafNodeIds);
    return captureProbePoints(rect).every((p) => {
        const node = document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>(".tile-node");
        return node != null && ids.has(node.id);
    });
}

// Captures the carpet's columns while it rests (DS-SHELL-152). Woken by a scroll frame, a layout pass, a focus change or
// a change of a page's state, each of which only restarts one timer; at rest nothing runs. The thumbnails are kept on
// disk (#1814): the tracker fills the columns from the store when they come to the carpet and empties one whose page
// moved on, and every capture taken is stored.
export function useCarpetCaptures(layoutModel: LayoutModel, columns: CaptureColumn[]) {
    const view360 = layoutModel.moltenView360;
    const columnKey = columns
        .map((c) => `${c.columnId}:${c.leafNodeIds.join("+")}:${(c.blockIds ?? []).join("+")}`)
        .join(",");
    useEffect(() => {
        dropCarpetCaptures(columns.map((c) => c.columnId));
    }, [columnKey]);
    useEffect(() => {
        const api = getApi();
        if (api?.captureScreenshot == null) {
            return;
        }
        const leaves = new Map(columns.map((c) => [c.columnId, c.leafNodeIds]));
        const root = () => layoutModel.displayContainerRef.current?.parentElement;
        let scheduler: CarpetCaptureScheduler = null;
        const tracker = new CarpetThumbTracker(columns, {
            readPanel: readLivePanel,
            watchPanel: watchLivePanel,
            readCapture: readCarpetCapture,
            writeCapture: writeCarpetCapture,
            backend: ElectronThumbBackend,
            wake: () => scheduler?.noteChange(),
        });
        scheduler = new CarpetCaptureScheduler(
            {
                atRest: () =>
                    document.visibilityState === "visible" &&
                    view360.layout != null &&
                    view360.smoothFrame == null &&
                    root()?.dataset.mtCarpetScrolling == null &&
                    view360.dragColumn == null &&
                    view360.dragFixedPx == null &&
                    view360.dragPin == null &&
                    !globalStore.get(layoutModel.activeDrag) &&
                    globalStore.get(layoutModel.magnifiedNodeIdAtom) == null,
                targets: () => {
                    tracker.attach();
                    const container = layoutModel.displayContainerRef.current;
                    if (container == null) {
                        return [];
                    }
                    const origin = container.getBoundingClientRect();
                    return captureTargets(
                        view360.layout,
                        view360.scrollLeft,
                        { x: origin.left, y: origin.top },
                        halfGapPx(layoutModel)
                    ).filter((t) => leaves.has(t.columnId) && uncovered(t.rect, leaves.get(t.columnId)));
                },
                capture: (rect, target) =>
                    api.captureScreenshot(rect, {
                        width: CaptureThumbPx,
                        flatSkipTop: tracker.flatSkipTop(target.columnId),
                    }),
                inspect: (columnId) => tracker.inspect(columnId),
            },
            undefined,
            undefined,
            (columnId, capture) => {
                writeCarpetCapture(columnId, capture);
                const key = tracker.keyOf(columnId);
                if (key != null && capture.tag != null) {
                    ElectronThumbBackend.put({
                        key,
                        tag: capture.tag,
                        url: capture.url,
                        width: capture.width,
                        height: capture.height,
                        at: capture.at,
                    });
                }
                // The same capture is the card visual of the materials the panel shows (#1560).
                const nodeIds = leaves.get(columnId) ?? [];
                const blockIds = nodeIds.map(
                    (id) => globalStore.get(layoutModel.leafs).find((l) => l.id === id)?.data?.blockId
                );
                offerPanelCapture(
                    blockIds.filter((b) => b != null),
                    capture.url
                );
            }
        );
        const wake = () => scheduler.noteChange();
        const unregister = registerCarpetScheduler(scheduler);
        const unsubs = [
            globalStore.sub(view360.scrollLeftAtom, wake),
            globalStore.sub(view360.layoutAtom, wake),
            globalStore.sub(layoutModel.focusedNode, wake),
            globalStore.sub(layoutModel.magnifiedNodeIdAtom, wake),
        ];
        document.addEventListener("visibilitychange", wake);
        tracker.attach();
        void tracker.sync();
        // A page's view model registers while its block renders, which may come after this pass.
        const frame = requestAnimationFrame(() => tracker.attach());
        wake();
        return () => {
            cancelAnimationFrame(frame);
            unregister();
            scheduler.dispose();
            tracker.dispose();
            unsubs.forEach((u) => u());
            document.removeEventListener("visibilitychange", wake);
        };
    }, [layoutModel, view360, columnKey]);
}

type PeekProps = {
    side: PeekSide;
    tick: RadarTick;
    layout: CarpetLayout;
    halfGap: number;
    onGo: (tick: RadarTick) => void;
};

const CarpetPeek = memo(({ side, tick, layout, halfGap, onGo }: PeekProps) => {
    const t = useT();
    const capture = useAtomValue(carpetCaptureAtom(tick.columnId));
    const rect = peekRect(layout, side, halfGap);
    const style = {
        transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
        width: rect.width,
        height: rect.height,
        "--mt-radar-color": tick.color,
    } as CSSProperties;
    const cardStyle: CSSProperties = capture ? { backgroundImage: `url("${capture.url}")` } : undefined;
    const label = t("view360.peek.show", { title: tick.title });
    return (
        <button
            type="button"
            tabIndex={-1}
            className="mt-peek cursor-pointer"
            style={style}
            data-side={side}
            data-column={tick.columnId}
            data-capture={capture ? "" : undefined}
            data-testid="mt-carpet-peek"
            aria-label={label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onGo(tick)}
        >
            <span className="mt-peek-card" style={cardStyle} aria-hidden="true">
                {capture == null && <i className={`mt-peek-glyph fa fa-solid fa-${tick.icon}`} />}
            </span>
            <span className="mt-peek-label" aria-hidden="true">
                {tick.title}
            </span>
        </button>
    );
});
CarpetPeek.displayName = "CarpetPeek";

export const CarpetPeeks = memo(
    ({
        layoutModel,
        layout,
        ticks,
        onGo,
    }: {
        layoutModel: LayoutModel;
        layout: CarpetLayout;
        ticks: RadarTick[];
        onGo: (tick: RadarTick) => void;
    }) => {
        const { left, right } = useMemo(() => peekNeighbours(ticks), [ticks]);
        const slotSides = useMemo(() => endSlotSides(ticks), [ticks]);
        const magnified = useAtomValue(layoutModel.magnifiedNodeIdAtom);
        const dragging = useAtomValue(layoutModel.activeDrag);
        const halfGap = halfGapPx(layoutModel);
        return (
            <>
                {endSlotsShown(magnified, dragging) &&
                    slotSides.map((side) => (
                        <CarpetEndSlot
                            key={`s:${side}`}
                            layoutModel={layoutModel}
                            layout={layout}
                            side={side}
                            halfGap={halfGap}
                        />
                    ))}
                {left != null && (
                    <CarpetPeek
                        key={`l:${left.columnId}`}
                        side="left"
                        tick={left}
                        layout={layout}
                        halfGap={halfGap}
                        onGo={onGo}
                    />
                )}
                {right != null && (
                    <CarpetPeek
                        key={`r:${right.columnId}`}
                        side="right"
                        tick={right}
                        layout={layout}
                        halfGap={halfGap}
                        onGo={onGo}
                    />
                )}
            </>
        );
    }
);
CarpetPeeks.displayName = "CarpetPeeks";
