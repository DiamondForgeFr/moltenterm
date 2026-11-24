// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agents at work as the dashboard draws them (FR-SHELL-018, #2418, #2441, #2502): the main agent's sub-agents (the
// main agent is the hero), each with the ticket it works on, a short title, its tier, model, effort and duration and
// its first name, eight at a time, then one quiet line for the finished and failed ones. A sub-agent that waits on its
// own tests or build stays at the top and says what for: the job in plain words, how long it runs and its tier as a
// chip. Each row is an end of the lines the milestone draws to it.

import { useState } from "react";
import { jobLine, subagentTaskTitle, waitingWords } from "../activity/job-words";
import { useT, useTCount } from "../i18n/i18n";
import { durationText } from "../reviews/reviews-upcoming-model";
import { StateMark } from "../state-mark";
import { MoreButton } from "./companion-block";
import { capList } from "./companion-flow-model";
import { agentEnd, certainTicket, heatOf } from "./companion-milestone-model";
import { CompanionSubagent, CompanionView } from "./companion-model";
import type { AgentLinkMarks } from "./companion-recap";
import { finishedSubagents, type AgentRow } from "./companion-recap-model";

// A sub-agent's task without the ticket number it starts with: the number has its own place on the row.
export function shortTask(description: string): string {
    return subagentTaskTitle(description);
}

function endAttrsOf(row: AgentRow, marks: AgentLinkMarks) {
    const end = agentEnd(row.id);
    return {
        "data-link-end": end,
        "data-linked": marks?.ends?.has(end) ? "" : undefined,
        "data-link-hot": marks?.hot?.has(end) ? "" : undefined,
        "data-heat": marks?.heat?.(row),
    };
}

function SubAgent({
    row,
    sub,
    marks,
    now,
}: {
    row: AgentRow;
    sub: CompanionSubagent;
    marks: AgentLinkMarks;
    now: number;
}) {
    const t = useT();
    const ticket = certainTicket(sub?.branch ?? row.branch ?? "", sub?.description ?? "");
    const title = shortTask(sub?.description ?? "") || sub?.kind || row.name;
    const age = sub?.started ? durationText(t, now - sub.started) : "";
    const tip = sub?.description || row.name;
    const heading = (
        <span className="mt-cwork-sub-title truncate" data-tip={tip}>
            {ticket > 0 ? <span className="mt-cwork-sub-id">{`#${ticket}`}</span> : null}
            {title}
        </span>
    );
    if (row.waiting) {
        const job = row.job;
        const background = [sub?.background ? t("companion.agents.background") : "", age].filter((s) => !!s);
        const since = job != null && job.since > 0 ? durationText(t, now - job.since) : "";
        return (
            <li
                className="mt-cwork-end mt-cwork-sub-row mt-cwork-sub-waiting"
                data-testid="companion-subagent"
                data-waiting=""
                {...endAttrsOf(row, marks)}
            >
                <span className="mt-cwork-mark">
                    <StateMark kind={heatOf(row.state)} />
                </span>
                <span className="mt-cwork-sub-body">
                    <span className="mt-cwork-sub-line">
                        {heading}
                        <span className="mt-cwork-sub-state" data-testid="companion-subagent-age">
                            {background.join(" · ")}
                        </span>
                    </span>
                    <span className="mt-cwork-sub-line" data-tip={row.configTitle || undefined}>
                        <span className="mt-cwork-sub-wait truncate" data-testid="companion-subagent-job">
                            <span className="mt-cwork-sub-waits">{waitingWords(t, job?.category ?? null)}</span>
                            {job != null ? <span className="mt-cwork-sub-job">{` ${jobLine(t, job)}`}</span> : null}
                            {since ? <span className="mt-cwork-sub-since">{` · ${since}`}</span> : null}
                        </span>
                        {sub?.kind ? (
                            <span className="mt-cwork-sub-tier" data-testid="companion-subagent-tier">
                                {`→ ${sub.kind}`}
                            </span>
                        ) : null}
                    </span>
                </span>
            </li>
        );
    }
    const meta = [
        sub?.kind,
        row.config,
        sub?.background ? t("companion.agents.background") : "",
        sub?.started ? durationText(t, now - sub.started) : "",
    ].filter((s) => !!s);
    return (
        <li className="mt-cwork-end mt-cwork-sub-row" data-testid="companion-subagent" {...endAttrsOf(row, marks)}>
            <span className="mt-cwork-mark">
                <StateMark kind={heatOf(row.state)} />
            </span>
            <span className="mt-cwork-sub-body">
                {heading}
                <span className="mt-cwork-sub-meta truncate" data-tip={row.configTitle || undefined}>
                    <span data-testid="companion-subagent-model">{meta.join(" · ")}</span>
                </span>
            </span>
            <span className="mt-cwork-sub-state" data-state={row.state}>
                {row.stateLabel}
            </span>
        </li>
    );
}

// A finished or failed sub-agent, on one line, when the quiet line is opened.
function FinishedAgent({ sub, now }: { sub: CompanionSubagent; now: number }) {
    const t = useT();
    const ticket = certainTicket(sub.branch ?? "", sub.description ?? "");
    const title = shortTask(sub.description ?? "") || sub.kind || t("companion.agents.subagent");
    const when = sub.ended ? durationText(t, now - sub.ended) : "";
    return (
        <li className="mt-cwork-sub-row mt-cwork-sub-finished" data-testid="companion-subagent-finished">
            <span className="mt-cwork-sub-body">
                <span className="mt-cwork-sub-title truncate" data-tip={sub.description || title}>
                    {ticket > 0 ? <span className="mt-cwork-sub-id">{`#${ticket}`}</span> : null}
                    {title}
                </span>
            </span>
            <span className="mt-cwork-sub-state">
                {[sub.state === "failed" ? t("companion.agents.failedOne") : t("companion.agents.finishedOne"), when]
                    .filter((s) => !!s)
                    .join(" · ")}
            </span>
        </li>
    );
}

export function AgentsBlockBody({
    rows,
    view,
    marks,
    ended,
    now,
    lead,
}: {
    rows: AgentRow[];
    view: CompanionView;
    marks: AgentLinkMarks;
    ended: string;
    now: number;
    // The main agent's first name, for the empty line.
    lead?: string;
}) {
    const t = useT();
    const tCount = useTCount();
    const [open, setOpen] = useState(false);
    const [seeFinished, setSeeFinished] = useState(false);
    const subs = new Map((view?.subagents ?? []).map((s) => [s.id, s]));
    const others = rows.filter((r) => !r.main);
    const list = capList(others, open);
    const finished = ended ? finishedSubagents(view) : [];
    if (others.length === 0 && !ended) {
        return (
            <div className="mt-cb-empty" data-testid="companion-subagents-none">
                {lead ? t("companion.dash.noSubagents", { name: lead }) : t("companion.dash.noSubagentsPlain")}
            </div>
        );
    }
    return (
        <div className="mt-cwork-flush" data-bare="">
            {others.length > 0 ? (
                <section className="mt-cwork-section" data-testid="companion-subagents">
                    <ul>
                        {list.shown.map((row) => (
                            <SubAgent key={row.id} row={row} sub={subs.get(row.id)} marks={marks} now={now} />
                        ))}
                    </ul>
                    <MoreButton
                        more={list.more}
                        open={open}
                        onToggle={() => setOpen(!open)}
                        label={tCount("companion.dash.andMore", list.more, { count: list.more })}
                        lessLabel={t("companion.dash.showLess")}
                        testId="companion-subagents-more"
                    />
                </section>
            ) : null}
            {ended ? (
                <div className="mt-cwork-slim mt-cwork-slim-start" data-testid="companion-subagents-ended">
                    <span>{ended}</span>
                    {finished.length > 0 ? (
                        <>
                            <span aria-hidden>{" · "}</span>
                            <button
                                type="button"
                                className="mt-cwork-slim-see"
                                aria-expanded={seeFinished}
                                data-testid="companion-subagents-see"
                                onClick={() => setSeeFinished(!seeFinished)}
                            >
                                {t(seeFinished ? "companion.agents.hideFinished" : "companion.agents.seeFinished")}
                            </button>
                        </>
                    ) : null}
                </div>
            ) : null}
            {seeFinished && finished.length > 0 ? (
                <ul data-testid="companion-subagents-finished">
                    {finished.map((sub) => (
                        <FinishedAgent key={sub.id} sub={sub} now={now} />
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

// The main agent's first name, as the hero shows it (the plan's heading names it).
export function mainName(row: AgentRow): string {
    return (row.first || row.tool || row.name).trim();
}
