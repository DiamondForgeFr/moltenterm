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
// under the rows (#2123): swatches made of the grid's own blocks, so they follow it. A surface that wants the share of
// each day asks for the figures under the blocks (#2164): one small muted number a block, in a line of its own. A row
// whose reading is stale (#2341) is faded, takes no pace colour and tells its age on a line under it.

import ClaudeColorSvg from "@/app/asset/claude-color.svg";
import { cn, makeIconClass } from "@/util/util";
import { autoUpdate, flip, FloatingPortal, offset, shift, useHover, useInteractions } from "@floating-ui/react";
import { CSSProperties, useState } from "react";
import { AiIcon } from "../ai-icon";
import { usageReasonText } from "../companion/companion-gauges-model";
import { relativeTime } from "../companion/companion-model";
import { useFloatingInPlace } from "../floating-in-place";
import { useLocale, useT } from "../i18n/i18n";
import { anchoredMenuEvent, buttonMenuAnchor } from "../menu/menu-anchor";
import {
    DayUnknown,
    legendColours,
    lineDayFiguresText,
    lineDayFills,
    lineDayShares,
    paceColour,
    PaceRedAt,
    percentText,
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
    // Its display name: the start of the logo's popover and the row's accessible name.
    name: string;
    // The selected main window, already localized by the surface; the popover and accessible name compose it with name.
    windowLabel?: string;
    // Absent when the reading cannot be read: the row then says so in one calm line.
    line?: UsageWeekLine;
    // Why the reading cannot be read (a companion gauges reason).
    unreadable?: string;
    // When the reading was taken (Unix ms), and whether it is old enough for its age to be told.
    readAt?: number;
    old?: boolean;
    // The reading is older than its window, or than 7 days (#2341): the row is faded, takes no pace colour and tells its
    // age under it.
    stale?: boolean;
    // The row's own menu, on a surface that has one (Brokk's choice of which providers show): the right button on the row
    // opens it, and so does the logo, now a button, from the keyboard (Enter, Space, the Menu key, Shift+F10). A row with
    // a menu is a group holding that button, not an image.
    onContextMenu?: (e: React.MouseEvent) => void;
    // The row's window (its id), on a surface that shows one agent: each row is one of its windows.
    window?: string;
    // The window in a short form: it takes the logo's place. Cut with an ellipsis when the space runs out; `name` is the
    // whole of it.
    label?: string;
    // The row's tooltip, for a surface that has more to say about a window than the grid.
    title?: string;
    // A line under the row, across the grid.
    note?: string;
    // A plain gauge's reset, short ("in 1 h 20 min"), at the end of its bar (#2451).
    resets?: string;
};

// How long the pointer rests on a logo before its name shows.
const NameDelayMs = 300;

// The event a row's menu gets from its logo's button: Enter or Space is a click at 0, 0, which would put the menu in the
// window's corner, so it opens under the button and, as a keyboard opening, focuses its first entry (#1439).
export function openRowMenu(e: React.MouseEvent): React.MouseEvent {
    return anchoredMenuEvent(e, buttonMenuAnchor(e.currentTarget));
}

// The agents whose own logo MoltenTerm already ships; the others show the AI icon the launcher gives every agent. A
// small popover names the agent, since not everyone knows every provider's logo: after a short rest of the pointer, or
// at once when the keyboard reaches the logo. It floats in a portal, so it never moves the layout and no scrolling block
// clips it. The logo is not clickable on its own. A row with a menu (#2341) makes its logo the button that opens it,
// so the menu is reached from the keyboard too: Tab to the logo, then Enter or Space, the Menu key or Shift+F10 (which
// the menu host turns into the row's own context menu); a pointer still opens it with the right button on the row.
function AgentLogo({
    agent,
    name,
    windowLabel,
    onMenu,
}: {
    agent: string;
    name: string;
    windowLabel?: string;
    onMenu?: (e: React.MouseEvent) => void;
}) {
    const t = useT();
    const displayName = windowLabel ? t("usageWeek.providerWindow", { name, window: windowLabel }) : name;
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
    const logo = {
        ref: refs.setReference,
        className: "mt-uw-logo",
        "data-testid": "usage-week-logo",
        "data-logo": claude ? "claude" : "ai",
        "data-name": displayName,
    };
    const icon = claude ? <ClaudeColorSvg /> : <i className={makeIconClass(AiIcon, true)} />;
    return (
        <>
            {onMenu == null ? (
                <span {...logo} {...getReferenceProps()}>
                    {icon}
                </span>
            ) : (
                <button
                    type="button"
                    aria-haspopup="menu"
                    aria-label={t("usageWeek.choice.open", { name })}
                    {...logo}
                    {...getReferenceProps({
                        onClick: (e) => onMenu(openRowMenu(e)),
                        // The name shows when the keyboard reaches the logo, as it does when the pointer rests on it.
                        onFocus: (e) => setOpen(e.currentTarget.matches(":focus-visible")),
                        onBlur: () => setOpen(false),
                    })}
                >
                    {icon}
                </button>
            )}
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
                        {displayName}
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
        return <AgentLogo agent={row.agent} name={row.name} windowLabel={row.windowLabel} onMenu={row.onContextMenu} />;
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

export function UsageWeekLegend({ popovers }: { popovers?: boolean }) {
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
                <span
                    key={key}
                    className="mt-uw-key"
                    title={popovers ? undefined : t(`usageWeek.legend.title.${key}`)}
                    data-tip={popovers ? t(`usageWeek.legend.title.${key}`) : undefined}
                    data-key={key}
                >
                    <LegendSwatch legend={key} colours={colours} />
                    {t(`usageWeek.legend.${key}`)}
                </span>
            ))}
        </span>
    );
}

// The line of figures under a row's blocks, across the grid's columns: the lead's and the percent's stay empty. It is
// decoration for the eye: the row's accessible name already carries the percent.
function DayFigures({ line }: { line: UsageWeekLine }) {
    const t = useT();
    return (
        <>
            <span aria-hidden />
            {lineDayShares(line).map((share, i) =>
                share == null ? (
                    <span
                        key={i}
                        className="mt-uw-share"
                        aria-hidden
                        data-testid="usage-week-share"
                        data-unknown="true"
                    />
                ) : (
                    <span key={i} className="mt-uw-share" aria-hidden data-testid="usage-week-share" data-share={share}>
                        {share}
                        <span className="mt-uw-unit">{t("usageWeek.dayUnit")}</span>
                    </span>
                )
            )}
            <span aria-hidden />
        </>
    );
}

// A window the seven days say nothing of (a five-hour session, a month, #2451): one bar across the day columns, filled to
// the used share in the pace colour, its reset at the end.
function PlainGauge({ line, resets }: { line: UsageWeekLine; resets?: string }) {
    const fill = Math.min(100, Math.max(0, line.used ?? line.percent));
    return (
        <span className="mt-uw-gauge" data-testid="usage-week-gauge">
            <span className="mt-uw-gauge-bar">
                <i style={{ width: `${Math.round(fill * 10) / 10}%` }} />
            </span>
            {resets ? (
                <span className="mt-uw-gauge-reset" data-testid="usage-week-gauge-reset">
                    {resets}
                </span>
            ) : null}
        </span>
    );
}

// minimal is the form of #2450: the rows alone, each a label, its seven blocks and its percent, with no day initials on
// top, no figures under the blocks and no legend. The row's accessible name carries what the form leaves out, the reset
// day and the figure of each day; a surface that wants them in a tooltip gives the row its title.
export function UsageWeekGrid({
    rows,
    now,
    legend,
    dayFigures,
    minimal,
    popovers,
}: {
    rows: UsageWeekRow[];
    now: number;
    legend?: boolean;
    dayFigures?: boolean;
    minimal?: boolean;
    // The titles of the rows and of the legend are said by a panel's popovers (data-tip, the companion's) instead of the
    // system tooltip.
    popovers?: boolean;
}) {
    const t = useT();
    const locale = useLocale();
    const today = weekdayIndex(now);
    const labelled = rows.some((row) => row.label != null);
    return (
        <span
            className="mt-uw"
            data-labelled={labelled ? "true" : undefined}
            data-figures={dayFigures && !minimal ? "true" : undefined}
            data-minimal={minimal ? "true" : undefined}
            data-testid="usage-week"
        >
            {minimal ? null : (
                <>
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
                </>
            )}
            {rows.map((row) => {
                const { line, name } = row;
                const displayName = row.windowLabel
                    ? t("usageWeek.providerWindow", { name, window: row.windowLabel })
                    : name;
                if (line == null) {
                    const label = row.unreadable
                        ? t("usageWeek.rowUnreadable", {
                              name: displayName,
                              reason: usageReasonText(row.unreadable, row.agent),
                          })
                        : t("usageWeek.rowNoReading", { name: displayName });
                    return (
                        <span
                            key={row.key}
                            className="mt-uw-row"
                            role={row.onContextMenu ? "group" : "img"}
                            aria-label={label}
                            title={popovers ? undefined : row.title}
                            data-tip={popovers ? row.title : undefined}
                            data-testid="usage-week-row"
                            data-provider={row.agent}
                            data-window={row.window}
                            data-unreadable="true"
                            onContextMenu={row.onContextMenu}
                        >
                            <RowLead row={row} />
                            <span className="mt-uw-note" data-testid="usage-week-unreadable">
                                {t("usageWeek.unreadable")}
                            </span>
                        </span>
                    );
                }
                const day = resetDay(line.resetsAt, locale);
                const age = row.old || row.stale ? relativeTime(row.readAt, now) : "";
                const percent = percentText(line);
                const parts = [
                    day && !line.plain
                        ? t("usageWeek.rowReset", { name: displayName, percent, day })
                        : t("usageWeek.row", { name: displayName, percent }),
                ];
                if (line.plain && row.resets) {
                    parts.push(row.resets);
                }
                if (minimal && !line.plain) {
                    parts.push(t("usageWeek.rowDays", { days: lineDayFiguresText(line) }));
                }
                if (age) {
                    parts.push(t("usageWeek.rowAsOf", { ago: age }));
                }
                return (
                    <span
                        key={row.key}
                        className="mt-uw-row"
                        role={row.onContextMenu ? "group" : "img"}
                        aria-label={parts.join(", ")}
                        title={popovers ? undefined : row.title}
                        data-tip={popovers ? row.title : undefined}
                        style={{ "--mt-uw-pace": paceColour(line.pace, line.unused) } as CSSProperties}
                        data-pace={paceKind(line)}
                        data-old={row.old ? "true" : undefined}
                        data-stale={row.stale ? "true" : undefined}
                        data-testid="usage-week-row"
                        data-provider={row.agent}
                        data-window={row.window}
                        data-plain={line.plain ? "true" : undefined}
                        data-deduced={line.days != null ? "true" : undefined}
                        onContextMenu={row.onContextMenu}
                    >
                        <RowLead row={row} />
                        {line.plain ? (
                            <PlainGauge line={line} resets={row.resets} />
                        ) : (
                            lineDayFills(line).map((fill, i) => {
                                const unknown = line.days?.[i] === DayUnknown;
                                return (
                                    <span
                                        key={i}
                                        className={cn(
                                            "mt-uw-cell",
                                            i === today && "is-today",
                                            i === line.start && "is-reset",
                                            unknown && "is-unknown"
                                        )}
                                        data-testid="usage-week-block"
                                        data-today={i === today ? "true" : undefined}
                                        data-reset={i === line.start ? "true" : undefined}
                                        data-unknown={unknown ? "true" : undefined}
                                    >
                                        <i style={{ width: `${Math.round(fill * 1000) / 10}%` }} />
                                    </span>
                                );
                            })
                        )}
                        <b className="mt-uw-pct" data-testid="usage-week-percent">
                            {percent}
                        </b>
                        {dayFigures && !minimal && !line.plain ? <DayFigures line={line} /> : null}
                        {row.note ? (
                            <span className="mt-uw-detail" data-testid="usage-week-note">
                                {row.note}
                            </span>
                        ) : null}
                        {row.stale && !row.note ? (
                            <span className="mt-uw-detail" data-testid="usage-week-stale">
                                {t("usageWeek.stale", { ago: age })}
                            </span>
                        ) : null}
                    </span>
                );
            })}
            {legend && !minimal ? <UsageWeekLegend popovers={popovers} /> : null}
        </span>
    );
}
