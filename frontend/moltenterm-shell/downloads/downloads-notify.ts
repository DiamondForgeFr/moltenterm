// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a download tells the notification center (FR-MC-019 AC10, #1992): one notification when it finishes, one when it
// fails, none while it progresses and none when the user cancels it. Electron main tells the window that hosts the
// page (so the windows do not raise it twice) and this window publishes it, with the actions the entry itself offers.

import { t } from "../i18n/i18n";
import type { MoltentermNotificationInput, NotificationAction } from "../notifications-model";
import { MoltentermNotifications, registerNotificationGesture } from "../notifications-store";
import { formatSize, reasonText } from "./downloads-format";
import { DownloadRecord } from "./downloads-model";
import { DownloadsModel } from "./downloads-store";

export const DownloadOpenGesture = "downloads:open";
export const DownloadRevealGesture = "downloads:reveal";
export const DownloadRetryGesture = "downloads:retry";
export const DownloadShowGesture = "downloads:show";

export function downloadNotificationKey(id: string): string {
    return `download:${id}`;
}

function gesture(
    id: string,
    label: string,
    name: string,
    downloadId: string,
    extra: Record<string, unknown> = {},
    lasting = false
): NotificationAction {
    return { id, label, kind: "gesture", gesture: name, args: { id: downloadId, ...extra }, lasting };
}

// A finished download, or a failed one. `read`: the section is open, which already shows it.
export function downloadNotification(
    record: DownloadRecord,
    outcome: "done" | "failed",
    read: boolean
): MoltentermNotificationInput {
    const key = downloadNotificationKey(record.id);
    if (outcome === "failed") {
        return {
            key,
            source: "download",
            kind: "error",
            global: true,
            title: t("downloads.notify.failedTitle", { name: record.name }),
            message: reasonText(record),
            actions: [
                gesture("retry", t("downloads.action.retry"), DownloadRetryGesture, record.id),
                gesture("view", t("downloads.action.view"), DownloadShowGesture, record.id, {}, true),
            ],
        };
    }
    const first: NotificationAction = record.executable
        ? gesture("view", t("downloads.action.view"), DownloadShowGesture, record.id, { confirm: true }, true)
        : gesture("open", t("downloads.action.open"), DownloadOpenGesture, record.id, {}, true);
    const site = [record.host, record.total > 0 ? formatSize(record.total) : ""].filter(Boolean).join(" · ");
    const agent = record.agent ? t("downloads.notify.startedBy", { name: record.agent }) : "";
    return {
        key,
        source: "download",
        kind: "success",
        global: true,
        read,
        title: t("downloads.notify.doneTitle", { name: record.name }),
        // A program says why it has no direct Open: its confirmation is in the entry.
        message: record.executable ? t("downloads.notify.program") : [agent, site].filter(Boolean).join(" · "),
        actions: [first, gesture("reveal", t("downloads.action.reveal"), DownloadRevealGesture, record.id, {}, true)],
    };
}

type GestureResult = { ok: boolean; resolve?: boolean; error?: string };

async function run(id: unknown, action: "open" | "reveal" | "retry"): Promise<GestureResult> {
    const model = DownloadsModel.getInstance();
    if (typeof id !== "string" || model.find(id) == null) {
        return { ok: false, error: t("downloads.error.noitem") };
    }
    const result = await model.act({ id, action });
    if (result.ok) {
        return { ok: true, resolve: action === "retry" };
    }
    // A program asks in its entry, where the section opens on it.
    if (result.error === "executable") {
        model.request(id, true);
        return { ok: true };
    }
    return { ok: false, error: t(`downloads.error.${result.error ?? "failed"}`) };
}

export function registerDownloadGestures(): () => void {
    const stops = [
        registerNotificationGesture(DownloadOpenGesture, (args) => run(args.id, "open")),
        registerNotificationGesture(DownloadRevealGesture, (args) => run(args.id, "reveal")),
        registerNotificationGesture(DownloadRetryGesture, (args) => run(args.id, "retry")),
        registerNotificationGesture(DownloadShowGesture, async (args) => {
            const model = DownloadsModel.getInstance();
            if (typeof args.id !== "string" || model.find(args.id) == null) {
                return { ok: false, error: t("downloads.error.noitem") };
            }
            model.request(args.id, args.confirm === true);
            return { ok: true };
        }),
    ];
    return () => stops.forEach((stop) => stop());
}

// Mounted once per window with the bell: the list, the notifications it raises and the actions they carry.
export function startDownloads(): () => void {
    const model = DownloadsModel.getInstance();
    const stopList = model.start();
    const stopGestures = registerDownloadGestures();
    const stopNotify = model.onNotify(({ record, outcome }) => {
        MoltentermNotifications.getInstance().publish(
            downloadNotification(record, outcome, outcome === "done" && model.isVisible())
        );
    });
    return () => {
        stopNotify();
        stopGestures();
        stopList();
    };
}
