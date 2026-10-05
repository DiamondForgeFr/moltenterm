// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How Mission Control's panels write a moment: relative for "when" at a glance, absolute in details.

export function timeAgo(iso: string, now = Date.now()): string {
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    const hours = Math.round((new Date(iso).getTime() - now) / 3_600_000);
    return Math.abs(hours) < 48 ? rtf.format(hours, "hour") : rtf.format(Math.round(hours / 24), "day");
}

export function formatWhen(iso: string): string {
    return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

// A day as the line map labels it: "19 Sept".
export function formatDay(date: Date | string | number): string {
    return new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
