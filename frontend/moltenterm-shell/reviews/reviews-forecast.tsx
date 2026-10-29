// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The conflict forecast in the Reviews list (FR-REV-023): a conflict is a relation between two cards (#1062). While a
// card is hovered or focused it is framed and the cards it conflicts with, either way, are tinted (the card shows the
// tag, reviews-card.tsx); one line per visible linked card draws once and stays still, and a linked card off the
// visible part of the list becomes an edge line. The forecast's state shows in the merge queue. The data is
// reviews-forecast-model.ts's and reviews-queue-model.ts's; nothing is computed here.

import { cn } from "@/util/util";
import { useLayoutEffect, useMemo, useState } from "react";
import { DominoLoader } from "../suite/suite";
import type { ForecastStatus } from "./reviews-forecast-model";
import "./reviews-forecast.css";
import type { CardRelation } from "./reviews-queue-model";

// The source card's frame and the linked cards' tint (the mockup's .card.source and .card.linked).
export function relationClass(role: CardRelation["role"]): string {
    if (role === "source") {
        return "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mt-state-warning)_60%,transparent)]";
    }
    if (role === "linked") {
        return "bg-[color-mix(in_srgb,var(--mt-state-warning)_6%,transparent)]";
    }
    return "";
}

export function ForecastStatusLine({ status }: { status: ForecastStatus }) {
    if (status == null || status.kind === "none") {
        return null;
    }
    const busy = status.kind === "computing" || status.kind === "stale";
    return (
        <span
            className={cn(
                "flex min-w-0 items-center gap-1 text-11 font-normal",
                status.kind === "failed" ? "text-warning" : "text-muted"
            )}
            title={status.title}
            aria-live="polite"
            data-testid="reviews-forecast-status"
            data-kind={status.kind}
        >
            {busy ? (
                <DominoLoader />
            ) : (
                <i
                    className={cn(
                        "fa fa-solid text-10",
                        status.kind === "failed" ? "fa-triangle-exclamation" : "fa-code-merge"
                    )}
                    aria-hidden
                />
            )}
            <span className="truncate">{status.text}</span>
        </span>
    );
}

export type EdgeWhere = "up" | "down" | "hidden";

type LinkGeometry = {
    width: number;
    height: number;
    x: number;
    from: number;
    to: number[];
    // The linked cards not in sight, and where the viewport's edges sit in the list's content.
    edges: { number: number; where: EdgeWhere }[];
    top: number;
    bottom: number;
};

function rowMiddle(list: HTMLElement, listTop: number, row: HTMLElement): number {
    const rect = row.getBoundingClientRect();
    return rect.top - listTop + list.scrollTop + Math.min(rect.height / 2, 14);
}

function measure(list: HTMLElement, source: number, targets: number[]): LinkGeometry {
    const listRect = list.getBoundingClientRect();
    const sourceRow = list.querySelector<HTMLElement>(`[data-pr="${source}"]`);
    if (sourceRow == null) {
        return null;
    }
    const from = rowMiddle(list, listRect.top, sourceRow);
    const top = list.scrollTop;
    const bottom = top + list.clientHeight;
    const to: number[] = [];
    const edges: LinkGeometry["edges"] = [];
    for (const n of targets) {
        const row = list.querySelector<HTMLElement>(`[data-pr="${n}"]`);
        if (row == null) {
            edges.push({ number: n, where: "hidden" });
            continue;
        }
        const y = rowMiddle(list, listRect.top, row);
        if (y < top) {
            edges.push({ number: n, where: "up" });
        } else if (y > bottom) {
            edges.push({ number: n, where: "down" });
        } else {
            to.push(y);
        }
    }
    if (to.length === 0 && edges.length === 0) {
        return null;
    }
    return {
        width: list.scrollWidth,
        height: list.scrollHeight,
        x: sourceRow.getBoundingClientRect().left - listRect.left + list.scrollLeft,
        from,
        to,
        edges,
        top,
        bottom,
    };
}

// bracketPath: from the source card's left edge, out into the gutter and back to the linked card's left edge.
function bracketPath(x: number, from: number, to: number): string {
    const depth = Math.min(x - 2, 4 + Math.abs(to - from) / 40);
    const out = x - depth;
    return `M ${x} ${from} C ${out} ${from}, ${out} ${to}, ${x} ${to}`;
}

// The active card's lines to its visible linked cards, drawn over the list (its scroll content) in its left gutter,
// and an edge line for each linked card out of sight; neither takes room, so nothing moves under the pointer.
export function ForecastLinks({
    listRef,
    source,
    targets,
    edgeText,
}: {
    listRef: React.RefObject<HTMLDivElement>;
    source: number;
    targets: number[];
    edgeText: (number: number, where: EdgeWhere) => string;
}) {
    const [geometry, setGeometry] = useState<LinkGeometry>(null);
    const targetsKey = targets.join(",");
    const wanted = useMemo(
        () => (source == null ? [] : targetsKey.split(",").filter(Boolean).map(Number)),
        [source, targetsKey]
    );
    useLayoutEffect(() => {
        const list = listRef.current;
        if (list == null || source == null || wanted.length === 0) {
            setGeometry(null);
            return;
        }
        const update = () => setGeometry(measure(list, source, wanted));
        update();
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
        observer?.observe(list);
        list.addEventListener("scroll", update, { passive: true });
        return () => {
            observer?.disconnect();
            list.removeEventListener("scroll", update);
        };
    }, [listRef, source, wanted]);
    if (geometry == null) {
        return null;
    }
    const ups = geometry.edges.filter((e) => e.where === "up");
    const downs = geometry.edges.filter((e) => e.where !== "up");
    return (
        <>
            {geometry.to.length > 0 ? (
                <svg
                    className="mt-forecast-links"
                    width={geometry.width}
                    height={geometry.height}
                    aria-hidden
                    data-testid="reviews-forecast-links"
                >
                    <circle className="mt-forecast-start" cx={geometry.x} cy={geometry.from} r={2} />
                    {geometry.to.map((y, i) => (
                        <g key={`${source}-${i}`}>
                            <path
                                className="mt-forecast-link"
                                pathLength={1}
                                d={bracketPath(geometry.x, geometry.from, y)}
                            />
                            <circle className="mt-forecast-end" cx={geometry.x} cy={y} r={2.5} />
                        </g>
                    ))}
                </svg>
            ) : null}
            {ups.length > 0 ? <EdgeLines top={geometry.top + 4} edges={ups} edgeText={edgeText} /> : null}
            {downs.length > 0 ? <EdgeLines bottom={geometry.bottom - 4} edges={downs} edgeText={edgeText} /> : null}
        </>
    );
}

function EdgeLines({
    top,
    bottom,
    edges,
    edgeText,
}: {
    top?: number;
    // The lines' bottom edge in the list's content, for those under the viewport.
    bottom?: number;
    edges: { number: number; where: EdgeWhere }[];
    edgeText: (number: number, where: EdgeWhere) => string;
}) {
    return (
        <div
            className="mt-forecast-edge pointer-events-none absolute right-3 left-3 z-[2] flex flex-col gap-1"
            style={top != null ? { top } : { top: bottom, transform: "translateY(-100%)" }}
            aria-hidden
            data-testid="reviews-forecast-edge"
        >
            {edges.map((e) => (
                <div
                    key={e.number}
                    className="truncate rounded-4 border border-dashed border-[color-mix(in_srgb,var(--mt-state-warning)_45%,transparent)] bg-[var(--mt-surface-2)] px-3 py-1 text-11 leading-4 text-[var(--mt-state-warning)]"
                    data-pr-edge={e.number}
                    data-where={e.where}
                >
                    {edgeText(e.number, e.where)}
                </div>
            ))}
        </div>
    );
}
