// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Reopening the last closed pane or tab (#512): names shared with pkg/molten/reopen, and the toast that says what came
// back.

import { t } from "../i18n/i18n";
import { MoltentermNotificationKind } from "../notifications-model";
import { placeSentenceName } from "../view360/places-names";
import { viewNameText } from "../workspace-views/workspace-views-model";

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

// How the toast names a reopened pane: its agent's first name, else the name every other surface gives it (title,
// page, folder, view). The name the backend sends is English and never used (#1482).
export function reopenPaneName(meta: Record<string, any>, home = ""): string {
    const agent = readResumeAgent(meta?.[ResumeAgentMetaKey]);
    const agentName = (agent?.name ?? "").trim();
    return agentName || placeSentenceName(meta, null, home) || t("reopen.panelFallback");
}

export function reopenToast(result: ReopenResult, home?: string, paneMeta?: Record<string, any>): ReopenToast {
    if (!result?.reopened) {
        return { kind: "info", title: t("reopen.nothing") };
    }
    const title =
        result.kind === "tab"
            ? t("reopen.tab", { name: viewNameText(result.name, t) })
            : t("reopen.pane", { name: reopenPaneName(paneMeta, home) });
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

// The library's put-away views (FR-SHELL-088), as pkg/molten/reopen lists them.
export const ReopenListCommand = "moltenreopenlist";
export const ReopenIdCommand = "moltenreopenid";
// must match ResumeAgentMetaKey in pkg/molten/reopen/reopen.go
export const ResumeAgentMetaKey = "molten:reopenagent";

export type ResumeAgent = { agent: string; name?: string; command: string; guessed?: boolean };

export type PutAwayView = {
    id: string;
    at: number;
    workspaceid: string;
    name: string;
    meta?: Record<string, any>;
    panels: Record<string, any>[];
    agents?: ResumeAgent[];
};

export function readResumeAgent(value: unknown): ResumeAgent {
    if (value == null || typeof value !== "object") {
        return null;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.command !== "string" || v.command.trim() === "") {
        return null;
    }
    return {
        agent: typeof v.agent === "string" ? v.agent : "",
        name: typeof v.name === "string" ? v.name : undefined,
        command: v.command,
        guessed: v.guessed === true,
    };
}
