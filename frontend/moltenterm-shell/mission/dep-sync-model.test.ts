// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { dependencyLabel, depSyncGestureResult, depSyncKey, depSyncResultOf, syncBlocker } from "./dep-sync-model";
import { DependencyState } from "./group-model";
import { RunRecord } from "./mission-model";

function dep(over: Partial<DependencyState>): DependencyState {
    return {
        index: 0,
        project: "Notulia",
        sourcename: "Notulia",
        paths: ["features/*.json"],
        output: ["src/data/features/*.json"],
        sync: "node scripts/sync-features.mjs",
        state: "stale",
        source: { sha: "b".repeat(40), time: 2000, subject: "feat(#1151): pro" },
        ...over,
    };
}

function run(over: Partial<RunRecord>): RunRecord {
    return {
        id: "r1",
        dir: "/p/site",
        kind: "sync",
        stepid: "dependson[0]",
        command: "node scripts/sync-features.mjs",
        startedat: 3000,
        state: "success",
        phases: [],
        logsize: 0,
        ...over,
    };
}

describe("dependencyLabel", () => {
    it("says what the flag says", () => {
        expect(dependencyLabel(dep({}))).toBe("stale");
        expect(dependencyLabel(dep({ state: "uncommitted" }))).toBe("synced, not committed");
        expect(dependencyLabel(dep({ state: "insync" }))).toBe("in sync");
        expect(dependencyLabel(dep({ state: "insync", acknowledged: 5000 }))).toBe("in sync, no change");
        expect(dependencyLabel(dep({ state: "sourcenotfound" }))).toBe("source not found");
        expect(dependencyLabel(null)).toBe("");
    });

    it("tells a running sync and a failed one", () => {
        expect(dependencyLabel(dep({ lastsync: { runid: "r", state: "running", startedat: 3000 } }))).toBe("syncing…");
        expect(dependencyLabel(dep({ lastsync: { runid: "r", state: "failure", exit: 3, startedat: 3000 } }))).toBe(
            "stale, last sync failed (exit 3)"
        );
        expect(dependencyLabel(dep({ lastsync: { runid: "r", state: "lost", startedat: 3000 } }))).toBe(
            "stale, last sync interrupted"
        );
        // A failure older than the source's change is not about it.
        expect(dependencyLabel(dep({ lastsync: { runid: "r", state: "failure", exit: 3, startedat: 1000 } }))).toBe(
            "stale"
        );
    });
});

describe("syncBlocker", () => {
    it("offers no Sync without a declared command (AC6)", () => {
        expect(syncBlocker(dep({ sync: "" }))).toBe("no sync command is declared");
        expect(syncBlocker(dep({}))).toBeNull();
        expect(syncBlocker(dep({ state: "insync" }))).toBeNull();
        expect(syncBlocker(dep({ lastsync: { runid: "r", state: "running", startedat: 1 } }))).toBe(
            "a sync is running"
        );
        expect(syncBlocker(dep({ state: "branchnotfound", problem: "Notulia has no branch develop" }))).toBe(
            "Notulia has no branch develop"
        );
    });
});

describe("sync results", () => {
    it("reads a sync's end", () => {
        expect(depSyncResultOf(run({ outcome: "nochange", exit: 0 }), [])).toMatchObject({
            ok: true,
            outcome: "nochange",
        });
        expect(depSyncResultOf(run({ outcome: "changed", exit: 0 }), [])).toMatchObject({
            ok: true,
            outcome: "changed",
        });
        expect(depSyncResultOf(run({ state: "failure", exit: 3 }), ["registry refused"])).toMatchObject({
            ok: false,
            error: "the sync failed (exit 3): registry refused",
        });
        expect(depSyncResultOf(run({ state: "cancelled" }), []).error).toBe("the sync cancelled");
    });

    it("maps the end to the notification's action", () => {
        expect(depSyncGestureResult({ ok: true, outcome: "nochange" })).toEqual({ ok: true, resolve: true });
        expect(depSyncGestureResult({ ok: true, outcome: "changed" })).toEqual({ ok: true, resolve: false });
        expect(depSyncGestureResult({ ok: false, error: "the sync failed (exit 1)" })).toEqual({
            ok: false,
            error: "the sync failed (exit 1)",
        });
        expect(depSyncGestureResult({ ok: false, cancelled: true, error: "not trusted" })).toEqual({ ok: true });
    });

    it("keys a sync by dependent and declaration", () => {
        expect(depSyncKey("/p/site", { sourcename: "Notulia", index: 0 })).toBe(
            depSyncKey("/p/site", { project: "Other", index: 0 })
        );
        expect(depSyncKey("/p/site", { sourcename: "Notulia" })).toBe(depSyncKey("/p/site", { project: " notulia " }));
        expect(depSyncKey("/p/site", { project: "Notulia", index: 0 })).not.toBe(
            depSyncKey("/p/site", { project: "Notulia", index: 1 })
        );
    });
});
