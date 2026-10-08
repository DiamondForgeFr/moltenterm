// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Sync of a stale dependency (FR-MC-030): the one entry point every Sync button calls (the notification's action, the
// stale flag on the group strip). wavesrv runs the dependent's declared command against a clean worktree of the
// source (pkg/molten/mission/depsync.go); here the user trusts the project's commands when asked, and the caller
// learns how the sync ended. The flag's words and the result rules are in dep-sync-model.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { NotificationGestureResult, registerNotificationGesture } from "../notifications-store";
import { pathBaseName } from "../workspace-project";
import {
    DepSyncGesture,
    depSyncGestureResult,
    depSyncKey,
    DepSyncResult,
    depSyncResultOf,
    DepSyncTarget,
} from "./dep-sync-model";
import { missionDepSync, missionLog, MissionRunEvent, missionRuns, missionTrust } from "./mission-client";
import { logTail, RunRecord, UntrustedInfo } from "./mission-model";
import { TrustPrompt } from "./runs-view";

type PendingTrust = { dir: string; info: UntrustedInfo; resolve: (trusted: boolean) => void };

const FailureLogLines = 2;
// must match the closing lines runSync writes in pkg/molten/mission/depsync.go
const OwnLogLine = /^(the sync failed \(exit|the sync ran for more than|cancelled$)/;
// The run event is the fast path; the list is read again in case an event was missed.
const RunEndPollMs = 2000;
// A run missing from the list this many polls in a row is gone (its history was removed).
const RunGonePolls = 5;
// wavesrv stops a sync after 30 minutes; past this, the wait gives up.
const RunEndMaxMs = 35 * 60 * 1000;

export class DepSyncModel {
    private static instance: DepSyncModel = null;

    // The trust prompt this window shows, at most one.
    pendingAtom = atom(null) as PrimitiveAtom<PendingTrust>;
    // The syncs this window started and waits for, by depSyncKey.
    runningAtom = atom({}) as PrimitiveAtom<Record<string, boolean>>;

    private constructor() {}

    static getInstance(): DepSyncModel {
        if (DepSyncModel.instance == null) {
            DepSyncModel.instance = new DepSyncModel();
        }
        return DepSyncModel.instance;
    }

    askTrust(dir: string, info: UntrustedInfo): Promise<boolean> {
        globalStore.get(this.pendingAtom)?.resolve(false);
        return new Promise((resolve) => {
            globalStore.set(this.pendingAtom, {
                dir,
                info,
                resolve: (trusted) => {
                    globalStore.set(this.pendingAtom, null);
                    resolve(trusted);
                },
            });
        });
    }

    setRunning(key: string, running: boolean) {
        const next = { ...globalStore.get(this.runningAtom) };
        if (running) {
            next[key] = true;
        } else {
            delete next[key];
        }
        globalStore.set(this.runningAtom, next);
    }

    // Starts the sync, after the trust prompt when the commands are not trusted yet, and resolves once it ended.
    async sync(dir: string, target: DepSyncTarget): Promise<DepSyncResult> {
        const key = depSyncKey(dir, target);
        if (globalStore.get(this.runningAtom)[key]) {
            return { ok: false, error: "this sync is already running" };
        }
        const project = target?.sourcename || target?.project;
        this.setRunning(key, true);
        try {
            let started = await missionDepSync(dir, project, target?.index);
            if (started?.untrusted) {
                if (!(await this.askTrust(dir, started.untrusted))) {
                    return { ok: false, cancelled: true, error: "the commands were not trusted: the sync did not run" };
                }
                await missionTrust(dir, started.untrusted.hash);
                started = await missionDepSync(dir, project, target?.index);
                if (started?.untrusted) {
                    return { ok: false, error: "the project's commands changed meanwhile: press Sync again" };
                }
            }
            if (started?.run == null) {
                return { ok: false, error: "the sync did not start" };
            }
            const ended = await waitForRunEnd(dir, started.run.id);
            const tail = ended.state === "success" ? [] : await readLogTail(dir, ended.id);
            return depSyncResultOf(ended, tail);
        } catch (e) {
            return { ok: false, error: String(e?.message ?? e) };
        } finally {
            this.setRunning(key, false);
        }
    }
}

// The one call a Sync button makes: dir is the dependent's root (GroupMember.dir), target the declaration (a
// DependencyState will do). It resolves once the sync ended; its run is followed meanwhile in the groups' lastsync.
export function syncDependency(dir: string, target: DepSyncTarget): Promise<DepSyncResult> {
    return DepSyncModel.getInstance().sync(dir, target);
}

async function readLogTail(dir: string, runId: string): Promise<string[]> {
    try {
        const chunk = await missionLog(dir, runId, 0);
        const lines = logTail(chunk?.text ?? "", FailureLogLines + 2);
        return lines.filter((l) => !OwnLogLine.test(l.trim())).slice(-FailureLogLines);
    } catch {
        return [];
    }
}

// Resolves with the run once it is no longer running; a run that is gone, or still running past wavesrv's own limit,
// resolves as lost.
export function waitForRunEnd(dir: string, runId: string): Promise<RunRecord> {
    return new Promise((resolve) => {
        let done = false;
        let missing = 0;
        let last: RunRecord = null;
        let timer: ReturnType<typeof setInterval> = null;
        let unsubscribe: () => void = null;
        const startedAt = Date.now();
        const settle = (run: RunRecord) => {
            done = true;
            clearInterval(timer);
            unsubscribe?.();
            resolve(run);
        };
        const lost = (): RunRecord => ({
            ...(last ?? {
                id: runId,
                dir,
                kind: "sync",
                stepid: "",
                command: "",
                startedat: startedAt,
                phases: [],
                logsize: 0,
            }),
            state: "lost",
        });
        const finish = (run: RunRecord) => {
            if (done || run == null || run.id !== runId) {
                return;
            }
            last = run;
            if (run.state !== "running") {
                settle(run);
            }
        };
        unsubscribe = waveEventSubscribeSingle({
            eventType: MissionRunEvent as WaveEventName,
            scope: dir,
            handler: (event) => finish(event.data as RunRecord),
        });
        const poll = async () => {
            if (done) {
                return;
            }
            if (Date.now() - startedAt > RunEndMaxMs) {
                settle(lost());
                return;
            }
            try {
                const run = (await missionRuns(dir))?.find((r) => r.id === runId);
                missing = run == null ? missing + 1 : 0;
                if (missing >= RunGonePolls && !done) {
                    settle(lost());
                    return;
                }
                finish(run);
            } catch {
                // The next poll asks again.
            }
        };
        timer = setInterval(() => void poll(), RunEndPollMs);
        void poll();
    });
}

async function depSyncGesture(args: Record<string, any>): Promise<NotificationGestureResult> {
    if (typeof args.dir !== "string" || args.dir === "") {
        return { ok: false, error: "no project to sync" };
    }
    const target: DepSyncTarget = {
        project: typeof args.project === "string" ? args.project : undefined,
        index: typeof args.index === "number" ? args.index : undefined,
    };
    return depSyncGestureResult(await syncDependency(args.dir, target));
}

// Mounted once per window (with the notification center): the trust prompt a sync asks for, and the notification's
// Sync action.
export function DepSyncHost() {
    const model = DepSyncModel.getInstance();
    const pending = useAtomValue(model.pendingAtom, { store: globalStore });
    useEffect(() => registerNotificationGesture(DepSyncGesture, depSyncGesture), []);
    useEffect(() => () => globalStore.get(model.pendingAtom)?.resolve(false), [model]);
    if (pending == null) {
        return null;
    }
    return (
        <TrustPrompt
            projectName={pathBaseName(pending.dir)}
            dir={pending.dir}
            info={pending.info}
            onTrust={() => pending.resolve(true)}
            onCancel={() => pending.resolve(false)}
        />
    );
}
