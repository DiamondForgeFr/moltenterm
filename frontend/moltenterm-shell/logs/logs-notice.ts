// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The note Brokk's notes keep when the logs grow past the high mark (FR-PERF-016, #2335). Electron main reads the logs
// and tells one window when they cross the mark (the first one to ask, then the oldest still open); that window says
// it once, in a calm voice and without a toast, and settles it when the logs fall back under the mark. Whether it was
// said lives in the client meta, so no other window and no later launch says it again for the same stretch.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { t } from "../i18n/i18n";
import {
    addMoltentermNotification,
    MoltentermNotifications,
    NotificationGestureResult,
    registerNotificationGesture,
    resolveMoltentermNotification,
} from "../notifications-store";
import { clearLogs, logsApi, showLogs } from "./logs-client";
import {
    decideLogsEdge,
    LogsClearGesture,
    LogsEdge,
    LogsNoticeKey,
    LogsNoticeMetaKey,
    logsNotification,
    LogsShowGesture,
} from "./logs-model";

function noticeTold(): boolean {
    const clientAtom = ClientModel.getInstance().clientAtom;
    return (clientAtom == null ? null : (globalStore.get(clientAtom)?.meta as any)?.[LogsNoticeMetaKey]) === true;
}

export function applyLogsEdge(edge: LogsEdge): void {
    if (edge == null) {
        return;
    }
    const decision = decideLogsEdge(edge, noticeTold());
    if (decision === "say") {
        MoltentermNotifications.getInstance().write({ [LogsNoticeMetaKey]: true });
        addMoltentermNotification(logsNotification(edge.total, edge.highMark));
        return;
    }
    if (decision === "settle") {
        MoltentermNotifications.getInstance().write({ [LogsNoticeMetaKey]: null });
        resolveMoltentermNotification(LogsNoticeKey);
    }
}

async function clearGesture(): Promise<NotificationGestureResult> {
    const answer = await clearLogs();
    if (answer == null) {
        return { ok: false, error: t("logs.failed") };
    }
    return answer.ok ? { ok: true, resolve: true } : { ok: false, error: t("logs.partial") };
}

async function showGesture(): Promise<NotificationGestureResult> {
    return (await showLogs()) ? { ok: true } : { ok: false, error: t("logs.failed") };
}

// Mounted with the notification host of each window: only the window main tells ever acts.
export function startLogsNotice(): () => void {
    const stops = [
        registerNotificationGesture(LogsClearGesture, clearGesture),
        registerNotificationGesture(LogsShowGesture, showGesture),
    ];
    const api = logsApi();
    let stopped = false;
    const stopListening = api.onMoltentermLogsHigh?.((edge) => applyLogsEdge(edge));
    api.moltentermLogsListen?.()
        .then((edge) => {
            if (!stopped) {
                applyLogsEdge(edge);
            }
        })
        .catch((e) => console.log("logs: not listening", e));
    return () => {
        stopped = true;
        stopListening?.();
        stops.forEach((stop) => stop());
    };
}
