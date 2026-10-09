// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The companion's "Workspace task" section (FR-CONT-007): the task checkpoint of the terminal's workspace, which
// every agent continues from. It shows when it was last updated and by whom, opens it rendered or in the code editor
// (a saved edit is kept: automatic updates never overwrite it) and starts a new task after a confirmation.

import { createBlockSplitHorizontally } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getActiveTabModel } from "@/app/store/tab-model";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { MoltenWave } from "../molten-button";
import { relativeTime } from "./companion-model";
import {
    newerTask,
    redactionLabel,
    TaskClearCommand,
    TaskEvent,
    TaskReadCommand,
    TaskRoute,
    taskSummary,
    TaskView,
} from "./companion-task-model";

const RpcTimeoutMs = 5000;
const RefreshMs = 15000;
const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-11 text-secondary hover:bg-hover hover:text-primary";
const DangerButton = "molten-btn molten-btn-destructive cursor-pointer rounded-6 px-2 py-1 text-11";

function taskCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: TaskRoute, timeout: RpcTimeoutMs });
}

// Opens the checkpoint next to the companion: rendered, or in the code editor. A preview of the file in the tab is
// reused.
async function openTaskFile(path: string, edit: boolean, fromBlockId: string): Promise<void> {
    const tabAtom = getActiveTabModel()?.tabAtom;
    const tab = tabAtom == null ? null : globalStore.get(tabAtom);
    const layoutModel = getLayoutModelForStaticTab();
    for (const blockId of tab?.blockids ?? []) {
        const meta = globalStore.get(getWaveObjectAtom<Block>(makeORef("block", blockId)))?.meta;
        if (meta?.view !== "preview" || meta?.file !== path || (meta?.connection ?? "") !== "") {
            continue;
        }
        const node = layoutModel?.getNodeByBlockId(blockId);
        if (node == null) {
            continue;
        }
        await RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("block", blockId), meta: { edit } as MetaType });
        layoutModel.focusNode(node.id);
        return;
    }
    await createBlockSplitHorizontally(
        { meta: { view: "preview", file: path, edit } as MetaType },
        fromBlockId,
        "after"
    );
}

// Reads the checkpoint of the terminal's workspace, again on each change wavesrv announces for that workspace.
function useWorkspaceTask(target: string): { view: TaskView; error: string; setView: (v: TaskView) => void } {
    const [view, setViewState] = useState<TaskView>(null);
    const [error, setError] = useState<string>(null);
    const [reload, setReload] = useState(0);
    const setView = (next: TaskView) => setViewState((cur) => newerTask(cur, next));
    useEffect(() => {
        if (!target) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const next = await taskCall<TaskView>(TaskReadCommand, { blockid: target });
                if (!cancelled) {
                    setViewState((cur) => newerTask(cur, next));
                    setError(null);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(String(e?.message ?? e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [target, reload]);
    const wsId = view?.workspaceid;
    useEffect(() => {
        if (!wsId) {
            return;
        }
        let unsubscribe = () => {};
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: TaskEvent as WaveEventName,
                scope: makeORef("workspace", wsId),
                handler: () => setReload((n) => n + 1),
            });
        } catch (e) {
            console.log("workspace task: no event bus", e);
        }
        return () => unsubscribe();
    }, [wsId]);
    // A save in the editor writes the file without an event; the periodic read also keeps "updated … ago" current.
    useEffect(() => {
        if (!target) {
            return;
        }
        const timer = setInterval(() => setReload((n) => n + 1), RefreshMs);
        return () => clearInterval(timer);
    }, [target]);
    return { view, error, setView };
}

export function WorkspaceTaskSection({ target, companionId }: { target: string; companionId: string }) {
    const { view, error, setView } = useWorkspaceTask(target);
    const [confirming, setConfirming] = useState(false);
    const [actionError, setActionError] = useState<string>(null);
    if (view == null) {
        if (!error) {
            return null;
        }
        return (
            <TaskFrame>
                <div className="px-3 pb-3 text-12 text-muted">The workspace task is not available: {error}</div>
            </TaskFrame>
        );
    }
    const run = (fn: () => Promise<void>) =>
        fireAndForget(async () => {
            try {
                setActionError(null);
                await fn();
            } catch (e) {
                setActionError(String(e?.message ?? e));
            }
        });
    const open = (edit: boolean) =>
        run(async () => {
            const current = edit ? await taskCall<TaskView>(TaskReadCommand, { blockid: target, create: true }) : view;
            if (edit) {
                setView(current);
            }
            await openTaskFile(current.path, edit, companionId);
        });
    const clear = () =>
        run(async () => {
            setConfirming(false);
            setView(await taskCall<TaskView>(TaskClearCommand, { blockid: target }));
        });
    return (
        <WorkspaceTaskCard
            view={view}
            now={Date.now()}
            confirming={confirming}
            actionError={actionError ?? (error ? `Not refreshed: ${error}` : null)}
            onOpen={() => open(false)}
            onEdit={() => open(true)}
            onAskClear={() => setConfirming(true)}
            onCancelClear={() => setConfirming(false)}
            onClear={clear}
        />
    );
}

export type WorkspaceTaskCardProps = {
    view: TaskView;
    now: number;
    confirming: boolean;
    actionError: string;
    onOpen: () => void;
    onEdit: () => void;
    onAskClear: () => void;
    onCancelClear: () => void;
    onClear: () => void;
};

export function WorkspaceTaskCard({
    view,
    now,
    confirming,
    actionError,
    onOpen,
    onEdit,
    onAskClear,
    onCancelClear,
    onClear,
}: WorkspaceTaskCardProps) {
    const summary = taskSummary(view);
    const updated = relativeTime(view.updated, now);
    return (
        <TaskFrame
            right={
                updated ? (
                    <span className="text-11 text-muted" title={new Date(view.updated).toLocaleString()}>
                        {`updated ${updated}`}
                    </span>
                ) : null
            }
        >
            <div className="flex flex-col gap-1.5 px-3 pb-3 text-12" data-testid="companion-task">
                {summary.empty ? (
                    <div className="text-muted">
                        No task recorded yet: it fills in at the end of the agent&apos;s next turn.
                    </div>
                ) : (
                    <>
                        {summary.goal ? (
                            <div className="line-clamp-3 text-primary" title={summary.goal}>
                                {summary.goal}
                            </div>
                        ) : (
                            <div className="text-muted">No goal yet.</div>
                        )}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-11 text-secondary">
                            {summary.ticket ? <span>{summary.ticket}</span> : null}
                            {summary.plan.total > 0 ? (
                                <span className="tabular-nums">{`Plan ${summary.plan.done} / ${summary.plan.total}`}</span>
                            ) : null}
                            {summary.files > 0 ? (
                                <span className="tabular-nums">{`${summary.files} file${summary.files === 1 ? "" : "s"}`}</span>
                            ) : null}
                        </div>
                        {summary.next ? (
                            <div className="text-11 text-secondary">
                                <span className="text-muted">Next: </span>
                                {summary.next}
                            </div>
                        ) : null}
                        <div className="flex flex-wrap gap-x-3 text-11 text-muted">
                            {summary.by ? <span>{`by ${summary.by}`}</span> : null}
                            {summary.redactions > 0 ? (
                                <span data-testid="companion-task-redactions">
                                    <i className="fa fa-solid fa-shield-halved mr-1" />
                                    {redactionLabel(summary.redactions)}
                                </span>
                            ) : null}
                            {summary.versions > 0 ? (
                                <span>{`${summary.versions} earlier version${summary.versions === 1 ? "" : "s"}`}</span>
                            ) : null}
                        </div>
                    </>
                )}
                {confirming ? (
                    <div className="mt-1 flex flex-col gap-1.5 rounded-4 border border-border p-2">
                        <div className="text-secondary">
                            Start a new task? The current checkpoint stays in the history (molten task history).
                        </div>
                        <div className="flex gap-2">
                            <button type="button" className={DangerButton} onClick={onClear}>
                                Start a new task
                                <MoltenWave />
                            </button>
                            <button type="button" className={PlainButton} onClick={onCancelClear}>
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="mt-1 flex gap-2">
                        {view.exists ? (
                            <button type="button" className={PlainButton} onClick={onOpen}>
                                Open
                            </button>
                        ) : null}
                        <button type="button" className={PlainButton} onClick={onEdit}>
                            Edit
                        </button>
                        {view.exists && !summary.empty ? (
                            <button type="button" className={PlainButton} onClick={onAskClear}>
                                Clear…
                            </button>
                        ) : null}
                    </div>
                )}
                {actionError ? <div className="text-11 text-error">{actionError}</div> : null}
            </div>
        </TaskFrame>
    );
}

function TaskFrame({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
    return (
        <>
            <div className="flex items-center gap-2 px-3 pt-3 pb-1">
                <div className="text-11 font-semibold tracking-wide text-muted uppercase">Workspace task</div>
                <div className="ml-auto flex items-center gap-1">{right}</div>
            </div>
            {children}
        </>
    );
}
