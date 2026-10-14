// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Reopening the last closed pane or tab (#512): names shared with pkg/molten/reopen, and the toast that says what came
// back.

import { t } from "../i18n/i18n";
import { MoltentermNotificationKind } from "../notifications-model";

export const ReopenRoute = "molten:reopen";
export const ReopenRecordCommand = "moltenreopenrecord";
export const ReopenLastCommand = "moltenreopenlast";
export const ReopenDropCommand = "moltenreopendrop";

export type ReopenResult = {
    reopened: boolean;
    kind?: "pane" | "tab";
    name?: string;
    freshshell?: boolean;
    cwd?: string;
    tabid?: string;
    blockid?: string;
};

export type ReopenToast = { kind: MoltentermNotificationKind; title: string; message?: string };

function displayPath(path: string, home: string): string {
    if (home && (path === home || path.startsWith(home + "/"))) {
        return "~" + path.slice(home.length);
    }
    return path;
}

export function reopenToast(result: ReopenResult, home?: string): ReopenToast {
    if (!result?.reopened) {
        return { kind: "info", title: t("reopen.nothing") };
    }
    // A pane's name comes worded (pkg/molten/reopen PaneName: "the terminal", or its own title).
    const title =
        result.kind === "tab" ? t("reopen.tab", { name: result.name }) : t("reopen.pane", { name: result.name });
    if (!result.freshshell) {
        return { kind: "success", title };
    }
    return {
        kind: "success",
        title,
        message: result.cwd
            ? t("reopen.freshShellIn", { path: displayPath(result.cwd, home) })
            : t("reopen.freshShell"),
    };
}
