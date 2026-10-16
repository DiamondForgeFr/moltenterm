// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The conflict forecast in the Reviews list (FR-REV-023): a mark on each PR whose merge would put others in conflict,
// links from the hovered or selected PR to the rows it would impact, which show the conflicting files, and the
// forecast's state above the list. The data is reviews-forecast-model.ts's; nothing is computed here.

import { cn } from "@/util/util";
import { useLayoutEffect, useMemo, useState } from "react";
import {
    Forecast,
    forecastMark,
    ForecastMark,
    ForecastStatus,
    impactedBy,
    impactedNote,
    impactsOf,
} from "./reviews-forecast-model";
import { DominoLoader } from "../suite/suite";
import "./reviews-forecast.css";
import type { ReviewPr } from "./reviews-model";

// What a row shows of the forecast: its own mark, the note of a conflict another merge would cause, and whether it
// is linked to the active row.
export type RowForecast = { mark: ForecastMark; note: string; linked: boolean };

export type ListForecast = {
    rows: Record<number, RowForecast>;
    // The impacted rows of the active one, which the links reach.
    targets: number[];
};

// listForecast: what each row shows, for the active (hovered or selected) row.
export function listForecast(forecast: Forecast, ready: ReviewPr[], listed: ReviewPr[], active: number): ListForecast {
    const rows: Record<number, RowForecast> = {};
    const activePr = ready.find((pr) => pr.number === active);
    const targets = activePr == null ? [] : impactsOf(forecast, activePr, listed).map((i) => i.number);
    for (const pr of listed) {
        const isReady = ready.includes(pr);
        const mark = isReady ? forecastMark(impactsOf(forecast, pr, listed)) : null;
        const linked = targets.includes(pr.number);
        const by = linked ? impactedBy(forecast, pr, listed).filter((b) => b.number === active) : [];
        rows[pr.number] = { mark, note: impactedNote(by), linked };
    }
    return { rows, targets };
}

export function ForecastMarkChip({ mark, active }: { mark: ForecastMark; active: boolean }) {
    if (mark == null) {
        return null;
    }
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-4 border px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap",
                "border-warning/40 bg-warning/10 text-warning transition-colors duration-120 ease-mt",
                active && "border-warning/80 bg-warning/20"
            )}
            title={mark.title}
            aria-label={mark.aria}
            data-testid="reviews-forecast-mark"
        >
            <i className="fa fa-solid fa-code-merge text-11" aria-hidden />
            {mark.label}
        </span>
    );
}

// The note lies over the free end of the row's chips line and takes no room: a note that pushed the rows would move
// another row under a still pointer, which would then become the hovered one, and so on.
export function ForecastNote({ text }: { text: string }) {
    if (!text) {
        return null;
    }
    return (
        <div
            className="pointer-events-none absolute inset-y-0 right-0 left-0 flex items-center justify-end gap-1.5 text-12 leading-4 text-warning"
            data-testid="reviews-forecast-note"
        >
            <i className="fa fa-solid fa-code-merge shrink-0 text-11" aria-hidden />
            <span className="min-w-0 truncate">{text}</span>
        </div>
    );
}

export function ForecastStatusLine({ status }: { status: ForecastStatus }) {
    if (status == null || status.kind === "none") {
        return null;
    }
    const busy = status.kind === "computing" || status.kind === "stale";
    return (
        <span
            className={cn(
                "ml-auto flex min-w-0 items-center gap-1 text-11 font-normal",
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

type LinkGeometry = { width: number; height: number; x: number; from: number; to: number[] };

function rowMiddle(list: HTMLElement, listTop: number, number: number): number {
    const row = list.querySelector<HTMLElement>(`[data-pr="${number}"]`);
    if (row == null) {
        return null;
    }
    const rect = row.getBoundingClientRect();
    return rect.top - listTop + list.scrollTop + Math.min(rect.height / 2, 14);
}

function measure(list: HTMLElement, source: number, targets: number[]): LinkGeometry {
    const listRect = list.getBoundingClientRect();
    const sourceRow = list.querySelector<HTMLElement>(`[data-pr="${source}"]`);
    const from = rowMiddle(list, listRect.top, source);
    if (sourceRow == null || from == null) {
        return null;
    }
    const to = targets.map((n) => rowMiddle(list, listRect.top, n)).filter((y) => y != null);
    if (to.length === 0) {
        return null;
    }
    return {
        width: list.scrollWidth,
        height: list.scrollHeight,
        x: sourceRow.getBoundingClientRect().left - listRect.left + list.scrollLeft,
        from,
        to,
    };
}

// bracketPath: from the source row's left edge, out into the gutter and back to the target row's left edge.
function bracketPath(x: number, from: number, to: number): string {
    const depth = Math.min(x - 2, 4 + Math.abs(to - from) / 40);
    const out = x - depth;
    return `M ${x} ${from} C ${out} ${from}, ${out} ${to}, ${x} ${to}`;
}

// The links of the active row to its impacted rows, drawn over the list (its scroll content) in its left gutter.
export function ForecastLinks({
    listRef,
    source,
    targets,
}: {
    listRef: React.RefObject<HTMLDivElement>;
    source: number;
    targets: number[];
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
        return () => observer?.disconnect();
    }, [listRef, source, wanted]);
    if (geometry == null) {
        return null;
    }
    return (
        <svg
            className="mt-forecast-links"
            width={geometry.width}
            height={geometry.height}
            aria-hidden
            data-testid="reviews-forecast-links"
        >
            <circle className="mt-forecast-start" cx={geometry.x} cy={geometry.from} r={2} />
            {geometry.to.map((y, i) => (
                <g key={i}>
                    <path className="mt-forecast-link" d={bracketPath(geometry.x, geometry.from, y)} />
                    <circle className="mt-forecast-end" cx={geometry.x} cy={y} r={2.5} />
                </g>
            ))}
        </svg>
    );
}

// The impacted rows' accent: a warning-toned inner edge, so the link's ends read on the rows too.
export function linkedRowClass(linked: boolean): string {
    return linked ? "shadow-[inset_2px_0_0_var(--color-warning)]" : "";
}
