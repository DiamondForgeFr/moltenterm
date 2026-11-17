// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The logs as the window knows them (FR-PERF-016, #2335): what Electron main answers about the log files, and the one
// note Brokk's notes keep when they grow past the high mark. Pure: the texts resolve at call time (the language changes
// without a restart) and nothing here touches a file or the store.

import { formatSize } from "../downloads/downloads-format";
import { t } from "../i18n/i18n";
import type { MoltentermNotificationInput } from "../notifications-model";

export const LogsNoticeKey = "logs:high";
// Whether the note was said for the logs as they are now: shared by the windows and kept across launches through the
// client meta, so a note said once is not said again while the logs stay past the mark.
export const LogsNoticeMetaKey = "moltenterm:lognotice";
export const LogsClearGesture = "logs:clear";
export const LogsShowGesture = "logs:show";

// must match what emain/moltenterm-logs-service.ts answers
export type LogsSummary = { total: number; current: number; rotated: number; files: number; highMark: number };
export type LogsClearAnswer = { ok: boolean; removed: number; freed: number; failed: number; info: LogsSummary };
export type LogsEdge = { high: boolean; total: number; highMark: number };

export type LogsEdgeDecision = "say" | "settle" | "none";

// A crossing of the mark upward says the note once; a crossing back, or a reading under the mark, settles what was said.
export function decideLogsEdge(edge: Pick<LogsEdge, "high">, told: boolean): LogsEdgeDecision {
    if (edge.high) {
        return told ? "none" : "say";
    }
    return told ? "settle" : "none";
}

export function logsNotification(total: number, highMark: number): MoltentermNotificationInput {
    return {
        key: LogsNoticeKey,
        source: "moltenterm",
        kind: "info",
        // A background fact: stored as read, so it makes no toast and no count, and only shows as an open situation.
        read: true,
        global: true,
        title: t("logs.notice.title", { size: formatSize(total) }),
        message: t("logs.notice.message", { limit: formatSize(highMark) }),
        actions: [
            { id: "clear", label: t("logs.notice.clear"), kind: "gesture", gesture: LogsClearGesture },
            { id: "show", label: t("logs.notice.show"), kind: "gesture", gesture: LogsShowGesture, lasting: true },
        ],
    };
}
