// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agents at work as the dashboard draws them (FR-SHELL-018, #2418, #2441): the main agent's sub-agents (the main
// agent is the hero), each with the ticket it works on, a short title, its tier, model, effort and duration and its
// first name, eight at a time, then one quiet line for the finished and failed ones. Each row is an end of the lines
// the milestone draws to it.

import { useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { durationText } from "../reviews/reviews-upcoming-model";
import { StateMark } from "../state-mark";
import { MoreButton } from "./companion-block";
import { capList } from "./companion-flow-model";
import { agentEnd, certainTicket, heatOf } from "./companion-milestone-model";
import { CompanionSubagent, CompanionView } from "./companion-model";
import type { AgentLinkMarks } from "./companion-recap";
import type { AgentRow } from "./companion-recap-model";

// A sub-agent's task without the ticket number it starts with: the number has its own place on the row.
export function shortTask(description: string): string {
    return (description ?? "").replace(/^\s*#\d{1,9}\b[\s:.\-–—)]*/, "").trim();
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
                <span className="mt-cwork-sub-title truncate" title={sub?.description || row.name}>
                    {ticket > 0 ? <span className="mt-cwork-sub-id">{`#${ticket}`}</span> : null}
                    {title}
                </span>
                <span className="mt-cwork-sub-meta truncate" title={row.configTitle || undefined}>
                    <span data-testid="companion-subagent-model">{meta.join(" · ")}</span>
                </span>
            </span>
            <span className="mt-cwork-sub-state" data-state={row.state}>
                {row.stateLabel}
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
    const subs = new Map((view?.subagents ?? []).map((s) => [s.id, s]));
    const others = rows.filter((r) => !r.main);
    const list = capList(others, open);
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
            {ended ? <div className="mt-cwork-slim mt-cwork-slim-start">{ended}</div> : null}
        </div>
    );
}

// The main agent's first name, as the hero shows it (the plan's heading names it).
export function mainName(row: AgentRow): string {
    return (row.first || row.tool || row.name).trim();
}
