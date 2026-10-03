// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The panels' side of Mission Control's collector (DS-MC-001): they ask wavesrv, show the cached answer at once, and
// take the refreshed snapshot from the event bus. Panels poll only while the window is visible.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useCallback, useEffect, useState } from "react";
import { BuildsFacts } from "./builds-model";
import { CiRunRecord, CiState, upsertCiRun } from "./ci-model";
import { LogChunk, MissionSnapshot, RunRecord, RunResult, UntrustedInfo, upsertRun } from "./mission-model";

// must match the names in pkg/molten/mission/collector.go
export const MissionRouteId = "molten:mission";
export const MissionGetCommand = "moltenmissionget";
export const MissionRefreshCommand = "moltenmissionrefresh";
export const MissionUpdateEvent = "molten:mission:update";
export const MissionRunCommand = "moltenmissionrun";
export const MissionRunsCommand = "moltenmissionruns";
export const MissionLogCommand = "moltenmissionlog";
export const MissionCancelCommand = "moltenmissioncancel";
export const MissionCloseCommand = "moltenmissionclose";
export const MissionTrustCommand = "moltenmissiontrust";
export const MissionRunEvent = "molten:mission:run";
export const MissionCiStateCommand = "moltenmissioncistate";
export const MissionCiRunCommand = "moltenmissioncirun";
export const MissionCiLogCommand = "moltenmissioncilog";
export const MissionCiCancelCommand = "moltenmissioncicancel";
export const MissionCiEvent = "molten:mission:ci";
export const MissionBuildsCommand = "moltenmissionbuilds";

const MissionRpcTimeoutMs = 15000;
// A request is cheap (the cached snapshot and the pipeline file); the collector itself refreshes at most once a minute.
const MissionPollMs = 15000;

export function missionGet(dir: string, maxAgeSec?: number): Promise<MissionSnapshot> {
    return TabRpcClient.wshRpcCall(
        MissionGetCommand,
        { dir, maxagesec: maxAgeSec },
        { route: MissionRouteId, timeout: MissionRpcTimeoutMs }
    );
}

export function missionRefresh(dir: string): Promise<MissionSnapshot> {
    return TabRpcClient.wshRpcCall(
        MissionRefreshCommand,
        { dir },
        { route: MissionRouteId, timeout: MissionRpcTimeoutMs }
    );
}

export type MissionState = {
    snapshot: MissionSnapshot;
    error: string;
    refresh: () => void;
};

export function useMissionSnapshot(dir: string): MissionState {
    const [snapshot, setSnapshot] = useState<MissionSnapshot>(null);
    const [error, setError] = useState<string>(null);
    const ask = useCallback(
        (fn: (dir: string) => Promise<MissionSnapshot>) => {
            if (!dir) {
                return;
            }
            fireAndForget(async () => {
                try {
                    const snap = await fn(dir);
                    if (snap?.dir === dir) {
                        setSnapshot(snap);
                        setError(null);
                    }
                } catch (e) {
                    setError(String(e?.message ?? e));
                }
            });
        },
        [dir]
    );
    useEffect(() => {
        setSnapshot(null);
        setError(null);
        if (!dir) {
            return;
        }
        const unsubscribe = waveEventSubscribeSingle({
            eventType: MissionUpdateEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const snap = event.data as MissionSnapshot;
                if (snap?.dir === dir) {
                    setSnapshot(snap);
                }
            },
        });
        ask((d) => missionGet(d));
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") {
                ask((d) => missionGet(d));
            }
        }, MissionPollMs);
        return () => {
            unsubscribe();
            clearInterval(timer);
        };
    }, [dir, ask]);
    const refresh = useCallback(() => ask(missionRefresh), [ask]);
    return { snapshot, error, refresh };
}

function missionCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: MissionRouteId, timeout: MissionRpcTimeoutMs });
}

export function missionRun(dir: string, kind: string, id: string, version?: string): Promise<RunResult> {
    return missionCall(MissionRunCommand, { dir, kind, id, version });
}

export function missionLog(dir: string, runid: string, from: number): Promise<LogChunk> {
    return missionCall(MissionLogCommand, { dir, runid, from });
}

export function missionCancel(dir: string, runid: string): Promise<void> {
    return missionCall(MissionCancelCommand, { dir, runid });
}

export function missionClose(dir: string, runid: string): Promise<void> {
    return missionCall(MissionCloseCommand, { dir, runid });
}

export function missionTrust(dir: string, hash: string): Promise<void> {
    return missionCall(MissionTrustCommand, { dir, hash });
}

// The project's runs, newest first, kept current by the collector's run events.
export function useMissionRuns(dir: string): RunRecord[] {
    const [runs, setRuns] = useState<RunRecord[]>([]);
    useEffect(() => {
        setRuns([]);
        if (!dir) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const list = await missionCall<RunRecord[]>(MissionRunsCommand, { dir });
            if (!cancelled) {
                setRuns(list ?? []);
            }
        });
        const unsubscribe = waveEventSubscribeSingle({
            eventType: MissionRunEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const run = event.data as RunRecord;
                if (run?.dir === dir) {
                    setRuns((current) => upsertRun(current, run));
                }
            },
        });
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [dir]);
    return runs;
}

export type CiRunResult = { run?: CiRunRecord; untrusted?: UntrustedInfo };

export function ciRun(dir: string, branch: string, force: boolean): Promise<CiRunResult> {
    return missionCall(MissionCiRunCommand, { dir, branch, force });
}

export function ciLog(dir: string, runid: string, job: string, from: number): Promise<LogChunk> {
    return missionCall(MissionCiLogCommand, { dir, runid, job, from });
}

export function ciCancel(dir: string, runid: string): Promise<void> {
    return missionCall(MissionCiCancelCommand, { dir, runid });
}

// The project's local CI: runs kept current by the runner's events; branches and their verdicts reread when a run
// ends.
export function useCiState(dir: string): { state: CiState; reload: () => void } {
    const [state, setState] = useState<CiState>(null);
    const load = useCallback(() => {
        if (!dir) {
            return;
        }
        fireAndForget(async () => {
            const next = await missionCall<CiState>(MissionCiStateCommand, { dir });
            setState(next);
        });
    }, [dir]);
    useEffect(() => {
        setState(null);
        if (!dir) {
            return;
        }
        load();
        const unsubscribe = waveEventSubscribeSingle({
            eventType: MissionCiEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const run = event.data as CiRunRecord;
                if (run?.dir !== dir) {
                    return;
                }
                setState((current) =>
                    current == null
                        ? current
                        : {
                              ...current,
                              runs: upsertCiRun(current.runs, run),
                              running:
                                  run.status === "running"
                                      ? run.id
                                      : current.running === run.id
                                        ? null
                                        : current.running,
                          }
                );
                if (run.status !== "running") {
                    load();
                }
            },
        });
        return () => unsubscribe();
    }, [dir, load]);
    return { state, reload: load };
}

export function missionBuilds(dir: string, fresh: boolean): Promise<BuildsFacts> {
    return TabRpcClient.wshRpcCall(MissionBuildsCommand, { dir, fresh }, { route: MissionRouteId, timeout: 60000 });
}
