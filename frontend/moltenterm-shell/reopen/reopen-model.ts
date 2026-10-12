// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Reopening the last closed pane or tab (#512): names shared with pkg/molten/reopen, and the toast that says what came
// back.

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
        return { kind: "info", title: "Nothing to reopen" };
    }
    // A pane's name comes worded (pkg/molten/reopen PaneName: "the terminal", or its own title).
    const title = result.kind === "tab" ? `Reopened the tab “${result.name}”` : `Reopened ${result.name}`;
    if (!result.freshshell) {
        return { kind: "success", title };
    }
    const where = result.cwd ? ` in ${displayPath(result.cwd, home)}` : "";
    return {
        kind: "success",
        title,
        message: `A new shell started${where}: the closed one cannot be brought back.`,
    };
}
