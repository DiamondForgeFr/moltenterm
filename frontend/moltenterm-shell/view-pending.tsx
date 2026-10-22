// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The window's pending state (#450, FR-PERF-004, DS-PERF-005): while another workspace's view loads, the view on
// screen draws it over its panels, sent by emain/moltenterm-view-pending.ts. The rail stays usable: a click on another
// workspace is queued and the pending state names it. The same surface is the in-view pending state of
// tab-view-guard.tsx.

import { getApi, globalStore } from "@/app/store/global";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { EmptyState } from "./empty-state";
import { useT } from "./i18n/i18n";
import { workspaceShownName } from "./workspace-default-name";

export type ViewPendingPhase = "loading" | "retrying" | "failed" | "stopped";

export type ViewPendingState = {
    phase: ViewPendingPhase;
    workspaceName: string;
};

type ViewPendingApi = {
    onMoltentermViewPending?: (callback: (state: ViewPendingState) => void) => void;
    moltentermViewPendingAction?: (action: "reload" | "dismiss") => void;
};

function pendingApi(): ViewPendingApi {
    return getApi() as unknown as ViewPendingApi;
}

export class ViewPendingModel {
    private static instance: ViewPendingModel = null;

    stateAtom = atom(null) as PrimitiveAtom<ViewPendingState>;

    private constructor() {
        pendingApi()?.onMoltentermViewPending?.((state) => {
            globalStore.set(this.stateAtom, state ?? null);
        });
    }

    static getInstance(): ViewPendingModel {
        if (ViewPendingModel.instance == null) {
            ViewPendingModel.instance = new ViewPendingModel();
        }
        return ViewPendingModel.instance;
    }

    static resetInstance() {
        ViewPendingModel.instance = null;
    }

    reload() {
        pendingApi()?.moltentermViewPendingAction?.("reload");
    }

    dismiss() {
        globalStore.set(this.stateAtom, null);
        pendingApi()?.moltentermViewPendingAction?.("dismiss");
    }
}

// Dictionary keys.
const Captions: Record<ViewPendingPhase, string> = {
    loading: "shell.pending.opening",
    retrying: "shell.pending.stillOpening",
    failed: "",
    stopped: "",
};

type PendingSurfaceProps = {
    phase: ViewPendingPhase;
    workspaceName?: string;
    onReload?: () => void;
    onDismiss?: () => void;
};

export function PendingSurface({ phase, workspaceName: storedName, onReload, onDismiss }: PendingSurfaceProps) {
    const t = useT();
    const workspaceName = workspaceShownName(storedName, t);
    if (phase === "failed" || phase === "stopped") {
        const stopped = phase === "stopped";
        return (
            <EmptyState
                icon="hourglass-end"
                title={
                    stopped
                        ? t("shell.pending.stopped")
                        : workspaceName
                          ? t("shell.pending.didNotOpen", { name: workspaceName })
                          : t("shell.pending.workspaceDidNotOpen")
                }
                hint={stopped ? t("shell.pending.stoppedHint") : t("shell.pending.noAnswer")}
                primary={
                    onReload
                        ? { label: t("shell.pending.reload"), onClick: onReload, testId: "view-pending-reload" }
                        : null
                }
                secondary={
                    onDismiss
                        ? { label: t("common.dismiss"), onClick: onDismiss, testId: "view-pending-dismiss" }
                        : null
                }
                testId="view-pending-failed"
            />
        );
    }
    return (
        <div
            className="flex h-full w-full items-center justify-center p-6"
            data-molten-view-pending={phase}
            role="status"
            aria-live="polite"
        >
            <div className="flex max-w-[360px] flex-col items-center gap-2.5 text-center">
                {workspaceName ? (
                    <div className="max-w-[360px] truncate text-13 leading-5 font-semibold text-primary">
                        {workspaceName}
                    </div>
                ) : null}
                <div className="molten-view-pending-line" aria-hidden>
                    <span />
                </div>
                <p className="text-12 leading-[18px] text-muted">{Captions[phase] ? t(Captions[phase]) : ""}</p>
            </div>
        </div>
    );
}

// Over the panels of the workspace on screen (workspace.tsx), never over the rail.
export function ViewPendingOverlay() {
    const model = ViewPendingModel.getInstance();
    const state = useAtomValue(model.stateAtom);
    if (state == null) {
        return null;
    }
    return (
        <div
            className="molten-view-pending-overlay absolute inset-0 z-40 bg-background"
            data-testid="view-pending-overlay"
        >
            <PendingSurface
                phase={state.phase}
                workspaceName={state.workspaceName}
                onReload={() => model.reload()}
                onDismiss={() => model.dismiss()}
            />
        </div>
    );
}
