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
import {
    DependencyState,
    GroupsAnswer,
    MissionDepsCommand,
    MissionDepSyncCommand,
    MissionGroupsCommand,
    MissionGroupsEvent,
    productGroupOfWorkspace,
    ProjectGroup,
} from "./group-model";
import { LogChunk, MissionSnapshot, RunRecord, RunResult, UntrustedInfo, upsertRun } from "./mission-model";
import { ReleaseChannel, ReleaseMilestone, ReleaseSession } from "./release-model";
import { ReleaseFacts } from "./release-run";

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
export const MissionReleaseCommand = "moltenmissionrelease";
export const MissionReleaseStartCommand = "moltenmissionreleasestart";
export const MissionReleaseEndCommand = "moltenmissionreleaseend";
export const MissionReleaseFactsCommand = "moltenmissionreleasefacts";
export const MissionReleaseStepCommand = "moltenmissionreleasestep";
export const MissionReleaseRerunCommand = "moltenmissionreleasererun";
export const MissionReleaseNotesCommand = "moltenmissionreleasenotes";
export const MissionReleaseNotesSaveCommand = "moltenmissionreleasenotessave";
export const MissionReleaseMilestoneCommand = "moltenmissionreleasemilestone";
export const MissionBranchesPlanCommand = "moltenmissionbranchesplan";
export const MissionBranchesCleanCommand = "moltenmissionbranchesclean";

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

// The project groups (FR-MC-026); with a folder, only the group it is a member of. Changes come as MissionGroupsEvent.
export function missionGroups(dir?: string): Promise<GroupsAnswer> {
    return TabRpcClient.wshRpcCall(
        MissionGroupsCommand,
        { dir: dir || undefined },
        { route: MissionRouteId, timeout: MissionRpcTimeoutMs }
    );
}

// The product group the workspace's project belongs to (FR-MC-028), null when it is in none: the collector's cached
// answer when the tab opens, then every model it publishes (each event carries all the groups). No poll and no
// collection of its own (FR-MC-028-AC6).
export function useMissionGroup(workspaceId: string, dir: string): ProjectGroup {
    const [group, setGroup] = useState<ProjectGroup>(null);
    useEffect(() => {
        setGroup(null);
        if (!workspaceId || !dir) {
            return;
        }
        let cancelled = false;
        let heard = false;
        const unsubscribe = waveEventSubscribeSingle({
            eventType: MissionGroupsEvent as WaveEventName,
            handler: (event) => {
                heard = true;
                setGroup(productGroupOfWorkspace((event.data as GroupsAnswer)?.groups, workspaceId));
            },
        });
        fireAndForget(async () => {
            try {
                const answer = await missionGroups(dir);
                if (!cancelled && !heard) {
                    setGroup(productGroupOfWorkspace(answer?.groups, workspaceId));
                }
            } catch (e) {
                console.log("project group:", e?.message ?? e);
            }
        });
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [workspaceId, dir]);
    return group;
}

// The dependencies of the project at dir (FR-MC-029), evaluated afresh.
export function missionDeps(dir: string): Promise<DependencyState[]> {
    return TabRpcClient.wshRpcCall(
        MissionDepsCommand,
        { dir },
        { route: MissionRouteId, timeout: MissionRpcTimeoutMs }
    );
}

// Starts the sync of one of the dependent's declarations (FR-MC-030); untrusted, nothing runs and the commands come
// back to review. Callers go through syncDependency (dep-sync.tsx), which asks for trust and waits for the end.
export function missionDepSync(dir: string, project?: string, index?: number): Promise<RunResult> {
    return TabRpcClient.wshRpcCall(
        MissionDepSyncCommand,
        { dir, project: project || undefined, index },
        { route: MissionRouteId, timeout: MissionRpcTimeoutMs }
    );
}

export function missionRuns(dir: string): Promise<RunRecord[]> {
    return TabRpcClient.wshRpcCall(
        MissionRunsCommand,
        { dir },
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

export type ReleaseStartResult = { session?: ReleaseSession; run?: RunRecord; untrusted?: UntrustedInfo };

export function releaseStart(dir: string, channel: ReleaseChannel, tag: string): Promise<ReleaseStartResult> {
    return missionCall(MissionReleaseStartCommand, { dir, channel, tag });
}

// Ends the release launched from the Project tab, or stops following a tag cut at the terminal.
export function releaseEnd(dir: string, tag?: string): Promise<void> {
    return missionCall(MissionReleaseEndCommand, { dir, tag });
}

const ReleaseSessionPollMs = 30000;

// The release on its way, read again every half minute and whenever the caller asks (after a start, a run's end).
export function useReleaseSession(dir: string): { session: ReleaseSession; reload: () => void } {
    const [session, setSession] = useState<ReleaseSession>(null);
    const load = useCallback(() => {
        if (!dir) {
            return;
        }
        fireAndForget(async () => {
            try {
                setSession(await missionCall<ReleaseSession>(MissionReleaseCommand, { dir }));
            } catch {
                setSession(null);
            }
        });
    }, [dir]);
    useEffect(() => {
        setSession(null);
        load();
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") {
                load();
            }
        }, ReleaseSessionPollMs);
        return () => clearInterval(timer);
    }, [load]);
    return { session, reload: load };
}

// Reading the facts fetches the tags and asks GitHub: slower than the other calls.
const ReleaseFactsTimeoutMs = 60000;
const ReleaseFactsPollMs = 15000;
const ReleaseIdlePollMs = 120000;

function releaseCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: MissionRouteId, timeout: ReleaseFactsTimeoutMs });
}

export function releaseRunStep(dir: string, tag: string, step: string): Promise<RunResult> {
    return releaseCall(MissionReleaseStepCommand, { dir, tag, step });
}

export function releaseRerunFailed(dir: string, tag: string): Promise<void> {
    return releaseCall(MissionReleaseRerunCommand, { dir, tag });
}

export function releaseNotes(dir: string, tag: string): Promise<{ path: string; text: string }> {
    return releaseCall(MissionReleaseNotesCommand, { dir, tag });
}

export function releaseNotesSave(dir: string, tag: string, text: string): Promise<void> {
    return releaseCall(MissionReleaseNotesSaveCommand, { dir, tag, text });
}

// The open milestone of a public version and its open issues; null when the project has none.
export function releaseMilestone(dir: string, version: string): Promise<ReleaseMilestone> {
    return releaseCall(MissionReleaseMilestoneCommand, { dir, version });
}

// The facts of the release followed: read again every 15 s while one is, every 2 min otherwise, and whenever `bump`
// changes (a release step ran or ended).
export function useReleaseFacts(dir: string, bump: string): { facts: ReleaseFacts; reload: () => void } {
    const [facts, setFacts] = useState<ReleaseFacts>(null);
    const [tick, setTick] = useState(0);
    const reload = useCallback(() => setTick((t) => t + 1), []);
    useEffect(() => {
        setFacts(null);
    }, [dir]);
    useEffect(() => {
        if (!dir) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const next = await releaseCall<ReleaseFacts>(MissionReleaseFactsCommand, { dir });
                if (!cancelled) {
                    setFacts(next);
                }
            } catch {
                // The panel keeps the last facts it read.
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir, bump, tick]);
    const followed = !!facts?.tag;
    useEffect(() => {
        const timer = setInterval(
            () => {
                if (document.visibilityState === "visible") {
                    reload();
                }
            },
            followed ? ReleaseFactsPollMs : ReleaseIdlePollMs
        );
        return () => clearInterval(timer);
    }, [followed, reload]);
    return { facts, reload };
}

// must match BranchPlan and BranchesCleanResult in pkg/molten/mission/branches.go
export type BranchKeepReason =
    | "protected"
    | "not-on-trunk"
    | "content-unknown"
    | "checked-out"
    | "open-pr"
    | "pr-unknown";
export type BranchPlan = { name: string; remote: boolean; action: "delete" | "keep"; reason?: BranchKeepReason };
export type BranchesPlan = { trunk: string; branches: BranchPlan[] };
export type BranchesCleanResult = { deleted: string[]; failed: number; errors?: string[] };

export function branchesPlan(dir: string): Promise<BranchesPlan> {
    return releaseCall(MissionBranchesPlanCommand, { dir });
}

export function branchesClean(dir: string, names: string[]): Promise<BranchesCleanResult> {
    return releaseCall(MissionBranchesCleanCommand, { dir, names });
}
