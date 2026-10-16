// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The renderer's hang report (#849): long tasks go to waveapp.log through fe-log, and once the window answers again
// after Electron main saw it stall, a notification says how long, with "Copy diagnostics". Nothing opens by itself.

import { getApi, getFocusedBlockId } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { describeLastCall, HangContext } from "./hang-context";
import {
    diagnosticsText,
    hangSeconds,
    LongTaskLimiter,
    longTaskLine,
    LongTaskLogMs,
    LongTasksKept,
    MainHangDiagnostics,
} from "./hang-report-model";
import { t } from "./i18n/i18n";
import { showToast } from "./toast-store";

export const WindowHangToastId = "window-hang";

type HangApi = {
    sendLog?: (log: string) => void;
    onMoltentermWindowHang?: (callback: (hang: { ms: number; at: number }) => void) => () => void;
    moltentermHangDiagnostics?: () => Promise<MainHangDiagnostics>;
};

const limiter = new LongTaskLimiter();
const recentLongTasks: string[] = [];
let started = false;

function api(): HangApi {
    return getApi() as unknown as HangApi;
}

function focusedPanel(): string {
    try {
        const blockId = getFocusedBlockId();
        if (!blockId) {
            return "none";
        }
        const block = WOS.getObjectValue<Block>(WOS.makeORef("block", blockId));
        return `${block?.meta?.view ?? "block"} ${blockId.slice(0, 8)}`;
    } catch {
        return "unknown";
    }
}

function keep(line: string) {
    recentLongTasks.push(`${new Date().toISOString()} ${line}`);
    if (recentLongTasks.length > LongTasksKept) {
        recentLongTasks.splice(0, recentLongTasks.length - LongTasksKept);
    }
}

function onLongTask(kind: string, durationMs: number, scripts: any[]) {
    if (durationMs < LongTaskLogMs) {
        return;
    }
    const now = Date.now();
    const skipped = limiter.admit(now);
    const line = longTaskLine({
        kind,
        durationMs,
        scripts,
        lastRpc: describeLastCall(HangContext.rpc, now),
        lastService: describeLastCall(HangContext.service, now),
        panel: focusedPanel(),
        skipped: skipped ?? 0,
    });
    keep(line);
    if (skipped == null) {
        return;
    }
    api().sendLog?.(line);
}

function observeLongTasks() {
    if (typeof PerformanceObserver === "undefined") {
        return;
    }
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    // long-animation-frame names the scripts that ran; longtask only says that something did.
    const type = supported.includes("long-animation-frame") ? "long-animation-frame" : "longtask";
    if (!supported.includes(type)) {
        return;
    }
    try {
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as any[]) {
                onLongTask(type === "longtask" ? "task" : "frame", entry.duration, entry.scripts ?? []);
            }
        });
        observer.observe({ type, buffered: false });
    } catch (e) {
        console.log("hang report: long tasks are not observable", e);
    }
}

async function copyDiagnostics(hang: { ms: number; at: number }) {
    let main: MainHangDiagnostics = null;
    try {
        main = (await api().moltentermHangDiagnostics?.()) ?? null;
    } catch (e) {
        console.log("hang report: no diagnostics from Electron main", e);
    }
    const text = diagnosticsText({
        hangMs: hang.ms,
        hangAt: hang.at,
        main,
        rendererEvents: [...recentLongTasks],
        userAgent: navigator.userAgent,
    });
    try {
        await navigator.clipboard.writeText(text);
        showToast({ id: WindowHangToastId, kind: "success", title: t("hang.copied") });
    } catch (e) {
        console.log("hang report: copy failed", e);
        showToast({ id: WindowHangToastId, kind: "error", title: t("hang.copyFailed") });
    }
}

export function showWindowHang(hang: { ms: number; at: number }) {
    showToast({
        id: WindowHangToastId,
        kind: "warning",
        title: t("hang.title", { seconds: hangSeconds(hang.ms) }),
        message: t("hang.message"),
        actions: [{ id: "copy", label: t("hang.copy"), run: () => copyDiagnostics(hang) }],
    });
}

export function startHangReport() {
    if (started) {
        return;
    }
    started = true;
    observeLongTasks();
    api().onMoltentermWindowHang?.((hang) => showWindowHang(hang));
}
