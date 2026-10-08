// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Edge split handles (FR-SHELL-042-AC1..3, DS-SHELL-065): near a panel's right or bottom edge, a small bud of the
// rail's family (#365, DS-SHELL-061) grows out of the edge; a click splits the panel in half, a drag sets the new
// panel's size along a preview line, Escape cancels the drag. Everything is drawn in an overlay of the block frame:
// nothing in the panel moves (NFR-SHELL-023), and the layout's resize gutter, outside the block, is never covered.

import { atoms } from "@/app/store/global";
import { NodeModel } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import React, { useEffect, useRef, useState } from "react";
import { formatShortcutById } from "../shortcuts/format";
import { splitPanel } from "./split";
import "./split-handles.css";
import { clampFraction, dragFraction, handlesAllowed, MinPanelPx, nearEdge } from "./split-model";

type Edge = "right" | "down";

// The hot zone along the edge, past a small inset; the dwell before the bud shows, and the delay before it hides.
const HotZonePx = 12;
const EdgeInsetPx = 2;
const DwellMs = 120;
const HideMs = 200;
// Under this movement a press on the bud is a click (a half split).
const DragThresholdPx = 4;
// Hover cannot be observed through a webview (the page is another process): browser panels get a short catcher strip
// in the middle of each edge instead.
const WebviewViews = new Set(["molten-browser", "web"]);
const CatcherLengthPx = 64;
const CatcherDepthPx = 6;

export const SplitBudFilterId = "molten-split-bud-goo";

type DragState = { edge: Edge; startX: number; startY: number; moved: boolean; pos: number; length: number };

// The same metaball filter as the rail buds (workspace-rail-edit.tsx RailBudFilter), under its own id so the handles
// do not depend on the rail being drawn. Added once to the document: one per block would repeat its id.
const SplitBudFilterSvg = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;pointer-events:none"><defs><filter id="${SplitBudFilterId}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blur"/><feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 40 -19.5"/></filter></defs></svg>`;

function ensureSplitBudFilter() {
    if (document.getElementById(SplitBudFilterId) != null) {
        return;
    }
    const holder = document.createElement("div");
    holder.innerHTML = SplitBudFilterSvg;
    document.body.appendChild(holder.firstElementChild);
}

function Bud({
    edge,
    shown,
    reducedMotion,
    onPointerDown,
    onHover,
}: {
    edge: Edge;
    shown: boolean;
    reducedMotion: boolean;
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>, edge: Edge) => void;
    onHover: (inside: boolean) => void;
}) {
    const label = edge === "right" ? "Split right" : "Split down";
    const keys = formatShortcutById(edge === "right" ? "split-right" : "split-down");
    return (
        <span
            className="molten-split-bud"
            data-edge={edge}
            data-shown={shown ? "" : undefined}
            data-reduced-motion={reducedMotion ? "" : undefined}
        >
            <span className="molten-split-bud-goo" style={{ filter: `url(#${SplitBudFilterId})` }} aria-hidden>
                <span className="molten-split-bud-tile" />
                <span className="molten-split-bud-stub" />
                <span className="molten-split-bud-drop" />
            </span>
            <button
                type="button"
                tabIndex={-1}
                aria-label={label}
                title={`${label} (${keys}) · drag to set the size`}
                data-role={`split-handle-${edge}`}
                onPointerDown={(e) => onPointerDown(e, edge)}
                onPointerEnter={() => onHover(true)}
                onPointerLeave={() => onHover(false)}
                onContextMenu={(e) => e.preventDefault()}
                className="molten-split-bud-hit cursor-pointer"
            >
                <i
                    className={cn(
                        "fa fa-solid fa-table-columns molten-split-bud-glyph",
                        edge === "down" && "rotate-90"
                    )}
                />
            </button>
        </span>
    );
}

export function SplitEdgeHandles({
    nodeModel,
    viewType,
    preview,
}: {
    nodeModel: NodeModel;
    viewType: string;
    preview: boolean;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const [edge, setEdge] = useState<Edge>(null);
    const [drag, setDrag] = useState<DragState>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const magnified = useAtomValue(nodeModel.isMagnified);
    const anyMagnified = useAtomValue(nodeModel.anyMagnified);
    const ephemeral = useAtomValue(nodeModel.isEphemeral);
    const resizing = useAtomValue(nodeModel.isResizing);
    const reducedMotion = useAtomValue(atoms.prefersReducedMotionAtom);
    const timers = useRef<{ show?: ReturnType<typeof setTimeout>; hide?: ReturnType<typeof setTimeout> }>({});
    const pending = useRef<Edge>(null);
    const overBud = useRef(false);
    const dragRef = useRef<DragState>(null);
    dragRef.current = drag;

    const blocked = preview || ephemeral || resizing || (anyMagnified && !magnified) || magnified;
    const allowed = (e: Edge) =>
        handlesAllowed({
            preview,
            ephemeral,
            magnified: magnified || anyMagnified,
            resizing,
            width: size.width,
            height: size.height,
            edge: e,
        });

    const clearTimers = () => {
        clearTimeout(timers.current.show);
        clearTimeout(timers.current.hide);
        timers.current = {};
    };

    // The pointer is followed on the block frame itself: the overlay takes no pointer, so the panel keeps every click.
    useEffect(() => {
        const block = rootRef.current?.parentElement;
        if (block == null || blocked) {
            return;
        }
        const updateSize = () => {
            const rect = block.getBoundingClientRect();
            setSize((prev) =>
                prev.width === rect.width && prev.height === rect.height
                    ? prev
                    : { width: rect.width, height: rect.height }
            );
        };
        updateSize();
        const observer = new ResizeObserver(updateSize);
        observer.observe(block);
        const onMove = (e: PointerEvent) => {
            if (dragRef.current != null) {
                return;
            }
            const rect = block.getBoundingClientRect();
            const near = nearEdge(
                e.clientX - rect.left,
                e.clientY - rect.top,
                rect.width,
                rect.height,
                HotZonePx,
                EdgeInsetPx
            );
            if (near != null || overBud.current) {
                clearTimeout(timers.current.hide);
                timers.current.hide = undefined;
                if (near != null && pending.current !== near) {
                    pending.current = near;
                    clearTimeout(timers.current.show);
                    timers.current.show = setTimeout(() => setEdge(near), DwellMs);
                }
                return;
            }
            pending.current = null;
            clearTimeout(timers.current.show);
            if (timers.current.hide == null) {
                timers.current.hide = setTimeout(() => {
                    timers.current.hide = undefined;
                    setEdge(null);
                }, HideMs);
            }
        };
        const onLeave = () => {
            if (dragRef.current != null || overBud.current) {
                return;
            }
            pending.current = null;
            clearTimeout(timers.current.show);
            timers.current.hide = setTimeout(() => {
                timers.current.hide = undefined;
                setEdge(null);
            }, HideMs);
        };
        block.addEventListener("pointermove", onMove);
        block.addEventListener("pointerleave", onLeave);
        return () => {
            block.removeEventListener("pointermove", onMove);
            block.removeEventListener("pointerleave", onLeave);
            observer.disconnect();
            clearTimers();
            pending.current = null;
        };
    }, [blocked]);

    useEffect(() => {
        ensureSplitBudFilter();
    }, []);

    useEffect(() => {
        if (blocked) {
            setEdge(null);
            setDrag(null);
            // The bud is gone without a pointerleave: it no longer holds the hover.
            overBud.current = false;
        }
    }, [blocked]);

    // Escape cancels a drag (FR-SHELL-042-AC2), before any other Escape handler of the window.
    useEffect(() => {
        if (drag == null) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            setDrag(null);
            setEdge(null);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [drag != null]);

    const onBudDown = (e: React.PointerEvent<HTMLButtonElement>, budEdge: Edge) => {
        if (e.button !== 0) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const block = rootRef.current?.parentElement;
        if (block == null) {
            return;
        }
        const rect = block.getBoundingClientRect();
        const length = budEdge === "right" ? rect.width : rect.height;
        setDrag({ edge: budEdge, startX: e.clientX, startY: e.clientY, moved: false, pos: length / 2, length });
        rootRef.current?.setPointerCapture(e.pointerId);
    };

    const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (d == null) {
            return;
        }
        const moved = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) >= DragThresholdPx;
        const rect = rootRef.current.parentElement.getBoundingClientRect();
        const raw = d.edge === "right" ? e.clientX - rect.left : e.clientY - rect.top;
        const pos = Math.min(Math.max(raw, MinPanelPx), d.length - MinPanelPx);
        setDrag({ ...d, moved, pos });
    };

    const onDragUp = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (d == null) {
            return;
        }
        rootRef.current?.releasePointerCapture?.(e.pointerId);
        setDrag(null);
        setEdge(null);
        overBud.current = false;
        const fraction = d.moved ? clampFraction(dragFraction(d.edge, d.pos, 0, d.length), d.length) : 0.5;
        fireAndForget(() => splitPanel(nodeModel.blockId, d.edge, fraction));
    };

    if (preview) {
        return null;
    }
    const webview = WebviewViews.has(viewType);
    const shown = (e: Edge) => !blocked && allowed(e) && (edge === e || drag?.edge === e);
    return (
        <div
            ref={rootRef}
            className={cn("molten-split-overlay", drag != null && "molten-split-overlay-dragging")}
            data-dragging={drag != null ? drag.edge : undefined}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
            onPointerCancel={() => setDrag(null)}
        >
            {webview && !blocked ? (
                <>
                    {allowed("right") ? (
                        <div
                            className="molten-split-catcher"
                            style={{
                                right: EdgeInsetPx,
                                top: `calc(50% - ${CatcherLengthPx / 2}px)`,
                                width: CatcherDepthPx,
                                height: CatcherLengthPx,
                            }}
                        />
                    ) : null}
                    {allowed("down") ? (
                        <div
                            className="molten-split-catcher"
                            style={{
                                bottom: EdgeInsetPx,
                                left: `calc(50% - ${CatcherLengthPx / 2}px)`,
                                height: CatcherDepthPx,
                                width: CatcherLengthPx,
                            }}
                        />
                    ) : null}
                </>
            ) : null}
            {drag?.moved ? (
                <div
                    className="molten-split-preview"
                    data-edge={drag.edge}
                    style={
                        drag.edge === "right"
                            ? { left: drag.pos, top: 0, bottom: 0, right: 0 }
                            : { top: drag.pos, left: 0, right: 0, bottom: 0 }
                    }
                />
            ) : null}
            {(["right", "down"] as Edge[]).map((e) =>
                allowed(e) && !blocked ? (
                    <Bud
                        key={e}
                        edge={e}
                        shown={shown(e)}
                        reducedMotion={reducedMotion}
                        onPointerDown={onBudDown}
                        onHover={(inside) => {
                            overBud.current = inside;
                            if (inside) {
                                clearTimeout(timers.current.hide);
                                timers.current.hide = undefined;
                            }
                        }}
                    />
                ) : null
            )}
        </div>
    );
}
