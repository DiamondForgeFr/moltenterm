// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The radar scrubber at the bottom of the carpet (FR-SHELL-068, DS-SHELL-119), Codex's message minimap laid
// horizontally: one tick per carpet panel in its kind's colour, the ticks in view framed by a window (#678: a
// low-radius rectangle, the rest of the radar dimmed, an eye on hover), the title on hover, a click goes to the
// panel, dragging the window scrubs the carpet, and a panel that needs attention pulses even
// off-screen. It renders when the columns, the set in view or a panel's facts change, never per scroll frame.

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { CSSProperties, memo, useMemo, useRef, useState } from "react";
import { useLocale } from "../i18n/i18n";
import { suiteIcon } from "../suite/suite-icons";
import { CarpetLayout, CarpetScrubberPx } from "./carpet-model";
import {
    buildRadarTicks,
    radarHint,
    radarPitchPx,
    RadarText,
    RadarTick,
    radarToContentX,
    radarWindowLine,
} from "./radar-model";
import { makeRadarFactsAtom, radarColumns } from "./radar-store";
import "./radar.css";

const DragThresholdPx = 3;
const EdgePadPx = 8;
const CardWidthPx = 220;
const EyeIcon = suiteIcon("visibleArea");

type Drag = {
    pointerId: number;
    startX: number;
    startScroll: number;
    tickCenters: number[];
    columnCenters: number[];
    slope: number;
    moved: boolean;
};

type Hover = { columnId: string; x: number };

function TickButton({
    tick,
    pitch,
    onGo,
    onHover,
}: {
    tick: RadarTick;
    pitch: number;
    onGo: (tick: RadarTick) => void;
    onHover: (tick: RadarTick, el: HTMLElement) => void;
}) {
    const style = { width: pitch, "--mt-radar-color": tick.color } as CSSProperties;
    return (
        <button
            type="button"
            className="mt-radar-hit cursor-pointer"
            style={style}
            data-column={tick.columnId}
            data-kind={tick.kind}
            data-visible={tick.visible ? "" : undefined}
            data-attention={tick.attention ?? undefined}
            aria-label={`${tick.title}, ${radarHint(tick)}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onGo(tick)}
            onPointerEnter={(e) => onHover(tick, e.currentTarget)}
            onFocus={(e) => onHover(tick, e.currentTarget)}
        >
            <span className="mt-radar-tick" />
        </button>
    );
}

export const View360Radar = memo(({ layoutModel, layout }: { layoutModel: LayoutModel; layout: CarpetLayout }) => {
    const view360 = layoutModel.moltenView360;
    const locale = useLocale();
    const visibleIds = useAtomValue(view360.visibleColumnIdsAtom);
    const rootNode = layoutModel.treeState?.rootNode;
    const columns = useMemo(() => radarColumns(rootNode, layout), [rootNode, layout]);
    const blockKey = columns.flatMap((c) => c.leaves.map((l) => l.blockId)).join(",");
    const factsAtom = useMemo(() => makeRadarFactsAtom(blockKey ? blockKey.split(",") : []), [blockKey]);
    const facts = useAtomValue(factsAtom);
    // The locale is a dependency: tick titles carry translated text ("Panel", "+2 panels").
    const ticks = useMemo(() => buildRadarTicks(columns, facts, visibleIds), [columns, facts, visibleIds, locale]);
    const [hover, setHover] = useState<Hover>(null);
    const [dragging, setDragging] = useState(false);
    // The window's centre in the row while the pointer is over it, null otherwise.
    const [windowX, setWindowX] = useState<number>(null);
    const rowRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<Drag>(null);
    const suppressClickRef = useRef(false);

    if (ticks.length === 0) {
        return null;
    }
    const surface = layout.surface;
    const pitch = radarPitchPx(ticks.length, surface.width - 4 * EdgePadPx);
    const rowStyle: CSSProperties = {
        transform: `translate3d(${surface.left}px, ${surface.top + surface.height - CarpetScrubberPx}px, 0)`,
        width: surface.width,
        height: CarpetScrubberPx,
    };

    const goTo = (tick: RadarTick) => {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        view360.scrollToColumn(tick.columnId);
        layoutModel.focusNode(tick.focusNodeId);
    };
    const onHover = (tick: RadarTick, el: HTMLElement) => {
        const row = rowRef.current?.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        if (row == null) {
            return;
        }
        setHover({ columnId: tick.columnId, x: rect.left + rect.width / 2 - row.left });
    };

    const onWindowPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) {
            return;
        }
        const row = rowRef.current;
        if (row == null) {
            return;
        }
        const tickCenters = Array.from(row.querySelectorAll<HTMLElement>(".mt-radar-hit")).map((el) => {
            const r = el.getBoundingClientRect();
            return r.left + r.width / 2;
        });
        const columnCenters = layout.columns.map((c) => c.x + c.width / 2);
        const avgWidth = layout.contentWidth / Math.max(1, layout.columns.length);
        dragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startScroll: view360.scrollLeft,
            tickCenters,
            columnCenters,
            slope: avgWidth / pitch,
            moved: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onWindowPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag == null || drag.pointerId !== e.pointerId) {
            return;
        }
        if (!drag.moved && Math.abs(e.clientX - drag.startX) < DragThresholdPx) {
            return;
        }
        if (!drag.moved) {
            drag.moved = true;
            setDragging(true);
            setHover(null);
        }
        const from = radarToContentX(drag.startX, drag.tickCenters, drag.columnCenters, drag.slope);
        const to = radarToContentX(e.clientX, drag.tickCenters, drag.columnCenters, drag.slope);
        view360.scrollTo(drag.startScroll + to - from);
    };
    const onWindowPointerUp = () => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag?.moved) {
            // The release over a tick would also click it.
            suppressClickRef.current = true;
            setTimeout(() => (suppressClickRef.current = false), 0);
            setDragging(false);
        }
    };

    const first = ticks.findIndex((t) => t.visible);
    const last = first === -1 ? -1 : ticks.length - 1 - [...ticks].reverse().findIndex((t) => t.visible);
    const renderTick = (tick: RadarTick) => (
        <TickButton key={tick.columnId} tick={tick} pitch={pitch} onGo={goTo} onHover={onHover} />
    );
    const hoveredTick = hover == null ? null : ticks.find((t) => t.columnId === hover.columnId);
    // On the window's edge, the last tick left behind outside it no longer speaks: the card is the window's.
    const windowCard = windowX != null && (hoveredTick == null || !hoveredTick.visible);
    const hovered = windowCard ? null : hoveredTick;
    const cardX = windowCard ? windowX : (hover?.x ?? 0);
    const cardLeft = Math.min(Math.max(cardX - CardWidthPx / 2, 4), surface.width - CardWidthPx - 4);
    const onWindowEnter = (e: React.PointerEvent<HTMLDivElement>) => {
        const row = rowRef.current?.getBoundingClientRect();
        const rect = e.currentTarget.getBoundingClientRect();
        if (row == null) {
            return;
        }
        setWindowX(rect.left + rect.width / 2 - row.left);
    };

    return (
        <div
            ref={rowRef}
            className="mt-radar"
            style={rowStyle}
            role="toolbar"
            aria-label={RadarText.label}
            data-testid="mt-carpet-radar"
        >
            <div className="mt-radar-ticks" onPointerLeave={() => setHover(null)}>
                {first === -1 ? (
                    ticks.map(renderTick)
                ) : (
                    <>
                        {ticks.slice(0, first).map(renderTick)}
                        <div
                            className={cn("mt-radar-window", dragging && "dragging")}
                            role="group"
                            aria-label={RadarText.window}
                            data-testid="mt-carpet-radar-window"
                            onPointerEnter={onWindowEnter}
                            onPointerLeave={() => setWindowX(null)}
                            onPointerDown={onWindowPointerDown}
                            onPointerMove={onWindowPointerMove}
                            onPointerUp={onWindowPointerUp}
                            onLostPointerCapture={onWindowPointerUp}
                        >
                            {ticks.slice(first, last + 1).map(renderTick)}
                            <span className="mt-radar-eye" aria-hidden>
                                <EyeIcon strokeWidth={2} aria-hidden />
                            </span>
                        </div>
                        {ticks.slice(last + 1).map(renderTick)}
                    </>
                )}
            </div>
            {hovered != null && !dragging && (
                <div
                    className="mt-radar-card"
                    style={{ left: cardLeft, width: CardWidthPx }}
                    data-attention={hovered.attention ?? undefined}
                    role="tooltip"
                >
                    <b>{hovered.title}</b>
                    <i>{radarHint(hovered)}</i>
                    {hovered.visible && windowX != null && (
                        <span className="mt-radar-card-window">
                            <EyeIcon strokeWidth={2} aria-hidden />
                            {radarWindowLine()}
                        </span>
                    )}
                </div>
            )}
            {windowCard && !dragging && (
                <div
                    className="mt-radar-card"
                    style={{ left: cardLeft, width: CardWidthPx }}
                    data-window=""
                    role="tooltip"
                >
                    <b>
                        <EyeIcon strokeWidth={2} aria-hidden />
                        {RadarText.window}
                    </b>
                    <i>{RadarText.windowHint}</i>
                </div>
            )}
        </div>
    );
});
View360Radar.displayName = "View360Radar";
