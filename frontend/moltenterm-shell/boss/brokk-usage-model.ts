// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage Brokk's group tells (FR-BOSS-009, AC17 and AC20, FR-BOSS-006, #2032): under the square, a week grid with
// the main window of each provider that shares a reading (AC48 to AC51, #2100, the shared usage-week grid); behind a
// click on that block, the detail of every window the former Usage tab listed. The providers come most recently used
// first, a provider with no use within the window set in Settings (#2431) is left out and listed apart, and a
// reading too old to be current never looks live (AC93 to AC98, #2341). Pure, so the rules are tested without a window.
//
// It loads on demand, with the usage block of the group (brokk-usage-block.tsx) and the hub's usage visit
// (brokk-usage-visit.ts), outside the JavaScript every view loads up front (NFR-PERF-003, bundle.initialJsMB): what the
// hub reads at start is brokk-usage-choice.ts's.

import { inUseWithin } from "../agent-info/providers-in-use";
import { GaugeRow, gaugeRows, UsageSnapshot } from "../companion/companion-gauges-model";
import { mainWindow, UsageWeekLine, usageWeekLine } from "../usage-week/usage-week-model";
import { isStale, UseWindowMs } from "../usage-week/usage-week-stale";
import type { UsageReadings, UsageUnreadable } from "./boss-usage";
import { choiceOf, choicesOf, type UsageChoice, type UsageChoices } from "./brokk-usage-choice";

// The 7 days of AC95 and AC96, and the rule of a stale reading (usage-week-stale.ts).
export { isStale, readingStale, staleAfterMs, UseWindowMs } from "../usage-week/usage-week-stale";

// What an agent was used over the last 7 days, as wavesrv's recorder tells it (pkg/molten/agentuse).
export type AgentUse = {
    // The time its agents spent working, in ms.
    workms: number;
    sessions: number;
    // The last moment one of them worked or started (Unix ms).
    lastat: number;
};

// must match pkg/molten/agentuse
export type AgentUseSummary = { at: number; agents: Record<string, AgentUse> };

export { choiceOf, choicesOf };
export type { UsageChoice, UsageChoices };

// `use`: the agents' use by id; null before wavesrv has told it, when nothing can be said to be unused. `windowMs`: the
// window of recent use the developer set in Settings (#2431), 7 days when unset.
export type UsageContext = { use?: Record<string, AgentUse>; choices?: UsageChoices; windowMs?: number };

const NoUse: AgentUse = { workms: 0, sessions: 0, lastat: 0 };

// The choices with one provider's changed: "show" and "hide" exclude each other, "auto" gives it back to the rules.
export function withChoice(choices: UsageChoices, provider: string, choice: UsageChoice): UsageChoices {
    const show = (choices?.show ?? []).filter((id) => id !== provider);
    const hide = (choices?.hide ?? []).filter((id) => id !== provider);
    if (choice === "show") {
        show.push(provider);
    }
    if (choice === "hide") {
        hide.push(provider);
    }
    return { show, hide };
}

export type PlanKind = "paid" | "free" | "unknown";

// A plan the reading names as not paid. No reader states when a plan ends and MoltenTerm reads no credential for it, so a
// lapsed subscription shows when the reading itself says the plan is free.
const NotPaidPlan = /^(free|guest|none|expired|ended|cancel+ed)(?![a-z0-9])/;

// What a reading's plan says of the subscription: its name is the freshest local source there is (Codex's own limits
// carry it); Claude Code's readings carry none.
export function planKind(plan: string): PlanKind {
    const name = (plan ?? "").trim().toLowerCase();
    if (name === "" || name === "unknown") {
        return "unknown";
    }
    return NotPaidPlan.test(name) ? "free" : "paid";
}

export type HiddenReason = "chosen" | "unused";

// The last trace of a provider's use (Unix ms): its agents' last work or start, or its last reading, 0 when none.
function lastUseOf(ctx: UsageContext, provider: string, readAt: number): number {
    return Math.max(ctx?.use?.[provider]?.lastat ?? 0, readAt ?? 0);
}

// Why the grid leaves a provider out, "" when it shows: the developer's choice first; then no use and no reading within
// the window set in Settings (#2431) on a plan that is not paid (an unknown plan is not paid, since its last reading is
// then older than the window). A paid plan stays (#2341). An unknown use hides nothing: it is not the same as unused.
export function hiddenReason(
    provider: string,
    plan: string,
    readAt: number,
    ctx: UsageContext,
    now: number
): HiddenReason | "" {
    const choice = choiceOf(ctx?.choices, provider);
    if (choice === "show") {
        return "";
    }
    if (choice === "hide") {
        return "chosen";
    }
    if (ctx?.use == null) {
        return "";
    }
    const windowMs = ctx.windowMs ?? UseWindowMs;
    if (inUseWithin(lastUseOf(ctx, provider, readAt), now, windowMs)) {
        return "";
    }
    return planKind(plan) === "paid" ? "" : "unused";
}

export type UsageProvider = {
    // The provider's id: the agent whose reading it is.
    id: string;
    plan: string;
    rows: GaugeRow[];
    // The fullest window, to rank providers.
    fullest: number;
    // When its reading was taken (Unix ms), 0 when unknown: one of the traces that rank it by last use.
    readAt: number;
};

// The latest reading of each provider: several agents of one provider share its plan (FR-SHELL-027).
function latestByProvider(readings: UsageReadings): Map<string, UsageSnapshot> {
    const latest = new Map<string, UsageSnapshot>();
    for (const [agent, snapshot] of Object.entries(readings ?? {})) {
        if (snapshot == null) {
            continue;
        }
        const provider = snapshot.agent || agent;
        const held = latest.get(provider);
        if (held == null || (snapshot.readat ?? 0) > (held.readat ?? 0)) {
            latest.set(provider, snapshot);
        }
    }
    return latest;
}

type Ranked = { id: string; fullness: number; readAt: number };

// The order of the grid (AC93, #2431): the most recently used first, by the last trace of its use (work, start or
// reading); then the time its agents worked over the window, then its sessions (an agent that reports nothing of its
// work has no time), then the fullest window, then by name.
function byUse(ctx: UsageContext, a: Ranked, b: Ranked): number {
    const ua = ctx?.use?.[a.id] ?? NoUse;
    const ub = ctx?.use?.[b.id] ?? NoUse;
    return (
        lastUseOf(ctx, b.id, b.readAt) - lastUseOf(ctx, a.id, a.readAt) ||
        ub.workms - ua.workms ||
        ub.sessions - ua.sessions ||
        b.fullness - a.fullness ||
        (a.id < b.id ? -1 : 1)
    );
}

// One entry per provider that gave a reading with a window still running and that the grid shows, the most recently
// used first: the detail panel.
export function usageProviders(readings: UsageReadings, now: number, ctx?: UsageContext): UsageProvider[] {
    const providers: UsageProvider[] = [];
    for (const [id, snapshot] of latestByProvider(readings)) {
        const rows = gaugeRows(snapshot, now);
        const readAt = snapshot.readat ?? 0;
        if (rows.length === 0 || hiddenReason(id, snapshot.plan ?? "", readAt, ctx, now) !== "") {
            continue;
        }
        providers.push({
            id,
            plan: snapshot.plan ?? "",
            rows,
            fullest: Math.max(...rows.map((row) => row.bar)),
            readAt,
        });
    }
    const ranked = (p: UsageProvider): Ranked => ({ id: p.id, fullness: p.fullest, readAt: p.readAt });
    return providers.sort((a, b) => byUse(ctx, ranked(a), ranked(b)));
}

// A reading older than this shows its age beside its percent (#2074).
export const UsageOldMs = 60 * 60 * 1000;

// A provider's line in the week grid: its main window's, with the reading's age.
export type WeeklyUsage = UsageWeekLine & {
    provider: string;
    // The selected main window, before its raw label is localized for the interface.
    windowId?: string;
    windowLabel?: string;
    // When the reading was taken (Unix ms), 0 when unknown.
    readAt: number;
    // The reading is older than UsageOldMs: its age is told.
    old: boolean;
    // The reading is older than its window, or than 7 days: it is drawn faded, never as a live bar (AC96).
    stale: boolean;
    // Set when the provider's global reading cannot be read at all: the row says so in one calm line.
    unreadable?: string;
};

// A provider the grid leaves out, for the list of those that were not used lately (AC97).
export type HiddenUsage = {
    provider: string;
    plan: string;
    // The last use or reading (Unix ms), 0 when none is known.
    lastUse: number;
    reason: HiddenReason;
};

export type UsageGrid = { rows: WeeklyUsage[]; hidden: HiddenUsage[] };

type Candidate = { row: WeeklyUsage; plan: string };

// The main window of each provider (its longest running one, a week, 30 days…), the most used first (#2100, #2341). A
// provider with no running window has no entry, unless its global reading says it cannot be read: it then comes last,
// without a percent. The providers the developer's choices or the 7-day rule leave out are in `hidden`, the most used
// first as well.
export function usageGrid(
    readings: UsageReadings,
    now: number,
    unreadable?: UsageUnreadable,
    ctx?: UsageContext
): UsageGrid {
    const found: Candidate[] = [];
    for (const [provider, snapshot] of latestByProvider(readings)) {
        const main = mainWindow(snapshot.windows, now);
        if (main == null) {
            continue;
        }
        const readAt = snapshot.readat ?? 0;
        const line = usageWeekLine(main, now);
        found.push({
            plan: snapshot.plan ?? "",
            row: {
                ...line,
                provider,
                windowId: main.id,
                windowLabel: main.label,
                readAt,
                old: readAt > 0 && now - readAt > UsageOldMs,
                stale: isStale(readAt, line.windowMins, now),
            },
        });
    }
    const ranked = (c: Candidate): Ranked => ({
        id: c.row.provider,
        fullness: c.row.stale ? 0 : c.row.percent,
        readAt: c.row.readAt,
    });
    found.sort((a, b) => byUse(ctx, ranked(a), ranked(b)));
    const shown = new Set(found.map((c) => c.row.provider));
    const none: Candidate[] = [];
    for (const provider of Object.keys(unreadable ?? {}).sort()) {
        if (shown.has(provider)) {
            continue;
        }
        none.push({
            plan: "",
            row: {
                provider,
                percent: 0,
                pace: 1,
                unused: 0,
                resetsAt: 0,
                windowMins: 0,
                start: -1,
                readAt: 0,
                old: false,
                stale: false,
                unreadable: unreadable[provider],
            },
        });
    }
    const rows: WeeklyUsage[] = [];
    const hidden: HiddenUsage[] = [];
    for (const { row, plan } of [...found, ...none]) {
        const reason = hiddenReason(row.provider, plan, row.readAt, ctx, now);
        if (reason === "") {
            rows.push(row);
            continue;
        }
        hidden.push({ provider: row.provider, plan, lastUse: lastUseOf(ctx, row.provider, row.readAt), reason });
    }
    return { rows, hidden };
}

export function weeklyUsage(
    readings: UsageReadings,
    now: number,
    unreadable?: UsageUnreadable,
    ctx?: UsageContext
): WeeklyUsage[] {
    return usageGrid(readings, now, unreadable, ctx).rows;
}
