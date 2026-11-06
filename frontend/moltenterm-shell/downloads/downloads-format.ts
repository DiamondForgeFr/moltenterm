// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How a download's numbers and reasons read in the interface language (FR-I18N-001). Resolved at call time, never into a
// constant: the language changes without a restart.

import { formatNumber, t } from "../i18n/i18n";
import { DownloadRecord, percentOf, secondsLeft } from "./downloads-model";

const Units = ["b", "kb", "mb", "gb", "tb"];

// Decimal units ("4,2 Mo", "38 Mo", "1,8 Go"): one decimal below 10, none above.
export function formatSize(bytes: number, decimalBelow = 10): string {
    let value = Math.max(0, bytes);
    let unit = 0;
    while (value >= 1000 && unit < Units.length - 1) {
        value /= 1000;
        unit++;
    }
    const digits = unit === 0 ? 0 : value < decimalBelow ? 1 : 0;
    return t("downloads.size", { value: formatNumber(value, digits), unit: t(`downloads.units.${Units[unit]}`) });
}

export function formatSpeed(bytesPerSecond: number): string {
    return t("downloads.speed", { size: formatSize(bytesPerSecond, 100) });
}

// "40 s", "1 min 40 s", "2 h 5 min": never more than two units.
export function formatDuration(seconds: number): string {
    const total = Math.max(1, Math.round(seconds));
    if (total < 60) {
        return t("downloads.duration.seconds", { s: total });
    }
    const minutes = Math.floor(total / 60);
    if (minutes < 60) {
        const s = total % 60;
        return s === 0
            ? t("downloads.duration.minutes", { m: minutes })
            : t("downloads.duration.minutesSeconds", { m: minutes, s });
    }
    const hours = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0
        ? t("downloads.duration.hours", { h: hours })
        : t("downloads.duration.hoursMinutes", { h: hours, m });
}

// The line under a download that runs: "412 Mo sur 1,8 Go · 23 % · 14,2 Mo/s · environ 1 min 40 s restantes". Nothing is
// invented when the site gives no size: the bytes received, and the speed.
export function runningStats(record: DownloadRecord): string {
    const percent = percentOf(record);
    const parts: string[] = [];
    if (record.total > 0) {
        parts.push(
            t("downloads.stats.ofTotal", { received: formatSize(record.received), total: formatSize(record.total) })
        );
    } else {
        parts.push(t("downloads.stats.received", { received: formatSize(record.received) }));
    }
    if (percent != null) {
        parts.push(t("downloads.stats.percent", { percent }));
    }
    if (record.state === "paused") {
        parts.push(t("downloads.stats.paused"));
        return parts.join(" · ");
    }
    if (record.bytesPerSecond > 0) {
        parts.push(formatSpeed(record.bytesPerSecond));
    }
    const left = secondsLeft(record);
    if (left != null) {
        parts.push(t("downloads.stats.left", { time: formatDuration(left) }));
    }
    return parts.join(" · ");
}

// Why a download stopped, in plain words, from what was received.
export function reasonText(record: Pick<DownloadRecord, "reason" | "received" | "total">): string {
    switch (record.reason) {
        case "connection":
            return record.total > 0
                ? t("downloads.reason.connectionAt", { percent: percentOf(record) })
                : t("downloads.reason.connectionAfter", { size: formatSize(record.received) });
        case "server":
            return t("downloads.reason.server");
        case "appclosed":
            return t("downloads.reason.appclosed");
        case "noresume":
            return t("downloads.reason.noresume");
        default:
            return t("downloads.reason.unknown");
    }
}
