// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of the logs (FR-PERF-016, #2335): Electron main answers sizes and counts, clears and shows the
// current file; the window never names a path. A window without Electron main (the preview) gets null and shows nothing.

import { getApi } from "@/app/store/global";
import type { LogsClearAnswer, LogsEdge, LogsSummary } from "./logs-model";

// emain/preload.ts exposes these; keep the names in step.
export type LogsApi = {
    moltentermLogsInfo?: () => Promise<LogsSummary>;
    moltentermLogsClear?: () => Promise<LogsClearAnswer>;
    moltentermLogsListen?: () => Promise<LogsEdge>;
    onMoltentermLogsHigh?: (callback: (edge: LogsEdge) => void) => () => void;
    moltentermShowLog?: () => Promise<void>;
};

export function logsApi(): LogsApi {
    return getApi() as unknown as LogsApi;
}

export async function readLogs(): Promise<LogsSummary> {
    try {
        return (await logsApi().moltentermLogsInfo?.()) ?? null;
    } catch (e) {
        console.log("logs: size not read", e);
        return null;
    }
}

export async function clearLogs(): Promise<LogsClearAnswer> {
    try {
        return (await logsApi().moltentermLogsClear?.()) ?? null;
    } catch (e) {
        console.log("logs: not cleared", e);
        return null;
    }
}

export async function showLogs(): Promise<boolean> {
    try {
        const show = logsApi().moltentermShowLog;
        if (show == null) {
            return false;
        }
        await show();
        return true;
    } catch (e) {
        console.log("logs: not shown", e);
        return false;
    }
}
