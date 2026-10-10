// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Edge split handles (FR-SHELL-042-AC1..3, FR-SHELL-046, DS-SHELL-065, DS-SHELL-083): near a panel's right or bottom
// edge, a 2 px accent hairline runs along the edge with a 20 px "+" handle in its middle; hovering the handle draws a
// ghost of the new panel at 50 % and its tooltip, a click splits the panel in half, a drag sets the new panel's size
// (the ghost follows), Escape cancels the drag. Everything is drawn in an overlay of the block frame that clips to the
// panel: nothing in the panel moves (NFR-SHELL-023, NFR-SHELL-029), nothing reaches the panel below (FR-SHELL-046-AC4),
// and the layout's resize gutter, outside the block, is never covered.

import { atoms } from "@/app/store/global";
import { NodeModel } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import React, { useEffect, useId, useRef, useState } from "react";
import { formatShortcutById } from "../shortcuts/format";
import { splitPanel } from "./split";
import "./split-handles.css";
import { clampFraction, dragFraction, handlesAllowed, MinPanelPx, nearEdge, splitHandleText } from "./split-model";

type Edge = "right" | "down";

// The hot zone along the edge, past a small inset; the dwell before the handle shows, and the delay before it hides.
const HotZonePx = 12;
const EdgeInsetPx = 2;
const DwellMs = 120;
const HideMs = 200;
// Under this movement a press on the handle is a click (a half split).
const DragThresholdPx = 4;
// Hover cannot be observed through a webview (the page is another process): browser panels get a short catcher strip
// in the middle of each edge instead.
const WebviewViews = new Set(["molten-browser", "web"]);
const CatcherLengthPx = 64;
const CatcherDepthPx = 6;

type DragState = { edge: Edge; startX: number; startY: number; moved: boolean; pos: number; length: number };

// Drawn, not a font glyph: two 1.5 px strokes stay centred and crisp at every scale of the hover.
function PlusGlyph() {
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden focusable="false">
            <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        </svg>
    );
}

function EdgeHandle({
    edge,
    shown,
    hovered,
    dragging,
    reducedMotion,
    onPointerDown,
    onHover,
}: {
    edge: Edge;
    shown: boolean;
    hovered: boolean;
    dragging: boolean;
    reducedMotion: boolean;
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>, edge: Edge) => void;
    onHover: (edge: Edge, inside: boolean) => void;
}) {
    const tipId = useId();
    const keys = formatShortcutById(edge === "right" ? "split-right" : "split-down");
    const { label, tip } = splitHandleText(edge, keys);
    const [before, after] = keys ? tip.split(keys) : [tip, ""];
    return (
        <span
            className="molten-split-edge"
            data-edge={edge}
            data-shown={shown ? "" : undefined}
            data-hover={hovered ? "" : undefined}
            data-dragging={dragging ? "" : undefined}
            data-reduced-motion={reducedMotion ? "" : undefined}
        >
            <span className="molten-split-hairline" aria-hidden />
            <button
                type="button"
                tabIndex={-1}
                aria-label={label}
                aria-describedby={tipId}
                data-role={`split-handle-${edge}`}
                onPointerDown={(e) => onPointerDown(e, edge)}
                onPointerEnter={() => onHover(edge, true)}
                onPointerLeave={() => onHover(edge, false)}
                onContextMenu={(e) => e.preventDefault()}
                className="molten-split-handle cursor-pointer"
            >
                <PlusGlyph />
            </button>
            <span id={tipId} role="tooltip" className="molten-split-tip">
                {before}
                {keys ? <kbd className="molten-split-tip-keys">{keys}</kbd> : null}
                <span className="molten-split-tip-rest">{after}</span>
            </span>
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
    const [hoverEdge, setHoverEdge] = useState<Edge>(null);
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
        if (blocked) {
            setEdge(null);
            setDrag(null);
            // The handle is gone without a pointerleave: it no longer holds the hover.
            overBud.current = false;
            setHoverEdge(null);
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
        setHoverEdge(null);
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
            {(["right", "down"] as Edge[]).map((e) => {
                if (!allowed(e) || blocked) {
                    return null;
                }
                // The ghost of the new panel: at 50 % while the handle is hovered, at the drag's line while dragging.
                const dragging = drag?.edge === e && drag.moved;
                const ghostShown = drag?.edge === e || (drag == null && hoverEdge === e && shown(e));
                const at = dragging ? `${drag.pos}px` : "50%";
                return (
                    <div
                        key={`ghost-${e}`}
                        className="molten-split-preview"
                        data-edge={e}
                        data-shown={ghostShown ? "" : undefined}
                        data-dragging={dragging ? "" : undefined}
                        data-reduced-motion={reducedMotion ? "" : undefined}
                        style={e === "right" ? { left: at } : { top: at }}
                    />
                );
            })}
            {(["right", "down"] as Edge[]).map((e) =>
                allowed(e) && !blocked ? (
                    <EdgeHandle
                        key={e}
                        edge={e}
                        shown={shown(e)}
                        hovered={drag == null ? hoverEdge === e : drag.edge === e}
                        dragging={drag?.edge === e}
                        reducedMotion={reducedMotion}
                        onPointerDown={onBudDown}
                        onHover={(he, inside) => {
                            overBud.current = inside;
                            setHoverEdge((prev) => (inside ? he : prev === he ? null : prev));
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
