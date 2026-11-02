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
    moltentermHangCopy?: (text: string) => Promise<void>;
    onMoltentermWindowReloaded?: (callback: (notice: WindowReloaded) => void) => () => void;
    moltentermShowLog?: () => Promise<void>;
};

// must match WindowReloaded in emain/moltenterm-renderer-gone.ts
type WindowReloaded = { reason: string; signal: string; at: number };

export const WindowReloadedToastId = "window-reloaded";

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
        const copy = api().moltentermHangCopy;
        await (copy != null ? copy(text) : navigator.clipboard.writeText(text));
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

// The window's renderer was lost and Electron main loaded it again (#973, FR-PERF-004).
export function showWindowReloaded(notice: WindowReloaded) {
    const cause = notice?.signal ?? notice?.reason;
    showToast({
        id: WindowReloadedToastId,
        kind: "warning",
        title: t("hang.reloadedTitle"),
        message: cause ? t("hang.reloadedMessage", { cause }) : t("hang.reloadedMessagePlain"),
        actions: [
            {
                id: "log",
                label: t("hang.showLog"),
                run: () => {
                    api()
                        .moltentermShowLog?.()
                        ?.catch((e) => console.log("hang report: show log failed", e));
                },
            },
        ],
    });
}

export function startHangReport() {
    if (started) {
        return;
    }
    started = true;
    observeLongTasks();
    api().onMoltentermWindowHang?.((hang) => showWindowHang(hang));
    api().onMoltentermWindowReloaded?.((notice) => showWindowReloaded(notice));
}
