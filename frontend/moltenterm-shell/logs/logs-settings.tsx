// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Settings › Advanced › Logs (FR-PERF-016, DS-PERF-015, #2335): how much the log files weigh, read when the section
// opens; Show in folder; and Clear logs, which asks first, inline, and then removes the rotated files and empties the
// current one while the app keeps logging.

import { fireAndForget } from "@/util/util";
import { useEffect, useReducer } from "react";
import { formatSize } from "../downloads/downloads-format";
import { useT, useTCount } from "../i18n/i18n";
import { PageCard, PageRowClass } from "../settings/settings-page";
import { suiteIcon } from "../suite/suite-icons";
import { initialLogsCardState, logsCardReducer, LogsCardState } from "./logs-card-model";
import { clearLogs, readLogs, showLogs } from "./logs-client";

const SecondaryButton =
    "molten-btn-secondary inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 py-0.5 text-12 disabled:opacity-50";
const GhostButton =
    "molten-btn-ghost inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 py-0.5 text-12";
const DangerButton = "molten-btn molten-btn-destructive cursor-pointer rounded-6 px-3 py-1.5 text-12";

export type LogsCardViewProps = {
    state: LogsCardState;
    onAsk: () => void;
    onCancel: () => void;
    onConfirm: () => void;
    onShow: () => void;
};

export function LogsCardView({ state, onAsk, onCancel, onConfirm, onShow }: LogsCardViewProps) {
    const t = useT();
    const tCount = useTCount();
    const { info } = state;
    const outcomeText =
        state.outcome === "cleared"
            ? t("logs.cleared", { size: formatSize(state.freed) })
            : state.outcome === "partial"
              ? t("logs.partial")
              : state.outcome === "failed"
                ? t("logs.failed")
                : "";
    return (
        <PageCard title={t("logs.title")} hint={t("logs.hint")} icon={suiteIcon("notes")} scope="app">
            <div className={PageRowClass} data-testid="logs-card">
                <div className="min-w-0 flex-1">
                    <div className="text-12 font-medium text-primary">{t("logs.size")}</div>
                    {info != null ? (
                        <>
                            <div className="text-14 font-medium text-primary tabular-nums" data-testid="logs-size">
                                {formatSize(info.total)}
                            </div>
                            <div className="text-12 text-muted" data-testid="logs-files">
                                {tCount("logs.files", info.files)}
                            </div>
                        </>
                    ) : (
                        <div className="text-12 text-muted" data-testid="logs-unread">
                            {state.loaded ? t("logs.unreadable") : t("logs.reading")}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    className={SecondaryButton}
                    data-testid="logs-show"
                    onClick={onShow}
                    disabled={info == null}
                >
                    {t("logs.show")}
                </button>
                {state.confirming ? null : (
                    <button
                        type="button"
                        className={SecondaryButton}
                        data-testid="logs-clear"
                        onClick={onAsk}
                        disabled={info == null || state.busy}
                    >
                        {t("logs.clear")}
                    </button>
                )}
            </div>
            {state.confirming && info != null ? (
                <div className="flex flex-wrap items-center gap-2 px-5 py-3" data-testid="logs-confirm">
                    <span className="min-w-0 flex-1 basis-60 text-12 text-secondary" role="alert">
                        {t("logs.confirm", { size: formatSize(info.total) })}
                    </span>
                    <button
                        type="button"
                        className={DangerButton}
                        data-testid="logs-confirm-yes"
                        onClick={onConfirm}
                        disabled={state.busy}
                    >
                        {state.busy ? t("logs.clearing") : t("logs.confirmYes")}
                    </button>
                    <button type="button" className={GhostButton} onClick={onCancel} disabled={state.busy}>
                        {t("common.cancel")}
                    </button>
                </div>
            ) : null}
            {outcomeText !== "" ? (
                <p
                    className={`px-5 pb-3 text-12 ${state.outcome === "cleared" ? "text-muted" : "text-danger"}`}
                    role="status"
                    data-testid="logs-outcome"
                >
                    {outcomeText}
                </p>
            ) : null}
        </PageCard>
    );
}

export function LogsCard() {
    const [state, dispatch] = useReducer(logsCardReducer, undefined, initialLogsCardState);
    useEffect(() => {
        let alive = true;
        fireAndForget(async () => {
            const info = await readLogs();
            if (alive) {
                dispatch({ type: "read", info });
            }
        });
        return () => {
            alive = false;
        };
    }, []);
    const confirm = () => {
        dispatch({ type: "start" });
        fireAndForget(async () => dispatch({ type: "done", answer: await clearLogs() }));
    };
    return (
        <LogsCardView
            state={state}
            onAsk={() => dispatch({ type: "ask" })}
            onCancel={() => dispatch({ type: "cancel" })}
            onConfirm={confirm}
            onShow={() => fireAndForget(() => showLogs())}
        />
    );
}
