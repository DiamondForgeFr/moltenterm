// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The hero of the companion's dashboard (FR-SHELL-018, #2441): the main agent across every column, in place of the
// session bar. Its identity (initial, name, provider, model and effort, state, the session's subject and how it is
// linked, the session's states), then its plan; its tools are the Integration badge, the session history and Arrange.
// The turning light while it works, a violet border while it waits for the developer. The plan usage, when the developer
// attached it (#2450), is its last row, after a hairline, and its usage page and refresh tools stand among the hero's.

import { makeIconClass } from "@/util/util";
import type { AgentStateInfo } from "../agent-state-model";
import { AiIcon } from "../ai-icon";
import { useT } from "../i18n/i18n";
import { durationText } from "../reviews/reviews-upcoming-model";
import { StateMark, StateMarkKind } from "../state-mark";
import { DominoLoader, GlowRing } from "../suite/suite";
import { mainName } from "./companion-agents";
import { BlockTool, CompanionBlock } from "./companion-block";
import type { UsageFrameParts } from "./companion-gauges";
import { MessageText } from "./companion-image-chip";
import { IntegratedBadge } from "./companion-integration";
import { linkAgents, todoLinks } from "./companion-milestone-model";
import { CompanionView, guessHint, integrationProblem, linkLabel, sessionTitle, startedLabel } from "./companion-model";
import { PlanSection } from "./companion-plan";
import { AgentRow, agentsView, mainAgentRow } from "./companion-recap-model";
import { UsageButton } from "./companion-usage";

export type CompanionHeroProps = {
    view: CompanionView;
    agentState: AgentStateInfo;
    // The session runs behind another provider (FR-AGC-008): its usage is not the agent's.
    provider: string;
    arranging: boolean;
    onArrange: () => void;
    onLeaveArranging: () => void;
    arrangeRef?: React.RefObject<HTMLButtonElement>;
    integrationDetails: boolean;
    persistentIntegration: boolean;
    onIntegration: () => void;
    onHistory: () => void;
    onBackToCurrent: () => void;
    // The usage block shows in the flow (not hidden by the layout, not attached to the hero).
    usageBlockShown?: boolean;
    // The usage attached to the main agent (#2450): what the usage block would have drawn, its rows being the hero's last
    // row and its tools standing among the hero's. Absent while the usage stands on its own, and while arranging, which
    // folds every block to a line.
    usage?: UsageFrameParts;
};

// The hero's state, as a shape and a colour of the heat scale: at work, waiting for the developer, finished.
function heroState(row: AgentRow): StateMarkKind {
    switch (row.state) {
        case "working":
        case "running":
            return "running";
        case "waiting":
            return "waiting";
        case "error":
            return "blocked";
        case "exited":
            return "draft";
    }
    return "ready";
}

export function CompanionHero(props: CompanionHeroProps) {
    const { view, agentState, arranging } = props;
    const t = useT();
    const now = Date.now();
    const session = view.session;
    const row = mainAgentRow(view, agentState);
    const first = mainName(row);
    const tool = row.first ? (row.tool ?? "") : "";
    const state = heroState(row);
    const agent = state === "running" ? "running" : state === "waiting" ? "waiting" : "idle";
    const since = state === "running" && session?.lastprompt > 0 ? durationText(t, now - session.lastprompt) : "";
    const subject = sessionTitle(session);
    const started = startedLabel(session?.started, now);
    const hint = guessHint(session);
    const problem = integrationProblem(view);
    const earlier = view.earlier?.length ?? 0;
    const agents = agentsView(view, agentState, now);
    const steps = todoLinks(view.todos ?? [], linkAgents(agents.rows, view));
    const hasPlan = (view.todos?.length ?? 0) > 0;
    // The plan beside it already shows the step in progress: its "Task:" line would say it twice (#2441).
    const current = (view.todos ?? []).find((todo) => todo.status === "in_progress");
    const taskLine = current ? t("companion.agents.task", { text: current.text }) : null;
    const lines = hasPlan ? row.lines.filter((line) => line !== taskLine) : row.lines;
    // The usage block carries the link to the usage page; while it is hidden or not drawn, the hero keeps it.
    const usageShown = props.usageBlockShown === true && props.provider === "" && view.usage != null && !!view.agent;
    const attached = props.usage != null && props.usage.state !== "hidden" && !arranging ? props.usage : null;
    const historyTitle =
        earlier > 0
            ? t(earlier === 1 ? "companion.bar.historyEarlierOne" : "companion.bar.historyEarlierOther", {
                  count: earlier,
              })
            : t("companion.bar.historyChoose");
    return (
        <CompanionBlock
            className="mt-cdash-hero"
            heading="h2"
            label={t("companion.dash.mainAgent")}
            icon={<i className={makeIconClass(AiIcon, true)} aria-hidden="true" />}
            data-agent={agent}
            data-testid="companion-session-bar"
            tools={
                <>
                    {props.integrationDetails ? (
                        <IntegratedBadge
                            onOpen={props.onIntegration}
                            short
                            persistent={props.persistentIntegration}
                            className="mt-cb-tool"
                        />
                    ) : null}
                    {usageShown ? null : <UsageButton view={view} className="mt-cb-tool" />}
                    {attached?.tools}
                    <BlockTool
                        label={t("companion.bar.history")}
                        tip={historyTitle}
                        onClick={props.onHistory}
                        testId="companion-history-open"
                    >
                        <i className="fa fa-solid fa-clock-rotate-left" aria-hidden="true" />
                        {earlier > 0 ? (
                            <span className="tabular-nums" data-testid="companion-earlier-count">
                                {earlier}
                            </span>
                        ) : null}
                    </BlockTool>
                    <BlockTool
                        label={t("companion.arrange.open")}
                        onClick={arranging ? props.onLeaveArranging : props.onArrange}
                        pressed={arranging}
                        buttonRef={props.arrangeRef}
                        testId="companion-arrange-open"
                    >
                        <i className="fa fa-solid fa-table-columns" aria-hidden="true" />
                    </BlockTool>
                </>
            }
        >
            <GlowRing on={agent === "running"} />
            <span className="mt-cdash-heat" aria-hidden="true" />
            <div className="mt-cdash-hero-grid" data-plan={hasPlan && !arranging ? "" : undefined}>
                <div className="mt-cdash-id">
                    <div className="mt-cdash-id-head">
                        <span className="mt-cdash-avatar" aria-hidden="true">
                            {(first || "?").slice(0, 1).toUpperCase()}
                        </span>
                        <div className="mt-cdash-names">
                            <div className="mt-cdash-name-line">
                                <span className="mt-cdash-name" data-testid="companion-agent-main">
                                    {first}
                                </span>
                                {tool ? <span className="mt-cdash-provider">{tool}</span> : null}
                            </div>
                            <div className="mt-cdash-badges">
                                {row.config ? (
                                    <span
                                        className="mt-cdash-tag"
                                        data-mono=""
                                        data-tip={row.configTitle || undefined}
                                        data-testid="companion-model-effort"
                                    >
                                        {row.config}
                                    </span>
                                ) : null}
                                <span className="mt-cdash-state" data-state={state} data-testid="companion-agent-state">
                                    <StateMark kind={state} />
                                    {[row.stateLabel, since].filter((s) => !!s).join(" · ")}
                                </span>
                                {row.ticket ? (
                                    <span className="mt-cdash-tag" data-testid="companion-agent-ticket">
                                        {t("companion.agents.ticketComplexity", {
                                            ticket: row.ticket,
                                            complexity: row.complexity,
                                        })}
                                    </span>
                                ) : null}
                                {row.hint ? (
                                    <span
                                        className="text-11 text-muted"
                                        data-tip={row.hint.title}
                                        data-testid="companion-proportion"
                                        data-proportion={row.hint.kind}
                                    >
                                        {row.hint.label}
                                    </span>
                                ) : null}
                            </div>
                        </div>
                    </div>
                    {subject ? (
                        <p className="mt-cdash-subject" data-tip={subject} data-testid="companion-session-title">
                            <MessageText text={subject} />
                        </p>
                    ) : null}
                    {lines.length > 0 ? (
                        <div className="mt-cdash-meta" data-testid="companion-agent-lines">
                            {lines.map((line, i) => (
                                <span key={i} className="truncate" data-tip={line}>
                                    {line}
                                </span>
                            ))}
                        </div>
                    ) : null}
                    <div className="mt-cdash-meta">
                        {[
                            started,
                            <span
                                key="link"
                                data-tip={[session?.path, session?.format].filter((s) => !!s).join("\n") || undefined}
                                data-testid="companion-link"
                            >
                                {linkLabel(session)}
                            </span>,
                            session?.branch ? (
                                <span key="branch" data-mono="">
                                    {session.branch}
                                </span>
                            ) : null,
                        ]
                            .filter((s) => !!s)
                            .map((part, i) => (
                                <span key={i} className="flex items-center gap-1.5">
                                    {i > 0 ? <span aria-hidden="true">·</span> : null}
                                    {part}
                                </span>
                            ))}
                    </div>
                    <SessionNotes
                        view={view}
                        hint={hint}
                        problem={problem}
                        onHistory={props.onHistory}
                        onBackToCurrent={props.onBackToCurrent}
                    />
                </div>
                {hasPlan && !arranging ? (
                    <PlanSection
                        todos={view.todos}
                        name={first}
                        updatedAt={view.todosAt}
                        now={now}
                        links={steps}
                        marks={{ chips: true, lit: new Set(), ends: new Set() }}
                    />
                ) : null}
            </div>
            {attached?.body != null ? (
                <div className="mt-cdash-hero-usage" data-testid="companion-hero-usage" data-state={attached.state}>
                    {attached.body}
                </div>
            ) : null}
        </CompanionBlock>
    );
}

// The session's states, in the hero: an earlier session and the way back, a guessed link and "Not this session?", the
// agent gone, the transcript being read, an integration that stepped aside.
function SessionNotes({
    view,
    hint,
    problem,
    onHistory,
    onBackToCurrent,
}: {
    view: CompanionView;
    hint: string;
    problem: string;
    onHistory: () => void;
    onBackToCurrent: () => void;
}) {
    const t = useT();
    const earlier = view.session?.earlier === true;
    if (!earlier && hint == null && !view.ended && view.status !== "loading" && problem == null) {
        return null;
    }
    return (
        <div className="mt-cdash-meta">
            {earlier ? (
                <span className="flex items-center gap-1.5" data-testid="companion-earlier">
                    <span className="mt-cdash-tag">{t("companion.bar.earlierSession")}</span>
                    <button
                        type="button"
                        onClick={onBackToCurrent}
                        className="mt-cdash-link"
                        data-testid="companion-back-to-current"
                    >
                        {t("companion.bar.backToCurrent")}
                    </button>
                </span>
            ) : null}
            {hint != null ? (
                <span className="flex min-w-0 items-center gap-1.5" data-testid="companion-guess">
                    <span className="truncate italic">{hint}</span>
                    <button
                        type="button"
                        onClick={onHistory}
                        className="mt-cdash-link"
                        data-testid="companion-guess-change"
                    >
                        {t("companion.guess.notThis")}
                    </button>
                </span>
            ) : null}
            {view.ended ? <span className="mt-cdash-warn">{t("companion.bar.ended")}</span> : null}
            {view.status === "loading" ? (
                <span>
                    <DominoLoader className="mr-1" />
                    {t("companion.bar.reading")}
                </span>
            ) : null}
            {problem != null ? (
                <span className="mt-cdash-warn" data-testid="companion-integration-problem">
                    {problem}
                </span>
            ) : null}
        </div>
    );
}
