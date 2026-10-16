// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The rules of Sync (FR-MC-030) that every Sync button shares: how a sync's end reads, what the notification's action
// reports, and the words of the stale flag. The calls themselves are in dep-sync.tsx.

import { t } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import type { NotificationGestureResult } from "../notifications-store";
import { DependencyState } from "./group-model";
import { DepSyncOutcome, RunRecord } from "./mission-model";

// must match DepSyncGesture in pkg/molten/mission/deps_notice.go
export const DepSyncGesture = "dependency:sync";

// Which declaration to sync: a DependencyState fits, so does a notification's action args.
export type DepSyncTarget = { project?: string; sourcename?: string; index?: number };

export type DepSyncResult = {
    ok: boolean;
    outcome?: DepSyncOutcome;
    run?: RunRecord;
    error?: string;
    // The user declined to trust the commands: nothing ran.
    cancelled?: boolean;
};

// A sync's key in this window: the flag (a DependencyState) and the notification (its args) give the same one.
export function depSyncKey(dir: string, target: DepSyncTarget): string {
    if (target?.index != null) {
        return `${dir}\u0000${target.index}`;
    }
    return `${dir}\u0000${(target?.sourcename || target?.project || "").trim().toLowerCase()}`;
}

export function depSyncResultOf(run: RunRecord, tail: string[]): DepSyncResult {
    if (run.state === "success") {
        return { ok: true, outcome: run.outcome, run };
    }
    const state = runStateWord(run.state);
    const how = run.exit != null ? t("mc.depSync.howExit", { state, exit: run.exit }) : state;
    const lines = (tail ?? []).join(" · ");
    return {
        ok: false,
        run,
        error: lines ? t("mc.depSync.syncFailedLines", { how, lines }) : t("mc.depSync.syncFailed", { how }),
    };
}

// A run's state in words ("failed", "cancelled"...); an unknown state shows as it is.
function runStateWord(state: string): string {
    switch (state) {
        case "failure":
            return t("mc.depSync.state.failure");
        case "cancelled":
            return t("mc.depSync.state.cancelled");
        case "lost":
            return t("mc.depSync.state.lost");
        case "running":
            return t("mc.depSync.state.running");
    }
    return state;
}

// What the notification's Sync reports: a sync that changed nothing resolves the notification at once; changed
// output keeps it until the commit lands; a declined trust prompt is no failure.
export function depSyncGestureResult(result: DepSyncResult): NotificationGestureResult {
    if (result.cancelled) {
        return { ok: true };
    }
    if (!result.ok) {
        return { ok: false, error: result.error };
    }
    return { ok: true, resolve: result.outcome === "nochange" };
}

// The flag's words (FR-MC-029, FR-MC-030-AC4).
export function dependencyLabel(dep: DependencyState): string {
    if (dep == null) {
        return "";
    }
    if (dep.lastsync?.state === "running") {
        return t("mc.depSync.label.syncing");
    }
    switch (dep.state) {
        case "insync":
            return dep.acknowledged ? t("mc.depSync.label.inSyncNoChange") : t("mc.depSync.label.inSync");
        case "uncommitted":
            return t("mc.depSync.label.uncommitted");
        case "stale": {
            // A failure older than the source's change is not about it.
            const last = dep.lastsync;
            const changedAt = dep.source?.time ?? dep.commits?.[0]?.time;
            const failed =
                last != null && last.state !== "success" && (changedAt == null || last.startedat >= changedAt);
            if (!failed) {
                return t("mc.depSync.label.stale");
            }
            if (last.state === "failure" && last.exit != null) {
                return t("mc.depSync.label.staleFailedExit", { exit: last.exit });
            }
            return t("mc.depSync.label.staleLast", { state: runStateWord(last.state) });
        }
        case "sourcenotfound":
            return t("mc.depSync.label.sourceNotFound");
        case "branchnotfound":
            return t("mc.depSync.label.branchNotFound");
        case "invalid":
            return t("mc.depSync.label.invalid");
        case "error":
            return t("mc.depSync.label.error");
    }
    return dep.state;
}

// Why a dependency offers no Sync button; null when it does (AC6: none without a declared sync).
export function syncBlocker(dep: DependencyState): string {
    if (dep == null) {
        return t("mc.depSync.blocker.none");
    }
    if (!dep.sync) {
        return t("mc.depSync.blocker.noCommand");
    }
    if (dep.lastsync?.state === "running") {
        return t("mc.depSync.blocker.running");
    }
    switch (dep.state) {
        case "sourcenotfound":
        case "branchnotfound":
        case "invalid":
        case "error":
            return serverText(dep.problemtext, dep.problem) || dependencyLabel(dep);
    }
    return null;
}
