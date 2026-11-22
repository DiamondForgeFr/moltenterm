// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import { ArrangeGhost } from "./companion-ghost";
import { CompanionView, relativeTime, sessionRelation } from "./companion-model";
import { SectionTitle } from "./companion-section";
import {
    newerTask,
    redactionLabel,
    TaskClearCommand,
    TaskEvent,
    TaskReadCommand,
    TaskRoute,
    taskSessionLabel,
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
    const panelId = usePanelBlockId();
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
                    setError(serverErrorText(e));
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
        return everyInPanel(panelId, whileShown(RefreshMs), () => setReload((n) => n + 1), "companion-task");
    }, [target, panelId]);
    return { view, error, setView };
}

// The task in a block of the dashboard (#2441): its tools (the update, Edit, Clear…) in the block's tools notch, its
// body inside; other says the task was written by a session other than the one shown.
export type TaskFrameFn = (parts: { tools: React.ReactNode; body: React.ReactNode; other: boolean }) => React.ReactNode;

export function WorkspaceTaskSection({
    target,
    companionId,
    companion,
    frame,
}: {
    target: string;
    companionId: string;
    companion?: CompanionView;
    frame?: TaskFrameFn;
}) {
    const t = useT();
    const { view, error, setView } = useWorkspaceTask(target);
    const [confirming, setConfirming] = useState(false);
    const [actionError, setActionError] = useState<string>(null);
    if (view == null) {
        if (!error) {
            return <ArrangeGhost id="task" kind="when" />;
        }
        if (frame != null) {
            return frame({
                tools: null,
                other: false,
                body: <div className="mt-cb-empty">{t("companion.task.unavailable", { error })}</div>,
            });
        }
        return (
            <TaskFrame>
                <div className="px-(--mt-companion-inset) pb-3 text-12 text-muted">
                    {t("companion.task.unavailable", { error })}
                </div>
            </TaskFrame>
        );
    }
    const run = (fn: () => Promise<void>) =>
        fireAndForget(async () => {
            try {
                setActionError(null);
                await fn();
            } catch (e) {
                setActionError(serverErrorText(e));
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
            session={taskSessionLabel(view, companion)}
            now={Date.now()}
            confirming={confirming}
            actionError={actionError ?? (error ? t("companion.task.notRefreshed", { error }) : null)}
            onOpen={() => open(false)}
            onEdit={() => open(true)}
            onAskClear={() => setConfirming(true)}
            onCancelClear={() => setConfirming(false)}
            onClear={clear}
            frame={frame}
            other={sessionRelation(view.transcript?.path ?? "", companion) === "other"}
        />
    );
}

export type WorkspaceTaskCardProps = {
    view: TaskView;
    // Which session of the terminal last wrote the task (#600), "" when unknown.
    session?: string;
    now: number;
    confirming: boolean;
    actionError: string;
    onOpen: () => void;
    onEdit: () => void;
    onAskClear: () => void;
    onCancelClear: () => void;
    onClear: () => void;
    frame?: TaskFrameFn;
    other?: boolean;
};

export function WorkspaceTaskCard({
    view,
    session,
    now,
    confirming,
    actionError,
    onOpen,
    onEdit,
    onAskClear,
    onCancelClear,
    onClear,
    frame,
    other,
}: WorkspaceTaskCardProps) {
    const t = useT();
    const summary = taskSummary(view);
    const updated = relativeTime(view.updated, now);
    const framed = frame != null;
    const updatedNode = updated ? (
        <span className="text-11 text-muted" data-tip={new Date(view.updated).toLocaleString()}>
            {t("companion.history.updatedAgo", { ago: updated })}
        </span>
    ) : null;
    const canClear = view.exists && !summary.empty;
    const body = (
        <div
            className={
                framed ? "flex flex-col gap-2 text-12" : "flex flex-col gap-1.5 px-(--mt-companion-inset) pb-3 text-12"
            }
            data-testid="companion-task"
        >
            {framed && (session || updatedNode) ? (
                <div className="mt-cdash-prov" data-testid="companion-task-session">
                    {session ? <span className="mt-cdash-tag">{session}</span> : null}
                    {updatedNode}
                </div>
            ) : null}
            {summary.empty ? (
                <div className="text-muted">{t("companion.task.empty")}</div>
            ) : (
                <>
                    {summary.goal ? (
                        <div
                            className={framed ? "mt-cdash-task-goal line-clamp-3" : "line-clamp-3 text-primary"}
                            data-tip={summary.goal}
                        >
                            {summary.goal}
                        </div>
                    ) : (
                        <div className="text-muted">{t("companion.task.noGoal")}</div>
                    )}
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-11 text-secondary">
                        {summary.ticket ? <span>{summary.ticket}</span> : null}
                        {summary.plan.total > 0 ? (
                            <span className="tabular-nums">
                                {t("companion.task.plan", { done: summary.plan.done, total: summary.plan.total })}
                            </span>
                        ) : null}
                        {summary.files > 0 ? (
                            <span className="tabular-nums">
                                {t(summary.files === 1 ? "companion.topics.filesOne" : "companion.topics.filesOther", {
                                    count: summary.files,
                                })}
                            </span>
                        ) : null}
                    </div>
                    {summary.next ? (
                        <div className="text-11 text-secondary">
                            <span className="text-muted">{t("companion.task.next")} </span>
                            {summary.next}
                        </div>
                    ) : null}
                    <div className="flex flex-wrap gap-x-3 text-11 text-muted">
                        {summary.by ? (
                            <span data-testid="companion-task-by">
                                {[t("companion.task.by", { who: summary.by }), session].filter((s) => !!s).join(" · ")}
                            </span>
                        ) : null}
                        {summary.redactions > 0 ? (
                            <span data-testid="companion-task-redactions">
                                <i className="fa fa-solid fa-shield-halved mr-1" />
                                {redactionLabel(summary.redactions)}
                            </span>
                        ) : null}
                        {summary.versions > 0 ? (
                            <span>
                                {t(
                                    summary.versions === 1
                                        ? "companion.task.versionsOne"
                                        : "companion.task.versionsOther",
                                    { count: summary.versions }
                                )}
                            </span>
                        ) : null}
                    </div>
                </>
            )}
            {confirming ? (
                <div className="mt-1 flex flex-col gap-1.5 rounded-4 border border-border p-2">
                    <div className="text-secondary">{t("companion.task.confirmClear")}</div>
                    <div className="flex gap-2">
                        <button type="button" className={DangerButton} onClick={onClear}>
                            {t("companion.task.newTask")}
                            <MoltenWave />
                        </button>
                        <button type="button" className={PlainButton} onClick={onCancelClear}>
                            {t("common.cancel")}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="mt-1 flex gap-2">
                    {view.exists ? (
                        <button type="button" className={PlainButton} onClick={onOpen}>
                            {t("common.open")}
                        </button>
                    ) : null}
                    {framed ? null : (
                        <button type="button" className={PlainButton} onClick={onEdit}>
                            {t("companion.task.edit")}
                        </button>
                    )}
                    {!framed && canClear ? (
                        <button type="button" className={PlainButton} onClick={onAskClear}>
                            {t("companion.task.clear")}
                        </button>
                    ) : null}
                </div>
            )}
            {actionError ? <div className="text-11 text-danger">{actionError}</div> : null}
        </div>
    );
    if (framed) {
        return frame({
            other: other === true,
            body,
            tools: (
                <>
                    <button
                        type="button"
                        className="mt-cb-tool"
                        onClick={(e) => {
                            e.stopPropagation();
                            onEdit();
                        }}
                    >
                        {t("companion.task.edit")}
                    </button>
                    {canClear && !confirming ? (
                        <button
                            type="button"
                            className="mt-cb-tool"
                            onClick={(e) => {
                                e.stopPropagation();
                                onAskClear();
                            }}
                        >
                            {t("companion.task.clear")}
                        </button>
                    ) : null}
                </>
            ),
        });
    }
    return <TaskFrame right={updatedNode}>{body}</TaskFrame>;
}

function TaskFrame({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
    const t = useT();
    return (
        <>
            <SectionTitle right={right}>{t("companion.task.title")}</SectionTitle>
            {children}
        </>
    );
}
