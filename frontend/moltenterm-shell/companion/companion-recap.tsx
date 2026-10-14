// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The top of the companion (#555): the recent topics of the session, then the agents at work with their model and
// effort and what they work on. Display only, from the transcript and the pane's agent state.

import { cn } from "@/util/util";
import { AgentStateDotClasses, AgentStateInfo } from "../agent-state-model";
import { CompanionView } from "./companion-model";
import { AgentRow, agentsView, finishedLabel, topicRows } from "./companion-recap-model";
import { SectionTitle } from "./companion-section";

export function RecentTopicsSection({ view, now }: { view: CompanionView; now: number }) {
    const rows = topicRows(view.topics, now);
    const name = view.session?.name;
    return (
        <section aria-label="Recent topics" data-testid="companion-topics">
            <SectionTitle>Recent topics</SectionTitle>
            {name ? (
                <div className="truncate px-3 pb-1 text-12 text-secondary" title={name} data-testid="companion-name">
                    {name}
                </div>
            ) : null}
            {rows.length === 0 ? (
                <div className="px-3 text-12 text-muted">
                    No topic yet: a prompt shows here once the agent works on it.
                </div>
            ) : (
                <ol className="flex flex-col gap-1.5 px-3">
                    {rows.map((row) => (
                        <li key={row.key} className="flex flex-col" title={row.title} data-testid="companion-topic">
                            <span className="line-clamp-2 text-12 text-primary">{row.text}</span>
                            {row.facts.length > 0 ? (
                                <span className="text-11 text-muted tabular-nums">{row.facts.join(" · ")}</span>
                            ) : null}
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}

const RowDotClasses: Record<string, string> = {
    ...AgentStateDotClasses,
    running: AgentStateDotClasses.working,
    exited: "bg-secondary",
};

// The ticket the agent works on and its complexity, with a calm hint when its model and effort look out of proportion
// with it (#601): a check for the developer, never a warning that blocks.
function TicketLine({ row }: { row: AgentRow }) {
    return (
        <div className="flex min-w-0 items-center gap-2 pl-4 text-11" data-testid="companion-agent-ticket">
            <span className="shrink-0 text-secondary tabular-nums">
                {row.ticket} · complexity: {row.complexity}
            </span>
            {row.hint ? (
                <span
                    className="min-w-0 truncate text-muted"
                    title={row.hint.title}
                    data-testid="companion-proportion"
                    data-proportion={row.hint.kind}
                >
                    <i
                        className={cn(
                            "fa fa-solid fa-fw mr-0.5",
                            row.hint.kind === "over" ? "fa-arrow-trend-up" : "fa-arrow-trend-down"
                        )}
                        aria-hidden="true"
                    />
                    {row.hint.label}
                </span>
            ) : null}
        </div>
    );
}

function AgentCard({ row }: { row: AgentRow }) {
    return (
        <li
            className={cn("flex flex-col gap-0.5", !row.main && "ml-2 border-l border-border pl-2")}
            data-testid={row.main ? "companion-agent-main" : "companion-subagent"}
        >
            <div className="flex min-w-0 items-center gap-2 text-12">
                <span
                    className={cn("h-2 w-2 shrink-0 rounded-full", RowDotClasses[row.state] ?? RowDotClasses.idle)}
                    aria-hidden="true"
                />
                <span className="min-w-0 truncate font-medium text-primary" title={row.name}>
                    {row.name}
                </span>
                <span className="shrink-0 text-11 text-muted">{row.stateLabel}</span>
                {row.config ? (
                    <span
                        className="ml-auto shrink-0 text-11 text-secondary"
                        title={row.configTitle || undefined}
                        data-testid={row.main ? "companion-model-effort" : "companion-subagent-model"}
                    >
                        {row.config}
                    </span>
                ) : null}
            </div>
            {row.ticket ? <TicketLine row={row} /> : null}
            {row.lines.map((line, i) => (
                <div key={i} className="truncate pl-4 text-11 text-secondary" title={line}>
                    {line}
                </div>
            ))}
            {row.capabilities?.length > 0 ? (
                <div className="truncate pl-4 text-11 text-muted">{row.capabilities.join(" · ")}</div>
            ) : null}
        </li>
    );
}

export function AgentsSection({
    view,
    agentState,
    now,
}: {
    view: CompanionView;
    agentState: AgentStateInfo;
    now: number;
}) {
    const agents = agentsView(view, agentState, now);
    const ended = finishedLabel(agents.finished, agents.failed);
    return (
        <section aria-label="Agents at work" data-testid="companion-agents">
            <SectionTitle right={ended ? <span className="text-11 text-muted">{ended}</span> : null}>
                Agents at work
            </SectionTitle>
            <ul className="flex flex-col gap-1.5 px-3">
                {agents.rows.map((row) => (
                    <AgentCard key={row.id} row={row} />
                ))}
            </ul>
        </section>
    );
}
