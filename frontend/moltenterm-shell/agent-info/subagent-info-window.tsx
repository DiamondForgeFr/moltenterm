// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A sub-agent's own card (FR-SHELL-104, #1333): what a sub-agent row of the sidebar opens, instead of its parent's
// "Everything about". Its description, type, model, effort, branch and duration come from the companion's view; its
// last message and transcript are read on demand from its own transcript (moltencompanionsubagentdetail). Only what
// is known shows.

import { createBlock } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { AgentStates } from "../agent-state-store";
import { useCompanionFollow } from "../companion/companion-follow";
import {
    CompanionRoute,
    CompanionSubagentDetailCommand,
    type CompanionSubagentDetail,
} from "../companion/companion-model";
import { DialogFrame } from "../dialog-frame";
import { useLocale, useT } from "../i18n/i18n";
import { agentDisplayName, AgentGlyph, WorkingDominoes } from "../sidebar/sidebar-agents";
import { TabActivity, whileShown } from "../tab-activity";
import { startedAgo, subagentDuration, subagentKindKey, subagentRows, type SubagentRow } from "./agent-info-model";
import { AgentInfoModel } from "./agent-info-store";
import { Fact, PlainButton, SectionTitle } from "./agent-info-window";

const DetailTimeoutMs = 5000;
const TickMs = 15000;

function useSubagentDetail(blockId: string, row: SubagentRow): CompanionSubagentDetail {
    const [detail, setDetail] = useState<CompanionSubagentDetail>(null);
    const id = row?.id ?? "";
    useEffect(() => {
        if (!blockId || !id) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const rtn: CompanionSubagentDetail = await TabRpcClient.wshRpcCall(
                    CompanionSubagentDetailCommand,
                    { blockid: blockId, id },
                    { route: CompanionRoute, timeout: DetailTimeoutMs }
                );
                if (!cancelled) {
                    setDetail(rtn);
                }
            } catch (e) {
                console.log("sub-agent card: detail", e);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [blockId, id, row?.state, row?.ended]);
    return detail;
}

function useNow(running: boolean): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!running) {
            return;
        }
        return TabActivity.getInstance().every(whileShown(TickMs), () => setNow(Date.now()), "subagent-card-clock");
    }, [running]);
    return now;
}

export function SubagentInfoWindow({
    blockId,
    subId,
    onClose,
}: {
    blockId: string;
    subId: string;
    onClose: () => void;
}) {
    const t = useT();
    const locale = useLocale();
    const parent = useAtomValue(AgentStates.getInstance().blockAtom(blockId));
    const companion = useCompanionFollow(blockId);
    const live = subagentRows(companion).find((r) => r.id === subId);
    // A sub-agent dropped from the view while its card is open keeps what was known of it.
    const lastRef = useRef<SubagentRow>(live);
    if (live != null) {
        lastRef.current = live;
    }
    const row = live ?? lastRef.current;
    const detail = useSubagentDetail(blockId, row);
    const running = row?.state === "working" || row?.state === "idle";
    const now = useNow(running);
    const parentName = agentDisplayName(parent);
    const kindKey = subagentKindKey(row?.kind);
    const kind = kindKey ? t(kindKey) : row?.kind;
    const duration = subagentDuration(row?.started, row?.ended, now, locale);
    const lastMessage = (detail?.lastmessage ?? "").trim();
    const transcript = detail?.transcript ?? "";
    return (
        <DialogFrame
            role="subagent-info"
            title={row?.name || t("agentInfo.subagent")}
            subtitle={parentName ? t("agentInfo.sub.of", { name: parentName }) : undefined}
            widthClass="w-[560px]"
            onBackdrop={onClose}
            onEscape={onClose}
            buttons={
                <>
                    {parent != null ? (
                        <button
                            type="button"
                            className={cn(PlainButton, "mr-auto")}
                            data-testid="subagent-info-parent"
                            onClick={() => AgentInfoModel.getInstance().open(blockId)}
                        >
                            {t("agentInfo.everything", { name: parentName })}
                        </button>
                    ) : null}
                    <button type="button" className={PlainButton} data-testid="subagent-info-close" onClick={onClose}>
                        {t("agentInfo.close")}
                    </button>
                </>
            }
        >
            <div className="flex flex-col pb-1" data-testid="subagent-info">
                {row == null ? (
                    <div className="text-12 text-muted">{t("agentInfo.sub.gone")}</div>
                ) : (
                    <>
                        <div
                            className="flex items-center gap-2 text-12 text-secondary"
                            data-testid="subagent-info-state"
                        >
                            <AgentGlyph name="sub" size={14} />
                            <span
                                className={cn(
                                    row.state === "error" && "text-danger",
                                    row.state === "done" && "text-success"
                                )}
                            >
                                {t(`agentInfo.subState.${row.state}`)}
                            </span>
                            {row.state === "working" ? <WorkingDominoes /> : null}
                        </div>
                        <div
                            className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2"
                            data-testid="subagent-info-facts"
                        >
                            <Fact label={t("agentInfo.sub.type")} value={kind} title={row.kind} />
                            <Fact label={t("agentInfo.fact.model")} value={row.model} />
                            <Fact label={t("agentInfo.fact.effort")} value={row.effort} />
                            <Fact label={t("agentInfo.fact.branch")} value={row.branch} />
                            <Fact
                                label={t(running ? "agentInfo.sub.runningFor" : "agentInfo.sub.duration")}
                                value={duration}
                            />
                            <Fact
                                label={t("agentInfo.fact.started")}
                                value={startedAgo(row.started, now, locale)}
                                title={row.started ? new Date(row.started).toLocaleString(locale) : undefined}
                            />
                        </div>
                        {lastMessage ? (
                            <section data-testid="subagent-info-last">
                                <h5 className={SectionTitle}>{t("agentInfo.sub.lastMessage")}</h5>
                                <div className="max-h-[220px] overflow-y-auto rounded-4 bg-white/[0.05] px-3 py-2 text-12 whitespace-pre-wrap text-secondary">
                                    {lastMessage}
                                </div>
                            </section>
                        ) : null}
                        {transcript ? (
                            <button
                                type="button"
                                className="mt-3 inline-flex cursor-pointer items-center gap-1.5 self-start rounded-6 px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
                                title={transcript}
                                data-testid="subagent-info-transcript"
                                onClick={() => {
                                    onClose();
                                    fireAndForget(() => createBlock({ meta: { view: "preview", file: transcript } }));
                                }}
                            >
                                {t("agentInfo.sub.transcript")}
                                <AgentGlyph name="arrow" size={12} />
                            </button>
                        ) : null}
                    </>
                )}
            </div>
        </DialogFrame>
    );
}
