// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How Mission Control's panels write a moment: relative for "when" at a glance, absolute in details. The formatters
// are built once: building one per call costs more than everything else the line map computes.

const Relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const When = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });
const DayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

export function timeAgo(iso: string, now = Date.now()): string {
    const hours = Math.round((new Date(iso).getTime() - now) / 3_600_000);
    return Math.abs(hours) < 48 ? Relative.format(hours, "hour") : Relative.format(Math.round(hours / 24), "day");
}

export function formatWhen(iso: string): string {
    return When.format(new Date(iso));
}

// A day as the line map labels it: "19 Sept".
export function formatDay(date: Date | string | number): string {
    return DayFormat.format(new Date(date));
}
