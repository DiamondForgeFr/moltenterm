// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The week grid of a plan usage (FR-BOSS-009, AC48 to AC51, #2100), for any surface (Brokk's group, #2102): the initials
// of the calendar week once on top, Monday to Sunday, today's emphasised, then one row per line with the agent's logo
// (its name as tooltip), seven day blocks and the percent. The reset day's block is the start (0 %): the fill runs from
// it forward round the week, and it carries an accent ring and a slow sheen. Today's column stands out on every row. The
// fill and the percent take the colour of the pace, from on pace (success) to running out before the reset (error). It
// shows no other detail on hover; each row has an accessible name.

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
    paceColour,
    PaceRedAt,
    resetDay,
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
};

// How long the pointer rests on a logo before its name shows.
const NameDelayMs = 300;

// The agents whose own logo MoltenTerm already ships; the others show the AI icon the launcher gives every agent. A
// small popover names the agent, since not everyone knows every provider's logo: after a short rest of the pointer, or
// while the surface says so (`named`, its keyboard focus: the logo sits inside a button and takes no focus of its own).
// It floats in a portal, so it never moves the layout and no scrolling block clips it. The logo is not clickable on its
// own.
function AgentLogo({ agent, name, named }: { agent: string; name: string; named: boolean }) {
    const claude = agent === "claude";
    const [hovered, setHovered] = useState(false);
    const open = hovered || named;
    const { refs, floatingStyles, context } = useFloatingInPlace({
        open,
        onOpenChange: setHovered,
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

export function UsageWeekGrid({
    rows,
    now,
    id,
    named = false,
}: {
    rows: UsageWeekRow[];
    now: number;
    id?: string;
    named?: boolean;
}) {
    const t = useT();
    const locale = useLocale();
    const today = weekdayIndex(now);
    return (
        <span className="mt-uw" id={id} data-testid="usage-week">
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
                            data-testid="usage-week-row"
                            data-provider={row.agent}
                            data-unreadable="true"
                        >
                            <AgentLogo agent={row.agent} name={name} named={named} />
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
                        style={{ "--mt-uw-pace": paceColour(line.pace) } as CSSProperties}
                        data-pace={line.pace > 1 ? (line.pace > PaceRedAt ? "red" : "above") : "ok"}
                        data-old={row.old ? "true" : undefined}
                        data-testid="usage-week-row"
                        data-provider={row.agent}
                    >
                        <AgentLogo agent={row.agent} name={name} named={named} />
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
                    </span>
                );
            })}
        </span>
    );
}
