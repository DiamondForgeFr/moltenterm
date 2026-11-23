// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage gauges of the agent companion (FR-SHELL-027, DS-SHELL-030): what wavesrv reads of an agent's plan
// limits (pkg/molten/usage) and the pure rules of their section. Pure, so they are tested without a window.

import { getLocale, t } from "../i18n/i18n";
import {
    isWeekWindow,
    lineDayFiguresText,
    MonthWindowId,
    paceColour,
    percentText,
    SessionWindowId,
    UsageWeekLine,
    usageWeekLine,
    weekdayIndex,
} from "../usage-week/usage-week-model";
import { relativeTime } from "./companion-model";

// must match pkg/molten/usage/usage.go and pkg/molten/companion/usage.go
// deduced and days: a week MoltenTerm deduces from the month (#2451), each day's use in percent of a seventh of it.
export type UsageWindow = {
    id: string;
    label: string;
    usedpercent: number;
    resetsat?: number;
    windowmins?: number;
    deduced?: boolean;
    days?: number[];
};
export type UsageMonthlySpend = { used: number; limit: number; limitenabled: boolean; unit?: string };
// Codex gives a balance (as text) or unlimited credits instead of used and limit. Kimi adds monthly spending.
export type UsageCredits = {
    enabled: boolean;
    used: number;
    limit: number;
    unit?: string;
    balance?: string;
    unlimited?: boolean;
    monthly?: UsageMonthlySpend;
};
export type UsageSnapshot = {
    agent: string;
    source: string;
    plan?: string;
    windows?: UsageWindow[];
    credits?: UsageCredits;
    readat: number;
    // Why the source kept its last reading instead of a fresh one ("tokenexpired", #2451).
    stale?: UsageReason;
};
export type UsageSetup = { source: string; file: string; current?: string; language: string; snippet: string };
export type UsageReason =
    | "notsetup"
    | "waiting"
    | "noplan"
    | "format"
    | "expired"
    | "failed"
    | "signedout"
    | "tokenexpired"
    | "denied"
    | "ratelimited"
    | "offline"
    | "unsupported";
// The agent's experimental source (FR-SHELL-028): offered only while its gauges are on.
export type UsageExperimental = { source: string; name: string; on: boolean; store: string; reason?: UsageReason };
export type CompanionUsageInfo = {
    blockid: string;
    // The reading of the whole app, without a block (#2074).
    global?: boolean;
    agent: string;
    pageurl: string;
    pagename: string;
    hasgauges?: boolean;
    gauges: "enabled" | "off" | "unavailable";
    sourcename?: string;
    reason?: UsageReason;
    setup?: UsageSetup;
    snapshot?: UsageSnapshot;
    experimental?: UsageExperimental;
    // How often a visible companion asks again while a source that wavesrv does not push is on.
    refreshms?: number;
};

// The plain words of an unavailable source, shown as the muted line's tooltip (companion.gauges.reason.*).
export const UsageReasons: UsageReason[] = [
    "notsetup",
    "waiting",
    "noplan",
    "format",
    "expired",
    "failed",
    "signedout",
    "tokenexpired",
    "denied",
    "ratelimited",
    "offline",
    "unsupported",
];

// Codex's sources are its session log and its app-server (FR-SHELL-029): their own words where Claude Code's differ.
const AgentReasons: Record<string, UsageReason[]> = {
    codex: ["waiting", "noplan", "expired"],
    kimi: ["noplan", "unsupported"],
};

export function usageReasonText(reason: string, agent?: string): string {
    if (AgentReasons[agent]?.includes(reason as UsageReason)) {
        return t(`companion.gauges.reason.${agent}.${reason}`);
    }
    const known = UsageReasons.includes(reason as UsageReason) ? reason : "failed";
    return t(`companion.gauges.reason.${known}`);
}

// The ids of the gauges sources (pkg/molten/usage, GaugesSource.Id). wavesrv names a source in English, for the agents
// and the logs that read it; the section names it from its id, in the interface language (#2123).
export const UsageSourceIds = [
    "claude-statusline",
    "claude-oauth",
    "codex-transcript",
    "codex-appserver",
    "kimi-oauth",
];

// The source's name in the interface language; `given` (wavesrv's own) stands in for an id this window does not know.
export function usageSourceName(id: string, given = ""): string {
    return UsageSourceIds.includes(id) ? t(`companion.gauges.source.${id}`) : given;
}

// The sources a reading came from ("ligne d'état de Claude Code et service d'utilisation d'Anthropic"): the ids of its
// merged snapshot, in the order wavesrv merged them. When one is unknown the whole line stays as wavesrv worded it,
// rather than a half-translated list.
export function usageSourcesText(info: CompanionUsageInfo): string {
    const ids = (info?.snapshot?.source ?? "").split(",").filter((id) => id !== "");
    if (ids.length === 0 || !ids.every((id) => UsageSourceIds.includes(id))) {
        return info?.sourcename ?? "";
    }
    const names = ids.map((id) => usageSourceName(id));
    if (names.length === 1) {
        return names[0];
    }
    return t("companion.gauges.sourceAnd", { list: names.slice(0, -1).join(", "), last: names[names.length - 1] });
}

export type GaugeLevel = "normal" | "warning" | "error";

// percentShort and resetsShort: the words of a one-line list ("23.5 %", "in 2 h"). `line` is what the week grid draws
// for the window (#2102) and `shortLabel` its name when the room is short ("Week (Opus)").
export type GaugeRow = {
    id: string;
    label: string;
    shortLabel: string;
    percent: string;
    percentShort: string;
    bar: number;
    level: GaugeLevel;
    resets: string;
    resetsShort: string;
    line: UsageWeekLine;
    // How the row is computed, when MoltenTerm deduced it (#2451).
    explain: string;
    // The narrow column's second line, for a deduced row ("from the month", #2451); "" otherwise.
    subLabel: string;
    // A deduced week's count to the monthly reset ("29 d", "5 h") and its exact date in words; absent otherwise.
    countdown?: { text: string; title: string };
};

// A usage window the developer can show or hide (#2462): its key, its name as the block shows it, and whether its row shows.
export type UsageWindowChoice = { id: string; label: string; shown: boolean };

// The session window as it draws (#2473): not a row but a ring round today's day letter. `percent` is how far the ring
// fills (0 to 100) and `colour` the pace colour the week bars take for the same use. `tip` is its popover, two lines
// joined by a line break ("Session used: 72 %", "Resets in 1 h 48 min (at 15:20)"), `figure` the part of the first line
// the popover puts in `colour`, and `name` the ring's accessible name.
export type SessionRing = { percent: number; colour: string; tip: string; figure: string; name: string };

export type GaugesView =
    | { kind: "hidden" }
    | { kind: "off" }
    | { kind: "setup"; setup: UsageSetup }
    | { kind: "unavailable"; reason: string }
    | {
          kind: "enabled";
          agent: string;
          now: number;
          // The rows that show. gaugesView gives every window; withRowChoice (companion-usage-rows-model.ts) leaves the
          // ones the developer chose to show, and says which windows there were. The session is one of them until
          // withSessionRing takes it out of the rows to draw it as a ring (#2473).
          rows: GaugeRow[];
          listed?: UsageWindowChoice[];
          session?: SessionRing;
          source: string;
          age: string;
          credits: string;
          // The plain line of a reading kept because no fresh one could be read (#2451), with its age; "" otherwise.
          stale?: string;
      };

export function gaugeLevel(percent: number): GaugeLevel {
    if (percent >= 95) {
        return "error";
    }
    if (percent >= 80) {
        return "warning";
    }
    return "normal";
}

// Shown as given, to one decimal at most; only the bar is clamped.
export function gaugePercent(percent: number): string {
    return t("companion.gauges.percentUsed", { percent: Math.round(percent * 10) / 10 });
}

function weekdayName(d: Date): string {
    return d.toLocaleDateString(getLocale(), { weekday: "short" });
}

function monthName(d: Date): string {
    return d.toLocaleDateString(getLocale(), { month: "short" });
}

const HourMs = 3600 * 1000;

function clockTime(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// "Resets in 2 h 14 min" under 24 h; beyond, the weekday and time, with the date when the weekday alone could mean
// this week's or next week's.
export function resetText(resetsAt: number, now: number): string {
    return resetWords(resetsAt, now, false);
}

// The compact line's reset: "in 2 h 14 min", "Fri 10:00".
export function resetShortText(resetsAt: number, now: number): string {
    return resetWords(resetsAt, now, true);
}

// The time left as a count: "45 min", "3 h", "2 h 14 min".
function delayWords(ms: number): string {
    const mins = Math.ceil(ms / 60000);
    if (mins < 60) {
        return `${mins} min`;
    }
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function resetWords(resetsAt: number, now: number, short: boolean): string {
    const ms = (resetsAt || 0) - now;
    if (!resetsAt || ms <= 0) {
        return "";
    }
    const inDelay = (delay: string) => t(short ? "companion.gauges.inDelay" : "companion.gauges.resetsIn", { delay });
    const at = (when: string) => (short ? when : t("companion.gauges.resetsAt", { when }));
    if (ms < 24 * HourMs) {
        return inDelay(delayWords(ms));
    }
    const d = new Date(resetsAt);
    if (ms < 6 * 24 * HourMs) {
        return at(`${weekdayName(d)} ${clockTime(d)}`);
    }
    return at(`${weekdayName(d)} ${d.getDate()} ${monthName(d)}, ${clockTime(d)}`);
}

const WindowLabelNames: Record<string, string> = {
    "Current session": "session",
    "This week": "week",
    "This month": "month",
    "Spend limit": "spend",
    "Week (from the month)": "weekDeduced",
};

// The readers name a window in English ("This week", "This week (Opus)", "5-hour", "GPT-5 5-hour"): the words they
// send are mapped to keys here, so every surface shows the translation (FR-I18N-001). A label that matches none is
// shown as the reader gave it. `short` gives the form for a narrow column ("Week (Opus)"): a duration is short already.
function windowWords(label: string, short: boolean): string {
    const text = (label || "").trim();
    const group = short ? "companion.gauges.windowShort" : "companion.gauges.window";
    const fixed = WindowLabelNames[text];
    if (fixed != null) {
        return t(`${group}.${fixed}`);
    }
    const model = /^This week \((.+)\)$/.exec(text);
    if (model != null) {
        return t(`${group}.model`, { name: model[1] });
    }
    const duration = /^(\d+)-(hour|day|min)$/.exec(text);
    if (duration != null) {
        return t(`companion.gauges.window.${duration[2]}`, { count: duration[1] });
    }
    const extra = /^(.+) (5-hour|This week|\d+-(?:hour|day|min))$/.exec(text);
    if (extra != null) {
        // A model's week is the model alone in a narrow column, as the window of a model is (#2473).
        if (short && extra[2] === "This week") {
            return extra[1];
        }
        return t("companion.gauges.window.extra", { name: extra[1], window: windowWords(extra[2], short) });
    }
    return text;
}

export function usageWindowLabel(label: string): string {
    return windowWords(label, false);
}

// The window's name for a narrow column, as the companion's week grid labels its rows (#2102).
export function usageWindowShortLabel(label: string): string {
    return windowWords(label, true);
}

// The line of a row's tooltip that tells the figure of each day, for a grid too narrow to draw them (#2450, #2458).
export function daysTitle(line: UsageWeekLine): string {
    return t("usageWeek.daysTitle", { days: lineDayFiguresText(line) });
}

// How a week deduced from the month is computed, for its row's tooltip (#2451); "" for any other window.
export function deducedTitle(window: UsageWindow): string {
    return window?.deduced ? t("companion.gauges.deducedExplain") : "";
}

const DayMs = 24 * HourMs;

// The count to a monthly reset (#2451): whole days ("29 d", as Kimi Code's own /status says "29d 5h"), hours under a
// day ("5 h"); its tooltip gives the date and time. Null without a reset to come.
export function monthCountdown(resetsAt: number, now: number): { text: string; title: string } {
    const ms = (resetsAt || 0) - now;
    if (!resetsAt || ms <= 0) {
        return null;
    }
    const d = new Date(resetsAt);
    const when = `${weekdayName(d)} ${d.getDate()} ${monthName(d)}, ${clockTime(d)}`;
    if (ms < DayMs) {
        const count = Math.max(1, Math.ceil(ms / HourMs));
        return {
            text: t("companion.gauges.countHours", { count }),
            title: t("companion.gauges.monthResetInHours", { count, when }),
        };
    }
    const count = Math.floor(ms / DayMs);
    return {
        text: t("companion.gauges.countDays", { count }),
        title: t(count === 1 ? "companion.gauges.monthResetInDay" : "companion.gauges.monthResetInDays", {
            count,
            when,
        }),
    };
}

// Monday 00:00 of the week holding `at`, local time.
function weekStart(at: number): number {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - weekdayIndex(d.getTime()));
    return d.getTime();
}

// A week deduced from the month (#2451) starts on Monday only for its calculation: what resets is the month. Its ring
// sits on the day the monthly window resets, and only in the week holding that day; its reset line and its count tell
// the month's reset.
function deducedWeekRow(row: GaugeRow, month: UsageWindow, now: number): GaugeRow {
    const resetsAt = month?.resetsat ?? 0;
    const from = weekStart(now);
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    const ring = resetsAt >= from && resetsAt < to.getTime() ? weekdayIndex(resetsAt) : -1;
    return {
        ...row,
        resets: resetText(resetsAt, now),
        resetsShort: resetShortText(resetsAt, now),
        line: { ...row.line, start: ring },
        countdown: monthCountdown(resetsAt, now) ?? undefined,
    };
}

// A window past its reset no longer holds: it is dropped between two reports, as wavesrv drops it.
export function gaugeRows(snapshot: UsageSnapshot, now: number): GaugeRow[] {
    const windows = (snapshot?.windows ?? []).filter(
        (w) => w != null && Number.isFinite(w.usedpercent) && !(w.resetsat > 0 && w.resetsat <= now)
    );
    const month = windows.find((w) => w.id === MonthWindowId);
    return windows.map((w) => {
        const row: GaugeRow = {
            id: w.id,
            label: usageWindowLabel(w.label) || w.id,
            shortLabel: usageWindowShortLabel(w.label) || w.id,
            percent: gaugePercent(w.usedpercent),
            percentShort: `${Math.round(w.usedpercent * 10) / 10} %`,
            bar: Math.min(100, Math.max(0, w.usedpercent)),
            level: gaugeLevel(w.usedpercent),
            resets: resetText(w.resetsat, now),
            resetsShort: resetShortText(w.resetsat, now),
            line: { ...usageWeekLine(w, now), plain: !isWeekWindow(w) },
            explain: deducedTitle(w),
            subLabel: w.deduced ? t("companion.gauges.windowShort.fromMonth") : "",
        };
        return w.deduced ? deducedWeekRow(row, month, now) : row;
    });
}

// "Resets in 1 h 48 min (at 15:20)": the session's reset, a count and the clock time it ends at; "" without a reset to come.
function sessionResetText(resetsAt: number, now: number): string {
    const ms = (resetsAt || 0) - now;
    if (!resetsAt || ms <= 0) {
        return "";
    }
    return t("companion.gauges.sessionRing.resets", {
        delay: delayWords(ms),
        time: clockTime(new Date(resetsAt)),
    });
}

// The ring a session window draws round today's letter (#2473). Its colour is the pace colour of the session's own
// window, the scale the week bars take, so a ring and a bar of the same pace read alike.
export function sessionRing(row: GaugeRow, now: number): SessionRing {
    const line = row.line;
    const figure = percentText(line);
    const lines = [
        t("companion.gauges.sessionRing.used", { percent: figure }),
        sessionResetText(line.resetsAt, now),
    ].filter((s) => !!s);
    return {
        percent: row.bar,
        colour: paceColour(line.pace, line.unused),
        tip: lines.join("\n"),
        figure,
        name: lines.join(". "),
    };
}

// The usage as it draws the session (#2473): out of the rows, into a ring. It is a view that kept the session in its
// rows (every window gaugesView gives, less those the developer hid) that becomes one with a ring and no session row; a
// view without a session row, which the developer hid or the provider does not report, has no ring.
export function withSessionRing(view: GaugesView): GaugesView {
    if (view.kind !== "enabled") {
        return view;
    }
    const session = view.rows.find((row) => row.id === SessionWindowId);
    if (session == null) {
        return view;
    }
    return { ...view, rows: view.rows.filter((row) => row !== session), session: sessionRing(session, view.now) };
}

function creditAmount(value: number, unit: string): string {
    if (unit && /^[A-Z]{3}$/.test(unit)) {
        try {
            return new Intl.NumberFormat("en-US", { style: "currency", currency: unit }).format(value);
        } catch {
            // An unknown currency code falls back to the plain number and the code.
        }
    }
    return unit ? `${value} ${unit}` : `${value}`;
}

export function creditsText(credits: UsageCredits): string {
    if (credits == null || !credits.enabled || !Number.isFinite(credits.used) || !Number.isFinite(credits.limit)) {
        return "";
    }
    if (credits.monthly != null) {
        const monthly = credits.monthly;
        if (!Number.isFinite(monthly.used) || !Number.isFinite(monthly.limit)) {
            return "";
        }
        const parts: string[] = [];
        if (credits.balance != null && credits.balance !== "") {
            const n = Number(credits.balance);
            const balance = Number.isFinite(n) ? creditAmount(n, credits.unit) : credits.balance;
            parts.push(t("companion.gauges.boosterBalance", { balance }));
        }
        const used = creditAmount(monthly.used, monthly.unit || credits.unit);
        const limited = monthly.limitenabled && monthly.limit > 0;
        parts.push(
            limited
                ? t("companion.gauges.monthlySpending", {
                      used,
                      limit: creditAmount(monthly.limit, monthly.unit || credits.unit),
                  })
                : t("companion.gauges.monthlySpendingUnlimited", { used })
        );
        return parts.join(" · ");
    }
    if (credits.unlimited) {
        return t("companion.gauges.creditsUnlimited");
    }
    if (credits.balance != null && credits.balance !== "") {
        const n = Number(credits.balance);
        const balance = Number.isFinite(n) ? String(Math.round(n * 100) / 100) : credits.balance;
        return t("companion.gauges.creditsLeft", { balance });
    }
    if (!credits.limit && !credits.used) {
        return t("companion.gauges.creditsAvailable");
    }
    return t("companion.gauges.extraUsage", {
        used: creditAmount(credits.used, credits.unit),
        limit: creditAmount(credits.limit, credits.unit),
    });
}

export type ExperimentalView =
    | { kind: "none" }
    | { kind: "off"; source: string; label: string; explanation: string; statement: string }
    | { kind: "on"; source: string; label: string; unavailable: string; reason: string };

export function experimentalLabel(): string {
    return t("companion.gauges.experimentalLabel");
}

export function experimentalExplanation(source = ""): string {
    return t(
        source === "kimi-oauth"
            ? "companion.gauges.kimi.experimentalExplanation"
            : "companion.gauges.experimentalExplanation"
    );
}

export function experimentalRowLabel(source = ""): string {
    return t(source === "kimi-oauth" ? "companion.gauges.kimi.rowLabel" : "companion.gauges.modelLimits");
}

export function experimentalUnavailableLabel(source = ""): string {
    return t(source === "kimi-oauth" ? "companion.gauges.kimi.unavailable" : "companion.gauges.modelLimitsUnavailable");
}

// The confirmation of FR-SHELL-028-AC1, naming where the token is read and exactly what the source supports.
export function experimentalStatement(store: string, source: string, sourceId = ""): string {
    const where = store || t("companion.gauges.tokenWhereDefault");
    const key =
        sourceId === "kimi-oauth"
            ? "companion.gauges.kimi.experimentalStatement"
            : "companion.gauges.experimentalStatement";
    return t(key, {
        where,
        source: source || t("companion.gauges.sourceDefault"),
    });
}

// The experimental source's row: offered while the gauges are on, its reason when it gives nothing.
export function experimentalView(info: CompanionUsageInfo): ExperimentalView {
    const exp = info?.experimental;
    if (exp == null || !info.hasgauges || info.gauges === "off") {
        return { kind: "none" };
    }
    if (!exp.on) {
        return {
            kind: "off",
            source: exp.source,
            label: experimentalRowLabel(exp.source),
            explanation: experimentalExplanation(exp.source),
            statement: experimentalStatement(exp.store, usageSourceName(exp.source, exp.name), exp.source),
        };
    }
    // Waiting is its first answer on the way, not a failure.
    const failed = exp.reason && exp.reason !== "waiting";
    return {
        kind: "on",
        source: exp.source,
        label: experimentalRowLabel(exp.source),
        unavailable: experimentalUnavailableLabel(exp.source),
        reason: failed ? usageReasonText(exp.reason, info.agent) : "",
    };
}

// What the plan usage section shows. Hidden for an agent without a gauges source; any failure is one muted line,
// never a dialog (NFR-SHELL-012).
export function gaugesView(info: CompanionUsageInfo, now: number): GaugesView {
    if (info == null || !info.hasgauges) {
        return { kind: "hidden" };
    }
    if (info.gauges === "off") {
        return { kind: "off" };
    }
    if (info.setup != null) {
        return { kind: "setup", setup: info.setup };
    }
    if (info.gauges !== "enabled") {
        return { kind: "unavailable", reason: usageReasonText(info.reason, info.agent) };
    }
    const rows = gaugeRows(info.snapshot, now);
    const credits = creditsText(info.snapshot?.credits);
    if (rows.length === 0 && !credits) {
        return { kind: "unavailable", reason: usageReasonText("expired", info.agent) };
    }
    const at = info.snapshot?.readat;
    const age = at ? t("companion.gauges.updated", { ago: relativeTime(at, now) }) : "";
    return {
        kind: "enabled",
        agent: info.agent,
        now,
        rows,
        source: usageSourcesText(info),
        age,
        credits,
        stale: staleText(info.snapshot?.stale, info.agent, at, now),
    };
}

// A kept reading says its age and when it comes back: the agent refreshes its own sign-in, MoltenTerm never does.
export function staleText(stale: string, agent: string, readAt: number, now: number): string {
    if (!stale) {
        return "";
    }
    const when = t(agent === "kimi" ? "companion.gauges.kimi.staleRefresh" : "companion.gauges.staleRefresh");
    return readAt > 0 ? t("companion.gauges.staleLine", { ago: relativeTime(readAt, now), when }) : when;
}

// must match usageStaleAfter in pkg/molten/companion/usage.go
export const UsageStaleMs = 5 * 60 * 1000;

// A source that calls out or starts a process is read only for a window that shows (NFR-SHELL-013): wavesrv takes the
// flag as the window's visibility and pauses its automatic reads while it is false.
export function usageReadFor(visibilityState: string): { fetch: boolean } {
    return { fetch: visibilityState === "visible" };
}

// Values that stopped coming may be those of a relay the user removed: the section asks again, and wavesrv looks,
// read-only, whether the settings still run it.
export function usageStale(info: CompanionUsageInfo, now: number): boolean {
    const at = info?.gauges === "enabled" ? info.snapshot?.readat : 0;
    return at > 0 && now - at > UsageStaleMs;
}

// An event or an answer is for this terminal's companion only.
export function usageFor(info: CompanionUsageInfo, target: string, agent: string): boolean {
    return info != null && info.blockid === target && (!agent || info.agent === agent);
}
