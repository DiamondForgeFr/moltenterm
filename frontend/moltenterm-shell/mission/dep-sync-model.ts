// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The rules of Sync (FR-MC-030) that every Sync button shares: how a sync's end reads, what the notification's action
// reports, and the words of the stale flag. The calls themselves are in dep-sync.tsx.

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
    const how = run.exit != null ? `${run.state === "failure" ? "failed" : run.state} (exit ${run.exit})` : run.state;
    const lines = (tail ?? []).join(" · ");
    return { ok: false, run, error: lines ? `the sync ${how}: ${lines}` : `the sync ${how}` };
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
        return "syncing…";
    }
    switch (dep.state) {
        case "insync":
            return dep.acknowledged ? "in sync, no change" : "in sync";
        case "uncommitted":
            return "synced, not committed";
        case "stale": {
            // A failure older than the source's change is not about it.
            const last = dep.lastsync;
            const failed = last != null && last.state !== "success" && (dep.source == null || last.startedat >= dep.source.time);
            if (!failed) {
                return "stale";
            }
            if (last.state === "failure" && last.exit != null) {
                return `stale, last sync failed (exit ${last.exit})`;
            }
            return `stale, last sync ${last.state === "lost" ? "interrupted" : last.state}`;
        }
        case "sourcenotfound":
            return "source not found";
        case "branchnotfound":
            return "branch not found";
        case "invalid":
            return "invalid declaration";
        case "error":
            return "could not be read";
    }
    return dep.state;
}

// Why a dependency offers no Sync button; null when it does (AC6: none without a declared sync).
export function syncBlocker(dep: DependencyState): string {
    if (dep == null) {
        return "no dependency";
    }
    if (!dep.sync) {
        return "no sync command is declared";
    }
    if (dep.lastsync?.state === "running") {
        return "a sync is running";
    }
    switch (dep.state) {
        case "sourcenotfound":
        case "branchnotfound":
        case "invalid":
        case "error":
            return dep.problem || dependencyLabel(dep);
    }
    return null;
}
