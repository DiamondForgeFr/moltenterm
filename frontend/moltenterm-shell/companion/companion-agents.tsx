// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agents at work as the work area draws them (FR-SHELL-018, #2418): the agent (its initial, its name and tool, its
// state, its model and effort), then its sub-agents, each with the ticket it works on, a short title, its tier, model and
// duration. Each card is an end of the lines the Tasks block draws to it. The recap's own list (companion-recap.tsx) stays
// for the plain section.

import { useT } from "../i18n/i18n";
import { durationText } from "../reviews/reviews-upcoming-model";
import { StateMark } from "../state-mark";
import { agentEnd, certainTicket, heatOf } from "./companion-milestone-model";
import { CompanionSubagent, CompanionView } from "./companion-model";
import { PlanSection } from "./companion-plan";
import type { AgentLinkMarks } from "./companion-recap";
import type { AgentRow } from "./companion-recap-model";

// A sub-agent's task without the ticket number it starts with: the number has its own place on the row.
export function shortTask(description: string): string {
    return (description ?? "").replace(/^\s*#\d{1,9}\b[\s:.\-–—)]*/, "").trim();
}

function Initial({ name }: { name: string }) {
    return (
        <span className="mt-cwork-initial" data-large="" aria-hidden="true">
            {(name || "?").slice(0, 1).toUpperCase()}
        </span>
    );
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

function MainAgent({ row, marks }: { row: AgentRow; marks: AgentLinkMarks }) {
    // Without a first name the tool names the agent, once.
    const first = (row.first || row.tool || row.name).trim();
    const tool = row.first ? (row.tool ?? "") : "";
    return (
        <div className="mt-cwork-end mt-cwork-agent" data-testid="companion-agent-main" {...endAttrsOf(row, marks)}>
            <div className="mt-cwork-agent-head">
                <Initial name={first} />
                <span className="mt-cwork-agent-name truncate" title={row.name}>
                    {first}
                </span>
                {tool ? <span className="mt-cwork-agent-tool truncate">{tool}</span> : null}
                <span className="mt-cwork-agent-state" data-state={row.state}>
                    <StateMark kind={heatOf(row.state)} />
                    {row.stateLabel}
                </span>
                {row.config ? (
                    <span
                        className="mt-cwork-agent-config"
                        title={row.configTitle || undefined}
                        data-testid="companion-model-effort"
                    >
                        {row.config}
                    </span>
                ) : null}
            </div>
            {row.lines.map((line, i) => (
                <div key={i} className="mt-cwork-agent-line truncate" data-quiet={i > 0 ? "" : undefined} title={line}>
                    {line}
                </div>
            ))}
        </div>
    );
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
}: {
    rows: AgentRow[];
    view: CompanionView;
    marks: AgentLinkMarks;
    ended: string;
    now: number;
}) {
    const t = useT();
    const subs = new Map((view?.subagents ?? []).map((s) => [s.id, s]));
    const main = rows.find((r) => r.main);
    const others = rows.filter((r) => !r.main);
    return (
        <>
            {main != null ? <MainAgent row={main} marks={marks} /> : null}
            {others.length > 0 || ended ? (
                <div className="mt-cwork-flush">
                    {others.length > 0 ? (
                        <section className="mt-cwork-section" data-testid="companion-subagents">
                            <div className="mt-cwork-sec">
                                <span>{t("companion.agents.subagents")}</span>
                                <span className="mt-cwork-n">{others.length}</span>
                            </div>
                            <ul>
                                {others.map((row) => (
                                    <SubAgent key={row.id} row={row} sub={subs.get(row.id)} marks={marks} now={now} />
                                ))}
                            </ul>
                        </section>
                    ) : null}
                    {ended ? <div className="mt-cwork-slim mt-cwork-slim-start">{ended}</div> : null}
                </div>
            ) : null}
            {main != null ? (
                <PlanSection
                    todos={view?.todos ?? []}
                    name={mainName(main)}
                    updatedAt={view?.todosAt}
                    now={now}
                    links={marks?.todoLinks}
                    marks={{
                        chips: marks?.chips === true,
                        lit: marks?.hot ?? new Set(),
                        ends: marks?.ends ?? new Set(),
                    }}
                />
            ) : null}
        </>
    );
}

// The main agent's first name, as its card shows it (the plan's heading names it).
export function mainName(row: AgentRow): string {
    return (row.first || row.tool || row.name).trim();
}
