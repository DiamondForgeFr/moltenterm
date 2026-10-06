// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The plan usage gauges of the agent companion (FR-SHELL-027, DS-SHELL-030): what wavesrv reads of an agent's plan
// limits (pkg/molten/usage) and the pure rules of their section. Pure, so they are tested without a window.

import { relativeTime } from "./companion-model";

// must match pkg/molten/usage/usage.go and pkg/molten/companion/usage.go
export type UsageWindow = { id: string; label: string; usedpercent: number; resetsat?: number; windowmins?: number };
export type UsageCredits = { enabled: boolean; used: number; limit: number; unit?: string };
export type UsageSnapshot = {
    agent: string;
    source: string;
    plan?: string;
    windows?: UsageWindow[];
    credits?: UsageCredits;
    readat: number;
};
export type UsageSetup = { source: string; file: string; current?: string; language: string; snippet: string };
export type UsageReason = "notsetup" | "waiting" | "noplan" | "format" | "expired" | "failed";
export type CompanionUsageInfo = {
    blockid: string;
    agent: string;
    pageurl: string;
    pagename: string;
    hasgauges?: boolean;
    gauges: "enabled" | "off" | "unavailable";
    sourcename?: string;
    reason?: UsageReason;
    setup?: UsageSetup;
    snapshot?: UsageSnapshot;
};

// The plain words of an unavailable source, shown as the muted line's tooltip.
export const UsageReasonTexts: Record<UsageReason, string> = {
    notsetup: "Status line not set up",
    waiting: "Waiting for Claude Code's status line: it gives the limits after its next response",
    noplan: "Not on a Pro or Max plan",
    format: "Source changed: this version of MoltenTerm cannot read it",
    expired: "The limits were reset: new values come with the next response",
    failed: "The source could not be read",
};

export function usageReasonText(reason: string): string {
    return UsageReasonTexts[reason as UsageReason] ?? UsageReasonTexts.failed;
}

export type GaugeLevel = "normal" | "warning" | "error";

export type GaugeRow = { id: string; label: string; percent: string; bar: number; level: GaugeLevel; resets: string };

export type GaugesView =
    | { kind: "hidden" }
    | { kind: "off" }
    | { kind: "setup"; setup: UsageSetup }
    | { kind: "unavailable"; reason: string }
    | { kind: "enabled"; rows: GaugeRow[]; source: string; age: string; credits: string };

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
    return `${Math.round(percent * 10) / 10} % used`;
}

const WeekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MonthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HourMs = 3600 * 1000;

function clockTime(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// "Resets in 2 h 14 min" under 24 h; beyond, the weekday and time, with the date when the weekday alone could mean
// this week's or next week's.
export function resetText(resetsAt: number, now: number): string {
    const ms = (resetsAt || 0) - now;
    if (!resetsAt || ms <= 0) {
        return "";
    }
    const mins = Math.ceil(ms / 60000);
    if (mins < 60) {
        return `Resets in ${mins} min`;
    }
    if (ms < 24 * HourMs) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m === 0 ? `Resets in ${h} h` : `Resets in ${h} h ${m} min`;
    }
    const d = new Date(resetsAt);
    if (ms < 6 * 24 * HourMs) {
        return `Resets ${WeekdayNames[d.getDay()]} ${clockTime(d)}`;
    }
    return `Resets ${WeekdayNames[d.getDay()]} ${d.getDate()} ${MonthNames[d.getMonth()]}, ${clockTime(d)}`;
}

// A window past its reset no longer holds: it is dropped between two reports, as wavesrv drops it.
export function gaugeRows(snapshot: UsageSnapshot, now: number): GaugeRow[] {
    return (snapshot?.windows ?? [])
        .filter((w) => w != null && Number.isFinite(w.usedpercent) && !(w.resetsat > 0 && w.resetsat <= now))
        .map((w) => ({
            id: w.id,
            label: w.label || w.id,
            percent: gaugePercent(w.usedpercent),
            bar: Math.min(100, Math.max(0, w.usedpercent)),
            level: gaugeLevel(w.usedpercent),
            resets: resetText(w.resetsat, now),
        }));
}

export function creditsText(credits: UsageCredits): string {
    if (credits == null || !credits.enabled) {
        return "";
    }
    const unit = credits.unit ? ` ${credits.unit}` : "";
    return `Extra usage: ${credits.used}${unit} of ${credits.limit}${unit}`;
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
        return { kind: "unavailable", reason: usageReasonText(info.reason) };
    }
    const rows = gaugeRows(info.snapshot, now);
    const credits = creditsText(info.snapshot?.credits);
    if (rows.length === 0 && !credits) {
        return { kind: "unavailable", reason: UsageReasonTexts.expired };
    }
    const at = info.snapshot?.readat;
    return {
        kind: "enabled",
        rows,
        source: info.sourcename ?? "",
        age: at ? `Updated ${relativeTime(at, now)}` : "",
        credits,
    };
}

// An event or an answer is for this terminal's companion only.
export function usageFor(info: CompanionUsageInfo, target: string, agent: string): boolean {
    return info != null && info.blockid === target && (!agent || info.agent === agent);
}
