// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How Mission Control's panels write a moment: relative for "when" at a glance, absolute in details. The formatters
// are built once per interface language: building one per call costs more than everything else the line map computes.

import { getLocale } from "../i18n/i18n";

type Formatters = { relative: Intl.RelativeTimeFormat; when: Intl.DateTimeFormat; day: Intl.DateTimeFormat };

const FormattersByLocale = new Map<string, Formatters>();

// The locale dates are written in: English keeps the day-month order of en-GB ("19 Sept").
export function dateLocale(): string {
    const locale = getLocale();
    return locale === "en" ? "en-GB" : locale;
}

function formatters(): Formatters {
    const locale = getLocale();
    let f = FormattersByLocale.get(locale);
    if (f == null) {
        f = {
            relative: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
            when: new Intl.DateTimeFormat(dateLocale(), { dateStyle: "medium", timeStyle: "short" }),
            day: new Intl.DateTimeFormat(dateLocale(), { day: "numeric", month: "short" }),
        };
        FormattersByLocale.set(locale, f);
    }
    return f;
}

export function timeAgo(iso: string, now = Date.now()): string {
    const hours = Math.round((new Date(iso).getTime() - now) / 3_600_000);
    const relative = formatters().relative;
    return Math.abs(hours) < 48 ? relative.format(hours, "hour") : relative.format(Math.round(hours / 24), "day");
}

export function formatWhen(iso: string): string {
    return formatters().when.format(new Date(iso));
}

// A day as the line map labels it: "19 Sept".
export function formatDay(date: Date | string | number): string {
    return formatters().day.format(new Date(date));
}
