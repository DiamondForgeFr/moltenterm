// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The panels' side of Mission Control's collector (DS-MC-001): they ask wavesrv, show the cached answer at once, and
// take the refreshed snapshot from the event bus. Panels poll only while the window is visible.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { serverErrorText, ServerText } from "../i18n/server-text";
import { whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import type { WorktreeTerminal } from "../worktree-model";
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
import { MissionRequests } from "./mission-requests";
import { useMissionScope } from "./mission-scope";
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
// must match UntrustedCommand in pkg/molten/mission/trust_ask.go
export const MissionUntrustedCommand = "moltenmissionuntrusted";
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
export const MissionReleaseDispatchCommand = "moltenmissionreleasedispatch";
export const MissionReleaseNotesCommand = "moltenmissionreleasenotes";
export const MissionReleaseNotesSaveCommand = "moltenmissionreleasenotessave";
export const MissionReleaseMilestoneCommand = "moltenmissionreleasemilestone";
export const MissionBranchesPlanCommand = "moltenmissionbranchesplan";
export const MissionBranchesCleanCommand = "moltenmissionbranchesclean";
export const MissionBranchesAutoDeleteCommand = "moltenmissionbranchesautodelete";
export const MissionBranchesCloseCommand = "moltenmissionbranchesclose";
export const MissionTreePrsCommand = "moltenmissiontreeprs";
export const MissionGitInitCommand = "moltenmissiongitinit";
// must match pkg/molten/mission/github_run.go
export const MissionGithubRunLogCommand = "moltenmissionghrunlog";
export const MissionGithubRunRerunCommand = "moltenmissionghrunrerun";

const MissionRpcTimeoutMs = 15000;
// gh reads a whole run's log from GitHub: longer than the cached snapshot (the backend stops at 45 s).
const GithubRunTimeoutMs = 50000;
// A request is cheap (the cached snapshot and the pipeline file); the collector itself refreshes at most once a minute.
const MissionPollMs = 15000;

// git init in a linked folder that is not inside a repository (FR-SHELL-053); answers with the refreshed snapshot.
export function missionGitInit(dir: string): Promise<MissionSnapshot> {
    return TabRpcClient.wshRpcCall(
        MissionGitInitCommand,
        { dir },
        { route: MissionRouteId, timeout: MissionRpcTimeoutMs }
    );
}

// passive: the status bar keeping a linked project warm without a Mission Control view; wavesrv then reads git only
// after a change and GitHub rarely (FR-PERF-011).
export function missionGet(dir: string, maxAgeSec?: number, passive?: boolean): Promise<MissionSnapshot> {
    return TabRpcClient.wshRpcCall(
        MissionGetCommand,
        { dir, maxagesec: maxAgeSec, passive: passive || undefined },
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
    const { value: group, setValue: setGroup } = useMissionScope<ProjectGroup>(
        JSON.stringify([workspaceId, dir]),
        null
    );
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
                if (cancelled) {
                    return;
                }
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
    }, [workspaceId, dir, setGroup]);
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
    const panelId = usePanelBlockId();
    const {
        scope,
        value,
        setValue,
        reload: refresh,
    } = useMissionScope<Pick<MissionState, "snapshot" | "error">>(JSON.stringify([dir, panelId]), null);
    useEffect(() => {
        setValue(null);
        if (!dir) {
            return;
        }
        const requests = new MissionRequests();
        const ask = (fn: (dir: string) => Promise<MissionSnapshot>) => {
            const request = requests.begin();
            if (!request) {
                return;
            }
            fireAndForget(async () => {
                try {
                    const snap = await fn(dir);
                    if (requests.accepts(request, true) && snap?.dir === dir) {
                        setValue({ snapshot: snap, error: null });
                    }
                } catch (e) {
                    if (requests.accepts(request, true)) {
                        setValue((current) => ({ snapshot: current?.snapshot ?? null, error: serverErrorText(e) }));
                    }
                }
            });
        };
        scope.reload = () => ask(missionRefresh);
        const unsubscribe = waveEventSubscribeSingle({
            eventType: MissionUpdateEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const snap = event.data as MissionSnapshot;
                if (snap?.dir === dir && requests.hear()) {
                    setValue({ snapshot: snap, error: null });
                }
            },
        });
        ask((d) => missionGet(d));
        const stop = everyInPanel(panelId, whileShown(MissionPollMs), () => ask((d) => missionGet(d)), "mission");
        return () => {
            requests.dispose();
            scope.reload = () => {};
            unsubscribe();
            stop();
        };
    }, [dir, scope, setValue, panelId]);
    return { snapshot: value?.snapshot ?? null, error: value?.error ?? null, refresh };
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

// The folder's commands as a run reads them, when they are not trusted yet; null once they are (#1017).
export function missionUntrusted(dir: string): Promise<UntrustedInfo> {
    return missionCall(MissionUntrustedCommand, { dir });
}

// The project's runs, newest first, kept current by the collector's run events.
export function useMissionRuns(dir: string): RunRecord[] {
    const { value: runs, setValue: setRuns } = useMissionScope<RunRecord[]>(dir, null);
    useEffect(() => {
        setRuns([]);
        if (!dir) {
            return;
        }
        const requests = new MissionRequests();
        let pending = true;
        const events = new Map<string, RunRecord>();
        const unsubscribe = waveEventSubscribeSingle({
            eventType: MissionRunEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const run = event.data as RunRecord;
                if (run?.dir === dir && requests.hear()) {
                    if (pending) {
                        events.set(run.id, run);
                    }
                    setRuns((current) => upsertRun(current, run));
                }
            },
        });
        const request = requests.begin();
        fireAndForget(async () => {
            try {
                const list = await missionCall<RunRecord[]>(MissionRunsCommand, { dir });
                if (requests.accepts(request)) {
                    setRuns(
                        [...events.values()].reduce<RunRecord[]>((current, run) => upsertRun(current, run), list ?? [])
                    );
                }
            } finally {
                pending = false;
                events.clear();
            }
        });
        return () => {
            requests.dispose();
            events.clear();
            unsubscribe();
        };
    }, [dir, setRuns]);
    return runs ?? [];
}

export type CiRunResult = { run?: CiRunRecord; untrusted?: UntrustedInfo };

export function ciRun(dir: string, branch: string, force: boolean): Promise<CiRunResult> {
    return missionCall(MissionCiRunCommand, { dir, branch, force });
}

export type GithubRunLog = { text: string; failedonly?: boolean; truncated?: boolean };

// A GitHub Actions run's log, read through gh: the failed steps when the run failed (FR-SHELL-057).
export function githubRunLog(dir: string, runid: number, failed: boolean): Promise<GithubRunLog> {
    return TabRpcClient.wshRpcCall(
        MissionGithubRunLogCommand,
        { dir, runid, failed },
        { route: MissionRouteId, timeout: GithubRunTimeoutMs }
    );
}

// Starts a GitHub Actions run again, its failed jobs only when asked; the window confirms first (FR-SHELL-057).
export function githubRunRerun(dir: string, runid: number, failed: boolean): Promise<void> {
    return TabRpcClient.wshRpcCall(
        MissionGithubRunRerunCommand,
        { dir, runid, failed },
        { route: MissionRouteId, timeout: GithubRunTimeoutMs }
    );
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
    const { scope, value: state, setValue: setState, reload } = useMissionScope<CiState>(dir, null);
    useEffect(() => {
        setState(null);
        if (!dir) {
            return;
        }
        const requests = new MissionRequests();
        let events: CiRunRecord[] = [];
        let pending = false;
        const applyRun = (current: CiState, run: CiRunRecord): CiState =>
            current == null
                ? current
                : {
                      ...current,
                      runs: upsertCiRun(current.runs, run),
                      running: run.status === "running" ? run.id : current.running === run.id ? null : current.running,
                  };
        const load = () => {
            const request = requests.begin();
            if (!request) {
                return;
            }
            events = [];
            pending = true;
            fireAndForget(async () => {
                try {
                    const next = await missionCall<CiState>(MissionCiStateCommand, { dir });
                    if (requests.accepts(request)) {
                        setState(events.reduce(applyRun, next));
                    }
                } finally {
                    if (requests.accepts(request)) {
                        pending = false;
                        events = [];
                    }
                }
            });
        };
        scope.reload = load;
        const unsubscribe = waveEventSubscribeSingle({
            eventType: MissionCiEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const run = event.data as CiRunRecord;
                if (run?.dir !== dir || !requests.hear()) {
                    return;
                }
                if (pending) {
                    events.push(run);
                }
                setState((current) => applyRun(current, run));
                if (run.status !== "running") {
                    load();
                }
            },
        });
        load();
        return () => {
            requests.dispose();
            scope.reload = () => {};
            events = [];
            unsubscribe();
        };
    }, [dir, scope, setState]);
    return { state, reload };
}

export function missionBuilds(dir: string, fresh: boolean): Promise<BuildsFacts> {
    return TabRpcClient.wshRpcCall(MissionBuildsCommand, { dir, fresh }, { route: MissionRouteId, timeout: 60000 });
}

// must match PipelineDrift in pkg/molten/mission/release_drift.go: the checkout's pipeline is not the one the release
// branch is made from (#1095).
export type PipelineDrift = { uncommitted?: boolean; base?: string };

export type ReleaseStartResult = {
    session?: ReleaseSession;
    run?: RunRecord;
    untrusted?: UntrustedInfo;
    // Nothing started: the pipeline is uncommitted or differs from origin's trunk, to be confirmed.
    pipelinedrift?: PipelineDrift;
};

// force: starts although the pipeline drifted, the developer having confirmed it.
export function releaseStart(
    dir: string,
    channel: ReleaseChannel,
    tag: string,
    force?: boolean
): Promise<ReleaseStartResult> {
    return missionCall(MissionReleaseStartCommand, { dir, channel, tag, force: force || undefined });
}

// Ends the release launched from the Project tab, or stops following a tag cut at the terminal.
export function releaseEnd(dir: string, tag?: string): Promise<void> {
    return missionCall(MissionReleaseEndCommand, { dir, tag });
}

const ReleaseSessionPollMs = 30000;

// The release on its way, read again every half minute and whenever the caller asks (after a start, a run's end).
export function useReleaseSession(dir: string): { session: ReleaseSession; reload: () => void } {
    const panelId = usePanelBlockId();
    const {
        scope,
        value: session,
        setValue: setSession,
        reload,
    } = useMissionScope<ReleaseSession>(JSON.stringify([dir, panelId]), null);
    useEffect(() => {
        setSession(null);
        if (!dir) {
            return;
        }
        const requests = new MissionRequests();
        const load = () => {
            const request = requests.begin();
            if (!request) {
                return;
            }
            fireAndForget(async () => {
                try {
                    const next = await missionCall<ReleaseSession>(MissionReleaseCommand, { dir });
                    if (requests.accepts(request)) {
                        setSession(next);
                    }
                } catch {
                    if (requests.accepts(request)) {
                        setSession(null);
                    }
                }
            });
        };
        scope.reload = load;
        load();
        const stop = everyInPanel(panelId, whileShown(ReleaseSessionPollMs), load, "mission-release-session");
        return () => {
            requests.dispose();
            scope.reload = () => {};
            stop();
        };
    }, [dir, scope, setSession, panelId]);
    return { session, reload };
}

// Reading the facts fetches the tags and asks GitHub: slower than the other calls.
const ReleaseFactsTimeoutMs = 60000;
const ReleaseFactsPollMs = 15000;
const ReleaseIdlePollMs = 120000;

function releaseCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: MissionRouteId, timeout: ReleaseFactsTimeoutMs });
}

// force: records a manual step although its check failed (#1095).
export function releaseRunStep(dir: string, tag: string, step: string, force?: boolean): Promise<RunResult> {
    return releaseCall(MissionReleaseStepCommand, { dir, tag, step, force: force || undefined });
}

export function releaseRerunFailed(dir: string, tag: string): Promise<void> {
    return releaseCall(MissionReleaseRerunCommand, { dir, tag });
}

// Starts on the tag a workflow the tag should have started and did not (#1040).
export function releaseDispatchWorkflow(dir: string, tag: string, workflow: string): Promise<void> {
    return releaseCall(MissionReleaseDispatchCommand, { dir, tag, workflow });
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
    const { scope, value: facts, setValue: setFacts, reload } = useMissionScope<ReleaseFacts>(dir, null);
    const [tick, setTick] = useState(0);
    const panelId = usePanelBlockId();
    useEffect(() => {
        setFacts(null);
    }, [dir, setFacts]);
    useEffect(() => {
        if (!dir) {
            return;
        }
        let cancelled = false;
        scope.reload = () => setTick((t) => t + 1);
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
            scope.reload = () => {};
        };
    }, [dir, bump, tick, scope, setFacts]);
    const followed = !!facts?.tag;
    useEffect(() => {
        if (!dir) {
            return;
        }
        let active = true;
        const stop = everyInPanel(
            panelId,
            whileShown(followed ? ReleaseFactsPollMs : ReleaseIdlePollMs),
            () => {
                if (active) {
                    reload();
                }
            },
            "mission-release-facts"
        );
        return () => {
            active = false;
            stop();
        };
    }, [dir, followed, reload, panelId]);
    return { facts, reload };
}

// must match BranchPlan and BranchesCleanResult in pkg/molten/mission/branches.go
export type BranchDeleteReason =
    | "merged-pr"
    | "merged-pr-worktree"
    | "merged-worktree"
    | "on-trunk"
    | "patches-on-trunk";
export type BranchKeepReason =
    | "protected"
    | "not-on-trunk"
    | "content-unknown"
    | "checked-out"
    | "open-pr"
    | "pr-unknown"
    | "commits-after-pr"
    | "not-in-pr"
    | "worktree-changes"
    | "worktree-in-use"
    | "worktree-operation"
    | "worktree-process"
    | "worktree-refused"
    | "worktree-commits"
    | "pr-assets"
    | "tool-branch";
export type TreeTool = "moltenterm" | "claude-code" | "conductor" | "codex";
export type TreeProcess = { pid: number; name: string };
export type BranchPlan = {
    name: string;
    remote: boolean;
    action: "delete" | "keep";
    reason?: BranchDeleteReason | BranchKeepReason;
    pr?: number;
    // The linked worktree holding the branch (#906, #1028): removed with it, or why it stays.
    worktree?: string;
    // The terminals holding that worktree open, with worktree-in-use (#932).
    terminals?: WorktreeTerminal[];
    // #1028: the tool that made the worktree, outside the project folder, locked, the ignored files going with it, the
    // processes working in it, the git operation in progress; confirm: it goes only when the developer checks it.
    tool?: TreeTool;
    outside?: boolean;
    locked?: boolean;
    ignoredfiles?: number;
    processes?: TreeProcess[];
    // Not from wavesrv's plan: the processes as a kept branch's error already lists them (cleanErrorLines).
    processestext?: string;
    operation?: string;
    confirm?: boolean;
};
export type BranchesPlan = { trunk: string; branches: BranchPlan[]; autodeleteoffer?: boolean };
export type BranchesCleanResult = {
    deleted: string[];
    failed: number;
    errors?: string[];
    // The codes of errors, by position (#656).
    errorstext?: ServerText[];
};

export function branchesPlan(dir: string): Promise<BranchesPlan> {
    return releaseCall(MissionBranchesPlanCommand, { dir });
}

// worktrees: the folders of the confirm worktrees the developer checked (#1028); wavesrv removes no other.
export function branchesClean(dir: string, names: string[], worktrees?: string[]): Promise<BranchesCleanResult> {
    return releaseCall(MissionBranchesCleanCommand, { dir, names, worktrees });
}

// Closes the terminals holding a merged PR's worktree, then cleans its branch (#932): wavesrv plans twice, hence the
// longer wait.
export function branchesCloseAndClean(dir: string, name: string, blockIds: string[]): Promise<BranchesCleanResult> {
    return TabRpcClient.wshRpcCall(
        MissionBranchesCloseCommand,
        { dir, name, blockids: blockIds },
        { route: MissionRouteId, timeout: 2 * ReleaseFactsTimeoutMs + 10000 }
    );
}

// must match TreeBranch and TreePr in pkg/molten/mission/branches_close.go
export type TreeBranch = { path: string; branch: string };
export type TreePr = { path: string; branch: string; pr: number };

export function treePrs(trees: TreeBranch[]): Promise<{ merged: TreePr[] }> {
    return releaseCall(MissionTreePrsCommand, { trees });
}

export function branchesAutoDelete(dir: string, enable: boolean): Promise<void> {
    return releaseCall(MissionBranchesAutoDeleteCommand, { dir, enable });
}
