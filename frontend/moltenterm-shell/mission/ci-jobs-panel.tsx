// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The CI/CD panel's Jobs tab (#637): the project's CI jobs, remote (GitHub Actions workflows) then local (the
// pipeline's ci.jobs), each with what it is for and when it runs. Read-only: a click opens the job in its file, and a
// job without a description can be described by the workspace's agent, as a change the developer reviews. The
// catalogue is read when the tab opens and again when the snapshot says a workflow file or the pipeline changed.

import { openLink } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentCallName, agentLabel, AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";
import { workspaceAgents } from "../project/project-model";
import { openFileInPreview } from "../term-copy/term-copy";
import { CiIcon, githubRunIconState, LocalCiIcon } from "./ci-icon";
import {
    CatalogueJob,
    CatalogueLocal,
    CatalogueLocalJob,
    CatalogueWorkflow,
    CiCatalogue,
    conditionWords,
    describeOutcome,
    JobDescribeResult,
    jobLabel,
    lastWorkflowRun,
    localAfterWords,
    localWhenWords,
    MissionJobDescribeCommand,
    MissionJobsCommand,
    needsWords,
    stripExpression,
    triggerWords,
} from "./ci-jobs-model";
import { CiStatus } from "./ci-model";
import { BlockHeader, Notice, Problem } from "./cicd-panels";
import { MenuPopover } from "./menu-popover";
import { MissionRouteId, useCiState } from "./mission-client";
import { MissionSnapshot } from "./mission-model";
import { timeAgo } from "./time-format";

const JobsTimeoutMs = 15000;

type DescribeTarget = { kind: "workflow" | "local"; file?: string; job: string };

function readCatalogue(dir: string): Promise<CiCatalogue> {
    return TabRpcClient.wshRpcCall(MissionJobsCommand, { dir }, { route: MissionRouteId, timeout: JobsTimeoutMs });
}

function askDescribe(dir: string, blockId: string, target: DescribeTarget): Promise<JobDescribeResult> {
    return TabRpcClient.wshRpcCall(
        MissionJobDescribeCommand,
        { dir, blockid: blockId, ...target },
        { route: MissionRouteId, timeout: JobsTimeoutMs }
    );
}

function openAt(path: string, line: number, fromBlockId: string) {
    fireAndForget(() => openFileInPreview({ path, line: line > 0 ? line : undefined, conn: "" }, fromBlockId));
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex gap-2 text-12 leading-5">
            <span className="w-14 shrink-0 text-muted">{label}</span>
            <span className="min-w-0 flex-1 text-secondary">{children}</span>
        </div>
    );
}

function AskAgent({ dir, target, agents }: { dir: string; target: DescribeTarget; agents: AgentStateInfo[] }) {
    const t = useT();
    const [outcome, setOutcome] = useState<{ ok: boolean; text: string }>(null);
    const [busy, setBusy] = useState(false);
    const [anchor, setAnchor] = useState<HTMLElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const send = (agent: AgentStateInfo) => {
        setAnchor(null);
        setBusy(true);
        fireAndForget(async () => {
            let result: JobDescribeResult = null;
            try {
                result = await askDescribe(dir, agent.blockid, target);
            } catch (e) {
                result = { sent: false, message: String(e?.message ?? e) };
            }
            setBusy(false);
            setOutcome(describeOutcome(result, agentCallName(agent)));
        });
    };
    const noAgent = agents.length === 0;
    return (
        <div className="flex flex-col gap-1">
            <button
                ref={buttonRef}
                type="button"
                disabled={noAgent || busy}
                title={noAgent ? t("mc.jobs.ui.askNoAgent") : undefined}
                onClick={(e) => {
                    e.stopPropagation();
                    if (agents.length === 1) {
                        send(agents[0]);
                        return;
                    }
                    setAnchor(buttonRef.current);
                }}
                className="flex w-fit cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 py-0.5 text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                data-testid="ci-job-ask"
            >
                <i className={cn("fa fa-solid text-11", busy ? "fa-spinner fa-spin" : "fa-wand-magic-sparkles")} />
                {t("mc.jobs.ui.ask")}
            </button>
            {outcome ? (
                <span className={cn("text-11", outcome.ok ? "text-success" : "text-warning")} role="status">
                    {outcome.text}
                </span>
            ) : null}
            {anchor ? (
                <MenuPopover
                    anchor={anchor}
                    onClose={() => setAnchor(null)}
                    className="flex w-72 flex-col gap-1"
                    ariaLabel={t("mc.jobs.ui.askPick")}
                >
                    <div className="px-1 text-11 text-muted">{t("mc.jobs.ui.askPick")}</div>
                    {agents.map((agent) => (
                        <button
                            key={agent.blockid}
                            type="button"
                            onClick={() => send(agent)}
                            className="cursor-pointer rounded-6 px-2 py-1 text-left text-12 text-primary hover:bg-hover"
                        >
                            {agentLabel(agent)}
                            {agent.state && agent.state !== "idle" ? (
                                <span className="ml-1.5 text-11 text-muted">{agent.state}</span>
                            ) : null}
                        </button>
                    ))}
                </MenuPopover>
            ) : null}
        </div>
    );
}

function JobHead({
    title,
    id,
    status,
    onOpen,
}: {
    title: string;
    id: string;
    status?: React.ReactNode;
    onOpen: () => void;
}) {
    const t = useT();
    return (
        <div className="flex items-center justify-between gap-2">
            <button
                type="button"
                onClick={onOpen}
                title={t("mc.jobs.ui.openFile")}
                className="flex min-w-0 cursor-pointer items-center gap-2 text-left text-13 leading-5 font-medium text-primary hover:underline"
                data-testid="ci-job-open"
            >
                <span className="truncate">{title}</span>
                {id && id !== title ? <code className="shrink-0 text-11 font-normal text-muted">{id}</code> : null}
            </button>
            <div className="flex shrink-0 items-center gap-2">
                {status}
                <button
                    type="button"
                    onClick={onOpen}
                    aria-label={t("mc.jobs.ui.openFile")}
                    title={t("mc.jobs.ui.openFile")}
                    className="molten-btn-ghost flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-muted hover:bg-surface-2 hover:text-primary"
                >
                    <i className="fa fa-solid fa-file-code text-11" aria-hidden />
                </button>
            </div>
        </div>
    );
}

function Description({ text, ask }: { text: string; ask: React.ReactNode }) {
    const t = useT();
    if (text) {
        return <div className="text-12 leading-5 whitespace-pre-line text-secondary">{text}</div>;
    }
    return (
        <div className="flex flex-col gap-1">
            <span className="text-12 text-muted italic">{t("mc.jobs.ui.noDescription")}</span>
            {ask}
        </div>
    );
}

function WorkflowJob({
    dir,
    workflow,
    job,
    agents,
    blockId,
}: {
    dir: string;
    workflow: CatalogueWorkflow;
    job: CatalogueJob;
    agents: AgentStateInfo[];
    blockId: string;
}) {
    const t = useT();
    const condition = job.if ? conditionWords(job.if) : null;
    const after = needsWords(job.needs, workflow.jobs);
    return (
        <div className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0" data-testid="ci-job">
            <JobHead title={jobLabel(job)} id={job.id} onOpen={() => openAt(workflow.path, job.line, blockId)} />
            <Description
                text={job.description}
                ask={
                    <AskAgent
                        dir={dir}
                        target={{ kind: "workflow", file: workflow.file, job: job.id }}
                        agents={agents}
                    />
                }
            />
            {after ? <Fact label={t("mc.jobs.ui.afterLabel")}>{after}</Fact> : null}
            {job.if ? (
                <Fact label={t("mc.jobs.ui.onlyIfLabel")}>
                    {condition ?? <code className="text-11">{stripExpression(job.if)}</code>}
                </Fact>
            ) : null}
            {job.uses ? (
                <Fact label={t("mc.jobs.ui.reusable")}>
                    <code className="text-11">{job.uses}</code>
                </Fact>
            ) : null}
        </div>
    );
}

function WorkflowBlock({
    dir,
    workflow,
    snapshot,
    agents,
    blockId,
}: {
    dir: string;
    workflow: CatalogueWorkflow;
    snapshot: MissionSnapshot;
    agents: AgentStateInfo[];
    blockId: string;
}) {
    const t = useT();
    const last = lastWorkflowRun(snapshot?.github?.runs, workflow);
    return (
        <div className="overflow-hidden rounded-4 border border-border" data-testid="ci-workflow">
            <div className="flex flex-col gap-1 border-b border-border bg-hover/40 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                    <button
                        type="button"
                        onClick={() => openAt(workflow.path, 1, blockId)}
                        title={t("mc.jobs.ui.openFile")}
                        className="flex min-w-0 cursor-pointer items-center gap-2 text-left text-13 leading-5 font-semibold text-primary hover:underline"
                    >
                        <i className="fa fa-solid fa-cloud text-11 text-muted" />
                        <span className="truncate">{workflow.name || workflow.file}</span>
                        <code className="shrink-0 text-11 font-normal text-muted">{workflow.file}</code>
                    </button>
                    {last ? (
                        <button
                            type="button"
                            onClick={() => fireAndForget(() => openLink(last.url))}
                            className="flex shrink-0 cursor-pointer items-center gap-1 text-12 text-muted hover:text-primary"
                            title={t("mc.jobs.ui.lastRunTitle", { title: last.displayTitle ?? "" })}
                        >
                            <CiIcon state={githubRunIconState(last.status, last.conclusion)} />
                            {t("mc.jobs.ui.lastRun", { when: timeAgo(last.createdAt) })}
                        </button>
                    ) : null}
                </div>
                {workflow.description ? (
                    <div className="text-12 leading-5 whitespace-pre-line text-secondary">{workflow.description}</div>
                ) : null}
                {workflow.error ? <Problem text={t("mc.jobs.ui.unreadable", { error: workflow.error })} /> : null}
                {workflow.triggers.length > 0 ? (
                    <Fact label={t("mc.jobs.ui.whenLabel")}>
                        <ul className="flex flex-col">
                            {workflow.triggers.map((t, i) => (
                                <li key={`${t.event}-${i}`}>{triggerWords(t)}</li>
                            ))}
                        </ul>
                    </Fact>
                ) : null}
            </div>
            {workflow.jobs.map((job) => (
                <WorkflowJob key={job.id} dir={dir} workflow={workflow} job={job} agents={agents} blockId={blockId} />
            ))}
        </div>
    );
}

// The status each local job ended with in the most recent run that ran it.
function lastLocalStatuses(runs: { jobs: { name: string; status: CiStatus }[] }[]): Map<string, CiStatus> {
    const out = new Map<string, CiStatus>();
    for (const run of runs ?? []) {
        for (const job of run.jobs ?? []) {
            if (!out.has(job.name) && job.status !== "queued") {
                out.set(job.name, job.status);
            }
        }
    }
    return out;
}

function LocalBlock({
    dir,
    local,
    agents,
    blockId,
}: {
    dir: string;
    local: CatalogueLocal;
    agents: AgentStateInfo[];
    blockId: string;
}) {
    const t = useT();
    const { state } = useCiState(dir);
    const statuses = useMemo(() => lastLocalStatuses(state?.runs), [state?.runs]);
    const lanes = useMemo(() => {
        const out: { lane: string; jobs: CatalogueLocalJob[] }[] = [];
        for (const job of local.jobs) {
            let entry = out.find((l) => l.lane === job.lane);
            if (entry == null) {
                entry = { lane: job.lane, jobs: [] };
                out.push(entry);
            }
            entry.jobs.push(job);
        }
        return out;
    }, [local.jobs]);
    return (
        <div className="flex flex-col gap-2">
            <Fact label={t("mc.jobs.ui.whenLabel")}>
                {localWhenWords(local)}
                {local.statuses === "github" ? t("mc.jobs.ui.githubStatuses") : ""}
            </Fact>
            {lanes.map(({ lane, jobs }) => (
                <div key={lane} className="overflow-hidden rounded-4 border border-border" data-testid="ci-lane">
                    <div className="border-b border-border bg-hover/40 px-3 py-1.5 text-12 font-semibold text-secondary">
                        {t("mc.jobs.ui.lane", { lane })}
                    </div>
                    {jobs.map((job) => {
                        const status = statuses.get(job.name);
                        const after = localAfterWords(job, local);
                        return (
                            <div
                                key={job.name}
                                className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0"
                                data-testid="ci-job"
                            >
                                <JobHead
                                    title={`${job.order}. ${job.title || job.name}`}
                                    id={job.name}
                                    status={status ? <LocalCiIcon status={status} /> : null}
                                    onOpen={() => openAt(local.path, job.line, blockId)}
                                />
                                <Description
                                    text={job.description}
                                    ask={
                                        <AskAgent dir={dir} target={{ kind: "local", job: job.name }} agents={agents} />
                                    }
                                />
                                {after ? <Fact label={t("mc.jobs.ui.afterLabel")}>{after}</Fact> : null}
                                {job.run ? (
                                    <Fact label={t("mc.jobs.ui.runsLabel")}>
                                        <code className="text-11 break-all">{job.run}</code>
                                    </Fact>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

export function CiJobsTab({
    dir,
    snapshot,
    blockId,
    workspaceId,
}: {
    dir: string;
    snapshot: MissionSnapshot;
    blockId: string;
    workspaceId: string;
}) {
    const t = useT();
    const [catalogue, setCatalogue] = useState<CiCatalogue>(null);
    const [error, setError] = useState<string>(null);
    const stamp = snapshot?.workflowsstamp ?? "";
    const ciKey = JSON.stringify(snapshot?.pipeline?.pipeline?.ci ?? null);
    const agentData = useAtomValue(AgentStates.getInstance().dataAtom);
    const agents = useMemo(() => workspaceAgents(agentData.states, workspaceId), [agentData, workspaceId]);
    useEffect(() => {
        if (!dir) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const next = await readCatalogue(dir);
                if (!cancelled && next?.dir === dir) {
                    setCatalogue(next);
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
    }, [dir, stamp, ciKey]);
    if (error && catalogue == null) {
        return <Problem text={error} />;
    }
    if (catalogue == null) {
        return <Notice text={t("mc.jobs.ui.loading")} />;
    }
    const undescribed =
        catalogue.workflows.some((wf) => wf.jobs.some((j) => !j.description)) ||
        (catalogue.local?.jobs ?? []).some((j) => !j.description);
    return (
        <div className="flex flex-col gap-5" data-testid="ci-jobs">
            {undescribed && agents.length === 0 ? <Notice text={t("mc.jobs.ui.askNoAgent")} /> : null}
            <section className="flex flex-col gap-2">
                <BlockHeader title={t("mc.jobs.ui.remoteTitle")} hint={t("mc.jobs.ui.remoteHint")} />
                {catalogue.workflows.length === 0 ? <Notice text={t("mc.jobs.ui.noWorkflows")} /> : null}
                {catalogue.workflows.map((wf) => (
                    <WorkflowBlock
                        key={wf.file}
                        dir={dir}
                        workflow={wf}
                        snapshot={snapshot}
                        agents={agents}
                        blockId={blockId}
                    />
                ))}
            </section>
            <section className="flex flex-col gap-2">
                <BlockHeader title={t("mc.jobs.ui.localTitle")} hint={t("mc.jobs.ui.localHint")} />
                {catalogue.local == null || catalogue.local.jobs.length === 0 ? (
                    <Notice text={t("mc.jobs.ui.noLocal")} />
                ) : (
                    <LocalBlock dir={dir} local={catalogue.local} agents={agents} blockId={blockId} />
                )}
            </section>
        </div>
    );
}
