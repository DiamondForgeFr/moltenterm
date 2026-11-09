// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The week grid of a plan usage (FR-BOSS-009, AC48 to AC51, #2100), for any surface (Brokk's group, the companion's
// gauges, #2102): the initials of the calendar week once on top, Monday to Sunday, today's emphasised, then one row per
// line with the agent's logo (its name as tooltip) or, on a surface that shows one agent, the label of the row's window
// in its place, seven day blocks and the percent. The reset day's block is the start (0 %): the fill runs from it
// forward round the week, and it carries an accent ring and a slow sheen. Today's column stands out on every row. The
// fill and the percent take the colour of the pace, from on pace (success) to running out before the reset (error), or
// towards info when much of what the time allowed is left unused (#2106). A row shows no other detail on hover unless
// its surface gives it a tooltip; each row has an accessible name. A surface that has room for it asks for the legend
// under the rows (#2123): swatches made of the grid's own blocks, so they follow it.

import ClaudeColorSvg from "@/app/asset/claude-color.svg";
import { cn, makeIconClass } from "@/util/util";
import { autoUpdate, flip, FloatingPortal, offset, shift, useHover, useInteractions } from "@floating-ui/react";
import { CSSProperties, useState } from "react";
import { AiIcon } from "../ai-icon";
import { usageReasonText } from "../companion/companion-gauges-model";
import { relativeTime } from "../companion/companion-model";
import { useFloatingInPlace } from "../floating-in-place";
import { useLocale, useT } from "../i18n/i18n";
import {
    dayFills,
    legendColours,
    paceColour,
    PaceRedAt,
    resetDay,
    UnusedBlueFrom,
    UsageWeekLine,
    weekdayIndex,
    WeekDayKeys,
} from "./usage-week-model";
import "./usage-week.css";

export type UsageWeekRow = {
    key: string;
    // The agent whose logo the row shows.
    agent: string;
    // Its display name: the logo's tooltip and the start of the row's accessible name.
    name: string;
    // Absent when the reading cannot be read: the row then says so in one calm line.
    line?: UsageWeekLine;
    // Why the reading cannot be read (a companion gauges reason).
    unreadable?: string;
    // When the reading was taken (Unix ms), and whether it is old enough for its age to be told.
    readAt?: number;
    old?: boolean;
    // The row's window (its id), on a surface that shows one agent: each row is one of its windows.
    window?: string;
    // The window in a short form: it takes the logo's place. Cut with an ellipsis when the space runs out; `name` is the
    // whole of it.
    label?: string;
    // The row's tooltip, for a surface that has more to say about a window than the grid.
    title?: string;
    // A line under the row, across the grid.
    note?: string;
};

// How long the pointer rests on a logo before its name shows.
const NameDelayMs = 300;

// The agents whose own logo MoltenTerm already ships; the others show the AI icon the launcher gives every agent. A
// small popover names the agent, since not everyone knows every provider's logo: after a short rest of the pointer. It
// floats in a portal, so it never moves the layout and no scrolling block clips it. The logo is not clickable on its
// own.
function AgentLogo({ agent, name }: { agent: string; name: string }) {
    const claude = agent === "claude";
    const [open, setOpen] = useState(false);
    const { refs, floatingStyles, context } = useFloatingInPlace({
        open,
        onOpenChange: setOpen,
        placement: "left",
        middleware: [offset(8), flip(), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    const hover = useHover(context, { delay: { open: NameDelayMs, close: 0 } });
    const { getReferenceProps, getFloatingProps } = useInteractions([hover]);
    return (
        <>
            <span
                ref={refs.setReference}
                className="mt-uw-logo"
                data-testid="usage-week-logo"
                data-logo={claude ? "claude" : "ai"}
                data-name={name}
                {...getReferenceProps()}
            >
                {claude ? <ClaudeColorSvg /> : <i className={makeIconClass(AiIcon, true)} />}
            </span>
            {open ? (
                <FloatingPortal>
                    <span
                        ref={refs.setFloating}
                        className="mt-uw-name"
                        style={floatingStyles}
                        aria-hidden
                        data-testid="usage-week-name"
                        {...getFloatingProps()}
                    >
                        {name}
                    </span>
                </FloatingPortal>
            ) : null}
        </>
    );
}

// The pace as tests and styles read it: under (blue), ok, above (orange) or red.
function paceKind(line: UsageWeekLine): string {
    if (line.unused > UnusedBlueFrom) {
        return "under";
    }
    if (!(line.pace > 1)) {
        return "ok";
    }
    return line.pace > PaceRedAt ? "red" : "above";
}

// What starts a row: the label of its window when the row has one, else the agent's logo.
function RowLead({ row }: { row: UsageWeekRow }) {
    if (row.label == null) {
        return <AgentLogo agent={row.agent} name={row.name} />;
    }
    return (
        <span className="mt-uw-label" data-testid="usage-week-label">
            {row.label}
        </span>
    );
}

const LegendKeys = ["today", "reset", "under", "on", "above"] as const;
type LegendKey = (typeof LegendKeys)[number];

// What each key of the legend is: today and the reset day are the grid's own marks on an empty block, the paces a block
// filled with their colour.
function LegendSwatch({ legend, colours }: { legend: LegendKey; colours: ReturnType<typeof legendColours> }) {
    const colour = legend === "under" || legend === "on" || legend === "above" ? colours[legend] : null;
    return (
        <span
            className={cn("mt-uw-cell", legend === "today" && "is-today", legend === "reset" && "is-reset")}
            style={colour ? ({ "--mt-uw-pace": colour } as CSSProperties) : undefined}
            aria-hidden
            data-testid="usage-week-key-swatch"
        >
            {colour ? <i /> : null}
        </span>
    );
}

export function UsageWeekLegend() {
    const t = useT();
    const colours = legendColours();
    return (
        <span
            className="mt-uw-legend"
            role="group"
            aria-label={t("usageWeek.legend.label")}
            data-testid="usage-week-legend"
        >
            {LegendKeys.map((key) => (
                <span key={key} className="mt-uw-key" title={t(`usageWeek.legend.title.${key}`)} data-key={key}>
                    <LegendSwatch legend={key} colours={colours} />
                    {t(`usageWeek.legend.${key}`)}
                </span>
            ))}
        </span>
    );
}

export function UsageWeekGrid({ rows, now, legend }: { rows: UsageWeekRow[]; now: number; legend?: boolean }) {
    const t = useT();
    const locale = useLocale();
    const today = weekdayIndex(now);
    const labelled = rows.some((row) => row.label != null);
    return (
        <span className="mt-uw" data-labelled={labelled ? "true" : undefined} data-testid="usage-week">
            <span aria-hidden />
            {WeekDayKeys.map((key, i) => (
                <span
                    key={key}
                    className="mt-uw-day"
                    aria-hidden
                    data-testid="usage-week-day"
                    data-today={i === today ? "true" : undefined}
                >
                    {t(`usageWeek.day.${key}`)}
                </span>
            ))}
            <span aria-hidden />
            {rows.map((row) => {
                const { line, name } = row;
                if (line == null) {
                    const label = row.unreadable
                        ? t("usageWeek.rowUnreadable", { name, reason: usageReasonText(row.unreadable, row.agent) })
                        : t("usageWeek.rowNoReading", { name });
                    return (
                        <span
                            key={row.key}
                            className="mt-uw-row"
                            role="img"
                            aria-label={label}
                            title={row.title}
                            data-testid="usage-week-row"
                            data-provider={row.agent}
                            data-window={row.window}
                            data-unreadable="true"
                        >
                            <RowLead row={row} />
                            <span className="mt-uw-note" data-testid="usage-week-unreadable">
                                {t("usageWeek.unreadable")}
                            </span>
                        </span>
                    );
                }
                const day = resetDay(line.resetsAt, locale);
                const age = row.old ? relativeTime(row.readAt, now) : "";
                const parts = [
                    day
                        ? t("usageWeek.rowReset", { name, percent: line.percent, day })
                        : t("usageWeek.row", { name, percent: line.percent }),
                ];
                if (age) {
                    parts.push(t("usageWeek.rowAsOf", { ago: age }));
                }
                return (
                    <span
                        key={row.key}
                        className="mt-uw-row"
                        role="img"
                        aria-label={parts.join(", ")}
                        title={row.title}
                        style={{ "--mt-uw-pace": paceColour(line.pace, line.unused) } as CSSProperties}
                        data-pace={paceKind(line)}
                        data-old={row.old ? "true" : undefined}
                        data-testid="usage-week-row"
                        data-provider={row.agent}
                        data-window={row.window}
                    >
                        <RowLead row={row} />
                        {dayFills(line.percent, line.start).map((fill, i) => (
                            <span
                                key={i}
                                className={cn("mt-uw-cell", i === today && "is-today", i === line.start && "is-reset")}
                                data-testid="usage-week-block"
                                data-today={i === today ? "true" : undefined}
                                data-reset={i === line.start ? "true" : undefined}
                            >
                                <i style={{ width: `${Math.round(fill * 1000) / 10}%` }} />
                            </span>
                        ))}
                        <b className="mt-uw-pct" data-testid="usage-week-percent">
                            {t("usageWeek.percent", { percent: line.percent })}
                        </b>
                        {row.note ? (
                            <span className="mt-uw-detail" data-testid="usage-week-note">
                                {row.note}
                            </span>
                        ) : null}
                    </span>
                );
            })}
            {legend ? <UsageWeekLegend /> : null}
        </span>
    );
}
