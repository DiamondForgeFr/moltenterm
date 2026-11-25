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
// whose reading is stale (#2341) is faded, takes no pace colour and tells its age on a line under it. A surface that
// labels its rows by window gets a label column as wide as its widest label (#2458), and gives a row a small reset icon
// before its percent for the reset time. A surface that has a session window draws it as a ring round today's letter
// rather than as a row (#2473). A calendar month is read like a week (#2532): one calendar week of its days at a time,
// with a control on each side to move between the weeks, a line under the row for the days late or ahead and the share
// lost, and the lost days hatched at the end of the window.

import { cn, makeIconClass } from "@/util/util";
import { autoUpdate, flip, FloatingPortal, offset, shift, useHover, useInteractions } from "@floating-ui/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { CSSProperties, useState } from "react";
import { AiIcon } from "../ai-icon";
import { usageReasonText } from "../companion/companion-gauges-model";
import { relativeTime } from "../companion/companion-model";
import { useFloatingInPlace } from "../floating-in-place";
import { useLocale, useT } from "../i18n/i18n";
import { anchoredMenuEvent, buttonMenuAnchor } from "../menu/menu-anchor";
import { hasProviderMark, ProviderMark } from "../provider-marks/provider-mark";
import {
    currentWeekIndex,
    DayCell,
    legendColours,
    lineCells,
    lineDayFiguresText,
    paceColour,
    PaceNote,
    paceNote,
    PaceRedAt,
    percentText,
    resetDay,
    stepWeek,
    UnusedBlueFrom,
    UsageWeekLine,
    weekCaption,
    weekdayIndex,
    WeekDayKeys,
    windowWeeks,
    WindowWeeks,
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
    // A small dimmed second line under the label, what the window is over ("over the month", #2532).
    sublabel?: string;
    // A small dimmed count before the percent ("29 d" to a monthly reset, #2451); its title says the date. It replaces
    // the reset day in the row's accessible name.
    chip?: { text: string; title: string };
    // The row's tooltip, for a surface that has more to say about a window than the grid.
    title?: string;
    // When the window resets, in words ("Resets Thu 14:55"): a small icon before the percent (#2458) whose popover says
    // it, reached from the keyboard. It is the row's own element, so the row becomes a group, not an image.
    reset?: string;
    // A plain gauge's reset, short ("in 1 h 20 min"), at the end of its bar (#2451).
    resets?: string;
};

// A session window drawn as a ring round today's day letter (#2473) instead of a row of its own: how far it fills (0 to
// 100) and in which colour, its popover (two lines, with the figure the first one puts in the ring's colour) and its
// accessible name. The surface words them: the grid only draws.
export type UsageWeekSession = { percent: number; colour: string; tip: string; figure: string; name: string };

// How long the pointer rests on a logo before its name shows.
const NameDelayMs = 300;

// The slot of a logo in px (the logo's cell is 18 px wide and high): the mark fits it, as Claude's always did.
const LogoSlot = 17;

// The event a row's menu gets from its logo's button: Enter or Space is a click at 0, 0, which would put the menu in the
// window's corner, so it opens under the button and, as a keyboard opening, focuses its first entry (#1439).
export function openRowMenu(e: React.MouseEvent): React.MouseEvent {
    return anchoredMenuEvent(e, buttonMenuAnchor(e.currentTarget));
}

// The agents that have a mark in the shared set of provider marks (#2542) show their provider's own mark; the others show
// the AI icon. A small popover names the agent, since not everyone knows every provider's logo: after a short rest of the pointer, or
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
    const marked = hasProviderMark(agent);
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
        "data-logo": marked ? agent : "ai",
        "data-name": displayName,
    };
    const icon = marked ? (
        <ProviderMark agent={agent} slot={LogoSlot} />
    ) : (
        <i className={makeIconClass(AiIcon, true)} />
    );
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

// The two lines that say which calendar week a monthly row shows ("Week 2 of 5", "8–14 Jan").
type WeekCaptionText = { count: string; range: string };

function WeekCaption({ caption }: { caption: WeekCaptionText }) {
    return (
        <span className="mt-uw-weeks" data-testid="usage-week-weeks">
            <span>{caption.count}</span>
            <span>{caption.range}</span>
        </span>
    );
}

// What starts a row: the label of its window when the row has one, else the agent's logo. A monthly row's caption goes
// under its label (a row led by a logo has no room for it: its caption starts its line under the row).
function RowLead({ row, caption }: { row: UsageWeekRow; caption?: WeekCaptionText }) {
    if (row.label == null) {
        return <AgentLogo agent={row.agent} name={row.name} windowLabel={row.windowLabel} onMenu={row.onContextMenu} />;
    }
    return (
        <span className="mt-uw-label" data-testid="usage-week-label">
            {row.label}
            {row.sublabel ? (
                <span className="mt-uw-label-sub" data-testid="usage-week-sublabel">
                    {row.sublabel}
                </span>
            ) : null}
            {caption ? <WeekCaption caption={caption} /> : null}
        </span>
    );
}

// The week a monthly row shows: the developer's pick while it belongs to the window running (a pick made before the
// window is known, `reset` absent, belongs to it), else the week holding today.
type WeekPick = { reset?: number; index: number };

type RowWeeks = { weeks: WindowWeeks; index: number };

function rowWeeks(line: UsageWeekLine, now: number, pick: WeekPick | undefined): RowWeeks | null {
    if (!line.span?.monthly) {
        return null;
    }
    const weeks = windowWeeks(line.span);
    const picked = pick != null && (pick.reset == null || pick.reset === line.resetsAt) ? pick.index : null;
    return { weeks, index: Math.min(weeks.count - 1, Math.max(0, picked ?? currentWeekIndex(weeks, now))) };
}

function WeekButton({ dir, disabled, onClick }: { dir: "prev" | "next"; disabled: boolean; onClick: () => void }) {
    const t = useT();
    const Chevron = dir === "prev" ? ChevronLeft : ChevronRight;
    const label = t(dir === "prev" ? "usageWeek.weekPrevious" : "usageWeek.weekNext");
    return (
        <button
            type="button"
            className="mt-uw-nav"
            aria-label={label}
            data-tip={label}
            disabled={disabled}
            data-testid={`usage-week-${dir}`}
            onClick={onClick}
        >
            <Chevron size={12} aria-hidden="true" />
        </button>
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
// decoration for the eye: the row's accessible name already carries the percent. Each cell is a container of its own
// width, which is its block's: the figure inside leaves when the block is too narrow for it (usage-week.css), whatever
// the width of the label column and of the percent's.
function DayFigures({ cells, nav }: { cells: DayCell[]; nav: boolean }) {
    const t = useT();
    return (
        <>
            <span className="mt-uw-share-pad" aria-hidden />
            {nav ? <span className="mt-uw-share-pad" aria-hidden /> : null}
            {cells.map((cell, i) =>
                cell.share == null ? (
                    <span key={i} className="mt-uw-share" aria-hidden data-testid="usage-week-share" data-out="true" />
                ) : cell.lost >= 1 ? (
                    <span
                        key={i}
                        className="mt-uw-share is-lost"
                        aria-hidden
                        data-testid="usage-week-share"
                        data-lost="true"
                    >
                        <span className="mt-uw-fig">{t("usageWeek.dayLostFigure")}</span>
                    </span>
                ) : (
                    <span
                        key={i}
                        className="mt-uw-share"
                        aria-hidden
                        data-testid="usage-week-share"
                        data-share={cell.share}
                    >
                        <span className="mt-uw-fig">
                            {cell.share}
                            <span className="mt-uw-unit">{t("usageWeek.dayUnit")}</span>
                        </span>
                    </span>
                )
            )}
            {nav ? <span className="mt-uw-share-pad" aria-hidden /> : null}
            <span className="mt-uw-share-pad" aria-hidden />
        </>
    );
}

// The line under a row (#2532): the calendar week a monthly row shows when a logo leads it, then how late or ahead the
// row is in days, then the share lost. It spans the grid and sits at its right.
function PaceLine({ note, caption }: { note: PaceNote | null; caption?: WeekCaptionText }) {
    if (note == null && caption == null) {
        return null;
    }
    return (
        <span
            className="mt-uw-pace-note"
            data-testid="usage-week-pace-note"
            data-lost={note?.lost ? "true" : undefined}
        >
            {caption ? (
                <span className="mt-uw-pace-weeks" data-testid="usage-week-weeks">
                    {caption.count} · {caption.range}
                </span>
            ) : null}
            {note ? (
                <span className="mt-uw-pace-text">
                    <span data-testid="usage-week-late">{note.pace}</span>
                    {note.lost ? (
                        <>
                            {" · "}
                            <span className="mt-uw-lost-text" data-testid="usage-week-lost">
                                {note.lost}
                            </span>
                        </>
                    ) : null}
                </span>
            ) : null}
        </span>
    );
}

// The session ring (#2473): a thin circle round today's letter, its track the neutral line, its fill running clockwise
// from 12 o'clock (usage-week.css) by the share used, in the pace colour of the rows. It stands on the letter without
// taking any room of its own. Focusable, so its popover is not for the pointer alone, and named by the same words.
function SessionRing({ session, popovers }: { session: UsageWeekSession; popovers?: boolean }) {
    const fill = Math.min(100, Math.max(0, session.percent));
    return (
        <span
            className="mt-uw-ring"
            role="img"
            tabIndex={0}
            aria-label={session.name}
            title={popovers ? undefined : session.tip}
            data-tip={popovers ? session.tip : undefined}
            data-tip-accent={popovers ? session.figure : undefined}
            data-tip-accent-colour={popovers ? session.colour : undefined}
            style={{ "--mt-uw-ring-colour": session.colour } as CSSProperties}
            data-percent={Math.round(fill * 10) / 10}
            data-testid="usage-week-session"
        >
            <svg viewBox="0 0 17 17" aria-hidden="true" focusable="false">
                <circle className="mt-uw-ring-track" cx="8.5" cy="8.5" r="7.5" />
                <circle
                    className="mt-uw-ring-fill"
                    cx="8.5"
                    cy="8.5"
                    r="7.5"
                    pathLength="100"
                    style={{ strokeDasharray: `${Math.round(fill * 10) / 10} 100` }}
                />
            </svg>
        </span>
    );
}

// The reset time as a small icon (#2458), in place of a line of words under the row: the companion's popover says it
// on hover and on keyboard focus, and the icon is named by the same words. Focusable, so the popover is not for the
// pointer alone.
function ResetIcon({ text, popovers }: { text: string; popovers?: boolean }) {
    return (
        <span
            className="mt-uw-reset"
            role="img"
            tabIndex={0}
            aria-label={text}
            title={popovers ? undefined : text}
            data-tip={popovers ? text : undefined}
            data-testid="usage-week-reset"
        >
            <i className="fa fa-solid fa-rotate-left" aria-hidden="true" />
        </span>
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

// minimal is the form of #2450: the rows and nothing else, with no legend or line under them. Its rows keep their day
// initials on top and their figures under the blocks (#2458), but its accessible names also carry the figure of each
// day, for the form is the one a surface draws in a narrow place, where the figures may not fit; a surface that wants
// more in a tooltip gives the row its title.
export function UsageWeekGrid({
    rows,
    now,
    legend,
    dayFigures,
    minimal,
    popovers,
    session,
    initialWeeks,
}: {
    rows: UsageWeekRow[];
    now: number;
    legend?: boolean;
    dayFigures?: boolean;
    minimal?: boolean;
    // The session window as a ring round today's letter (#2473); none without a session window to show.
    session?: UsageWeekSession;
    // The titles of the rows and of the legend are said by a panel's popovers (data-tip, the companion's) instead of the
    // system tooltip.
    popovers?: boolean;
    // The week (0 for the first) each monthly row opens on, by row key, in place of the week holding today (#2532): the
    // preview server's way of showing each week, and the tests'.
    initialWeeks?: Record<string, number>;
}) {
    const t = useT();
    const locale = useLocale();
    // The week each monthly row shows, once the developer moved it (#2532); none moved, each shows the week of today.
    const [picks, setPicks] = useState<Record<string, WeekPick>>(() =>
        Object.fromEntries(Object.entries(initialWeeks ?? {}).map(([key, index]) => [key, { index }]))
    );
    const today = weekdayIndex(now);
    const labelled = rows.some((row) => row.label != null);
    // A grid with a monthly row has a column for its two controls on either side of the blocks, in every row.
    const nav = rows.some((row) => row.line != null && !row.line.plain && row.line.span?.monthly);
    return (
        <span
            className="mt-uw"
            data-labelled={labelled ? "true" : undefined}
            data-figures={dayFigures ? "true" : undefined}
            data-minimal={minimal ? "true" : undefined}
            data-nav={nav ? "true" : undefined}
            data-testid="usage-week"
        >
            <span aria-hidden />
            {nav ? <span aria-hidden /> : null}
            {WeekDayKeys.map((key, i) => {
                const ringed = session != null && i === today;
                return (
                    <span
                        key={key}
                        className="mt-uw-day"
                        aria-hidden={ringed ? undefined : true}
                        data-testid="usage-week-day"
                        data-today={i === today ? "true" : undefined}
                        data-ringed={ringed ? "true" : undefined}
                    >
                        {ringed ? (
                            <>
                                <span aria-hidden>{t(`usageWeek.day.${key}`)}</span>
                                <SessionRing session={session} popovers={popovers} />
                            </>
                        ) : (
                            t(`usageWeek.day.${key}`)
                        )}
                    </span>
                );
            })}
            {nav ? <span aria-hidden /> : null}
            <span aria-hidden />
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
                const pager = line.plain ? null : rowWeeks(line, now, picks[row.key]);
                const caption = pager ? weekCaption(pager.weeks, pager.index) : undefined;
                const note = line.plain || row.stale ? null : paceNote(line);
                const cells = line.plain ? [] : lineCells(line, now, pager?.index);
                const parts = [
                    day && !line.plain && row.chip == null
                        ? t("usageWeek.rowReset", { name: displayName, percent, day })
                        : t("usageWeek.row", { name: displayName, percent }),
                ];
                if (row.chip) {
                    parts.push(row.chip.title);
                }
                if (line.plain && row.resets) {
                    parts.push(row.resets);
                }
                if (caption) {
                    parts.push(t("usageWeek.weekCaption", { count: caption.count, range: caption.range }));
                }
                if (minimal && !line.plain) {
                    parts.push(t("usageWeek.rowDays", { days: lineDayFiguresText(line, now, pager?.index) }));
                }
                if (note) {
                    parts.push(note.pace);
                    if (note.lost) {
                        parts.push(note.lost);
                    }
                }
                if (age) {
                    parts.push(t("usageWeek.rowAsOf", { ago: age }));
                }
                const hasReset = !line.plain && !!row.reset;
                const percentEl = (
                    <b className="mt-uw-pct" data-testid="usage-week-percent">
                        {percent}
                    </b>
                );
                const moveTo = (index: number) => setPicks({ ...picks, [row.key]: { reset: line.resetsAt, index } });
                return (
                    <span
                        key={row.key}
                        className="mt-uw-row"
                        role={row.onContextMenu || hasReset || pager ? "group" : "img"}
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
                        data-monthly={pager ? "true" : undefined}
                        data-week={pager ? pager.index + 1 : undefined}
                        onContextMenu={row.onContextMenu}
                    >
                        <RowLead row={row} caption={row.label != null ? caption : undefined} />
                        {nav ? (
                            pager ? (
                                <WeekButton
                                    dir="prev"
                                    disabled={pager.index <= 0}
                                    onClick={() => moveTo(stepWeek(pager.index, pager.weeks.count, "prev"))}
                                />
                            ) : (
                                <span aria-hidden />
                            )
                        ) : null}
                        {line.plain ? (
                            <PlainGauge line={line} resets={row.resets} />
                        ) : (
                            cells.map((cell, i) => (
                                <span
                                    key={i}
                                    className={cn(
                                        "mt-uw-cell",
                                        cell.today && "is-today",
                                        cell.reset && "is-reset",
                                        cell.out && "is-out"
                                    )}
                                    data-testid="usage-week-block"
                                    data-today={cell.today ? "true" : undefined}
                                    data-reset={cell.reset ? "true" : undefined}
                                    data-out={cell.out ? "true" : undefined}
                                    data-lost={cell.lost > 0 ? Math.round(cell.lost * 100) / 100 : undefined}
                                >
                                    <i style={{ width: `${Math.round(cell.fill * 1000) / 10}%` }} />
                                    {cell.lost > 0 ? (
                                        <b
                                            className="mt-uw-lost"
                                            style={{ width: `${Math.round(cell.lost * 1000) / 10}%` }}
                                        />
                                    ) : null}
                                </span>
                            ))
                        )}
                        {nav ? (
                            pager ? (
                                <WeekButton
                                    dir="next"
                                    disabled={pager.index >= pager.weeks.count - 1}
                                    onClick={() => moveTo(stepWeek(pager.index, pager.weeks.count, "next"))}
                                />
                            ) : (
                                <span aria-hidden />
                            )
                        ) : null}
                        {row.chip || hasReset ? (
                            <span className="mt-uw-pct-chipped">
                                {hasReset ? <ResetIcon text={row.reset} popovers={popovers} /> : null}
                                {row.chip ? (
                                    <span
                                        className="mt-uw-chip"
                                        title={popovers ? undefined : row.chip.title}
                                        data-tip={popovers ? row.chip.title : undefined}
                                        data-testid="usage-week-chip"
                                    >
                                        {row.chip.text}
                                    </span>
                                ) : null}
                                {percentEl}
                            </span>
                        ) : (
                            percentEl
                        )}
                        {dayFigures && !line.plain ? <DayFigures cells={cells} nav={nav} /> : null}
                        <PaceLine note={note} caption={row.label == null ? caption : undefined} />
                        {row.stale ? (
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
