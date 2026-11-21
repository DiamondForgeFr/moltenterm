// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion as the main agent's dashboard (FR-SHELL-018, #2441): the hero (the agent, its session and its plan),
// then every section as the same block in a flow of one to three columns (companion-flow-model.ts), the milestone and
// the agents at work side by side as a linked pair, and the arranging mode in place. Loaded on demand, out of the
// startup bundle (companion-view.tsx).

import { CopyButton } from "@/app/element/copybutton";
import { Markdown } from "@/app/element/markdown";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { Bot, ClipboardCheck, FileText, Flag, FolderGit2, Gauge, MessagesSquare } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { goToAgent } from "../agent-info/agent-info-hooks";
import type { AgentStateInfo } from "../agent-state-model";
import { useT, useTCount } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { StateMark } from "../state-mark";
import { DominoLoader } from "../suite/suite";
import { getHomeDir } from "../tab-identity-ui";
import { mainName } from "./companion-agents";
import {
    handleTarget,
    makeLayoutCommit,
    moveSection,
    positionOf,
    resetLayout,
    SectionNameKeys,
    setSectionHidden,
    setSectionSpan,
} from "./companion-arrange-model";
import { BlockTool, CompanionBlock, CountChip, FootLink } from "./companion-block";
import "./companion-dashboard.css";
import { FilesSection } from "./companion-files";
import { FlowAssign, flowLayout, FlowPlacedEvent } from "./companion-flow-model";
import { PlanUsageBody, PlanUsageSection, ProviderUsageNote } from "./companion-gauges";
import type { GaugesView } from "./companion-gauges-model";
import { CompanionHero } from "./companion-hero";
import { CompanionLayout, CompanionSectionId, isDefaultLayout, normalizeLayout } from "./companion-layout";
import { MilestonesView } from "./companion-milestone-model";
import {
    CompanionAnswer,
    CompanionAnswerCommand,
    companionMarkdown,
    CompanionRoute,
    CompanionView,
    neighbourAnswer,
    permissionRequest,
    usageAction,
} from "./companion-model";
import { PermissionRequestCard, permissionTerminalOf } from "./companion-permission";
import { RecentTopicsSection } from "./companion-recap";
import { agentsView, finishedLabel, mainAgentRow } from "./companion-recap-model";
import { TaskFrameFn, WorkspaceTaskCard, WorkspaceTaskSection } from "./companion-task";
import { taskSessionLabel, TaskView } from "./companion-task-model";
import { openUsagePage } from "./companion-usage";
import { CompanionWork, CompanionWorkProps } from "./companion-work";

const RpcTimeoutMs = 5000;
// A zero-width space: appended to a sentence, it makes the live region's text new without changing what is read.
const InvisibleMark = String.fromCharCode(0x200b);
// Past this many characters an answer shows its first lines over a fade, and "Read all" grows the block.
const LongAnswer = 600;

function companionCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: CompanionRoute, timeout: RpcTimeoutMs });
}

export type CompanionDashboardProps = {
    view: CompanionView;
    target: string;
    // The companion's own block, where the files and the task open their previews.
    companionId: string;
    agentState: AgentStateInfo;
    // The session runs behind another provider (FR-AGC-008): its usage is not the agent's.
    provider: string;
    // The project's folder, where the milestone is read, and the terminal's folder, from which paths are relative.
    dir: string;
    folder: string;
    layout: CompanionLayout;
    onSaveLayout: (layout: CompanionLayout) => void;
    arranging: boolean;
    onArrange: () => void;
    onLeaveArranging: () => void;
    arrangeRef: React.RefObject<HTMLButtonElement>;
    integrationDetails: boolean;
    persistentIntegration: boolean;
    onIntegration: () => void;
    onHistory: () => void;
    onBackToCurrent: () => void;
    // Data given instead of asked (the preview and the tests): the milestones, the agents of the project, the usage
    // and the workspace task.
    fixtures?: DashboardFixtures;
};

export type DashboardFixtures = {
    milestones?: MilestonesView;
    holds?: CompanionWorkProps["holds"];
    usage?: GaugesView;
    task?: TaskView;
};

type Columns = { columns: number; columnWidth: number; paired: boolean };

const SectionTiles: Record<CompanionSectionId, React.ReactNode> = {
    permission: <StateMark kind="waiting" />,
    tasks: <Flag strokeWidth={2} aria-hidden />,
    agents: <Bot strokeWidth={2} aria-hidden />,
    usage: <Gauge strokeWidth={2} aria-hidden />,
    topics: <MessagesSquare strokeWidth={2} aria-hidden />,
    answer: <FileText strokeWidth={2} aria-hidden />,
    task: <ClipboardCheck strokeWidth={2} aria-hidden />,
    files: <FolderGit2 strokeWidth={2} aria-hidden />,
};

export function CompanionDashboard(props: CompanionDashboardProps) {
    const { arranging } = props;
    const [cols, setCols] = useState<Columns>({ columns: 1, columnWidth: 0, paired: false });
    const onColumns = useCallback(
        (next: Columns) =>
            setCols((cur) =>
                cur.columns === next.columns &&
                cur.paired === next.paired &&
                Math.abs(cur.columnWidth - next.columnWidth) < 1
                    ? cur
                    : next
            ),
        []
    );
    return (
        <div className="mt-cdash" data-testid="companion" data-columns={cols.columns}>
            <CompanionHero {...props} />
            {arranging ? (
                <ArrangingFlow {...props} onColumns={onColumns} />
            ) : (
                <SessionFlow {...props} cols={cols} onColumns={onColumns} />
            )}
        </div>
    );
}

// ── The flow ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type FlowItem = { id: string; full: boolean };

// Places the blocks it holds (its [data-flow-id] children) with flowLayout: each takes its column's width, then its
// measured height decides where the next goes. A structural change lets the blocks travel; growth follows at once.
function Flow({
    items,
    arranging,
    onColumns,
    flowRef,
    children,
}: {
    items: FlowItem[];
    arranging: boolean;
    onColumns: (cols: Columns) => void;
    flowRef: React.RefObject<HTMLDivElement>;
    children: React.ReactNode;
}) {
    const assign = useRef<FlowAssign>(null);
    const laid = useRef(false);
    const reflow = useRef<ReturnType<typeof setTimeout>>(null);
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const observer = useRef<ResizeObserver>(null);
    const place = useCallback(() => {
        const flow = flowRef.current;
        // The companion whose width the flow divides (the flow may sit in a wrapper of no box of its own).
        const companion = flow?.closest<HTMLElement>(".mt-cdash");
        if (flow == null || companion == null) {
            return;
        }
        const width = companion.clientWidth;
        if (width <= 0) {
            return;
        }
        const els = new Map<string, HTMLElement>();
        flow.querySelectorAll<HTMLElement>(":scope > [data-flow-id]").forEach((el) => els.set(el.dataset.flowId, el));
        const blocks = itemsRef.current.filter((i) => els.has(i.id));
        const widths = flowLayout(
            blocks.map((b) => ({ ...b, height: 0 })),
            width,
            undefined,
            { arranging }
        );
        for (const p of widths.items) {
            const el = els.get(p.id);
            const w = `${p.width}px`;
            if (el.style.width !== w) {
                el.style.width = w;
            }
        }
        const r = flowLayout(
            blocks.map((b) => ({ ...b, height: els.get(b.id).offsetHeight })),
            width,
            assign.current,
            { arranging }
        );
        if (laid.current && assign.current != null && assign.current.key !== r.assign.key) {
            flow.dataset.reflowing = "";
            clearTimeout(reflow.current);
            reflow.current = setTimeout(() => {
                delete flow.dataset.reflowing;
                flow.dispatchEvent(new Event(FlowPlacedEvent));
            }, 300);
        }
        assign.current = r.assign;
        for (const p of r.items) {
            const el = els.get(p.id);
            const transform = `translate(${p.x}px, ${p.y}px)`;
            if (el.dataset.placed == null) {
                el.style.transition = "none";
                el.style.transform = transform;
                void el.offsetWidth;
                el.style.transition = "";
                el.dataset.placed = "";
                if (laid.current) {
                    el.dataset.entering = "";
                    setTimeout(() => delete el.dataset.entering, 400);
                }
            } else if (el.style.transform !== transform) {
                el.style.transform = transform;
            }
        }
        flow.style.height = `${r.height}px`;
        laid.current = true;
        onColumns({ columns: r.columns, columnWidth: r.columnWidth, paired: r.paired });
        flow.dispatchEvent(new Event(FlowPlacedEvent));
    }, [arranging, onColumns]);
    useLayoutEffect(() => {
        const flow = flowRef.current;
        if (flow == null || typeof ResizeObserver === "undefined") {
            return;
        }
        const ro = new ResizeObserver(() => place());
        observer.current = ro;
        if (flow.closest(".mt-cdash")) {
            ro.observe(flow.closest(".mt-cdash"));
        }
        return () => {
            ro.disconnect();
            observer.current = null;
            clearTimeout(reflow.current);
        };
    }, [place]);
    // After each render: the blocks that appeared are observed, and everything is placed again.
    useLayoutEffect(() => {
        flowRef.current
            ?.querySelectorAll<HTMLElement>(":scope > [data-flow-id]")
            .forEach((el) => observer.current?.observe(el));
        place();
    });
    return (
        <div ref={flowRef} className="mt-cdash-flow" data-testid="companion-flow">
            {children}
        </div>
    );
}

function SessionFlow(props: CompanionDashboardProps & { cols: Columns; onColumns: (cols: Columns) => void }) {
    const { view, agentState, target, layout, cols } = props;
    const t = useT();
    const flowRef = useRef<HTMLDivElement>(null);
    const placements = normalizeLayout(layout);
    const visible = placements.filter((p) => !p.hidden);
    const shows = (id: CompanionSectionId) => visible.some((p) => p.id === id);
    const items: FlowItem[] = visible.map((p) => ({ id: p.id, full: p.span === "full" }));
    const now = Date.now();
    const lead = mainName(mainAgentRow(view, agentState));
    const request = permissionRequest(view.pending, agentState?.state);
    const taskFrame: TaskFrameFn = ({ tools, body, other }) => (
        <CompanionBlock
            flowId="task"
            label={t("companion.task.title")}
            icon={SectionTiles.task}
            tools={tools}
            data-other-session={other ? "" : undefined}
        >
            {body}
        </CompanionBlock>
    );
    const blocks: Partial<Record<CompanionSectionId, React.ReactNode>> = {
        permission:
            request != null ? (
                <CompanionBlock
                    key="permission"
                    flowId="permission"
                    tone="waiting"
                    label={t("companion.permissionRequest")}
                    icon={SectionTiles.permission}
                >
                    <PermissionRequestCard
                        request={request}
                        t={t}
                        agent={lead}
                        onShowTerminal={() => fireAndForget(() => goToAgent(permissionTerminalOf(target, agentState)))}
                    />
                </CompanionBlock>
            ) : null,
        usage: (
            <UsageBlock
                key="usage"
                view={view}
                target={target}
                provider={props.provider}
                agentState={agentState}
                fixture={props.fixtures?.usage}
            />
        ),
        topics: (
            <CompanionBlock
                key="topics"
                flowId="topics"
                label={t("companion.topics.title")}
                icon={SectionTiles.topics}
                chips={(view.topics?.length ?? 0) > 0 ? <CountChip>{view.topics.length}</CountChip> : null}
                data-testid="companion-topics-block"
            >
                <RecentTopicsSection view={view} now={now} />
            </CompanionBlock>
        ),
        answer: <AnswerBlock key={`answer:${view.session?.path}`} target={target} view={view} />,
        task:
            props.fixtures?.task != null ? (
                <WorkspaceTaskCard
                    key="task"
                    view={props.fixtures.task}
                    session={taskSessionLabel(props.fixtures.task, view)}
                    now={now}
                    confirming={false}
                    actionError={null}
                    onOpen={() => {}}
                    onEdit={() => {}}
                    onAskClear={() => {}}
                    onCancelClear={() => {}}
                    onClear={() => {}}
                    frame={taskFrame}
                    other={true}
                />
            ) : (
                <WorkspaceTaskSection
                    key="task"
                    target={target}
                    companionId={props.companionId}
                    companion={view}
                    frame={taskFrame}
                />
            ),
        files: (
            <FilesSection
                key={`files:${view.session?.path}`}
                target={target}
                companionId={props.companionId}
                files={view.files}
                folder={props.folder}
                home={getHomeDir()}
                frame={({ tools, body, count }) => (
                    <CompanionBlock
                        flowId="files"
                        label={t("companion.files.title")}
                        icon={SectionTiles.files}
                        chips={count > 0 ? <CountChip>{count}</CountChip> : null}
                        tools={tools}
                    >
                        {body}
                    </CompanionBlock>
                )}
            />
        ),
    };
    const pairAt = visible.findIndex((p) => p.id === "tasks" || p.id === "agents");
    return (
        <Flow items={items} arranging={false} onColumns={props.onColumns} flowRef={flowRef}>
            {visible.map((p, i) => {
                if (p.id === "tasks" || p.id === "agents") {
                    return i === pairAt ? (
                        <CompanionWork
                            key="pair"
                            view={view}
                            agentState={agentState}
                            dir={props.dir}
                            now={now}
                            showTasks={shows("tasks")}
                            showAgents={shows("agents")}
                            width={
                                cols.columns >= 2 && items.find((it) => it.id === "tasks")?.full ? 0 : cols.columnWidth
                            }
                            paired={cols.paired}
                            flowRef={flowRef}
                            lead={lead}
                            milestones={props.fixtures?.milestones}
                            holds={props.fixtures?.holds}
                        />
                    ) : null;
                }
                return blocks[p.id] ?? null;
            })}
        </Flow>
    );
}

function UsageBlock({
    view,
    target,
    provider,
    agentState,
    fixture,
}: {
    view: CompanionView;
    target: string;
    provider: string;
    agentState: AgentStateInfo;
    fixture?: GaugesView;
}) {
    const t = useT();
    const action = usageAction(view);
    const foot = action ? (
        <FootLink onClick={() => openUsagePage(view)} testId="companion-usage">
            {t("companion.dash.openUsage")}
        </FootLink>
    ) : null;
    const frame = (tools: React.ReactNode, body: React.ReactNode) => (
        <CompanionBlock
            flowId="usage"
            label={t("companion.gauges.title")}
            icon={SectionTiles.usage}
            tools={tools}
            foot={foot}
            data-testid="companion-usage-block"
        >
            {body}
        </CompanionBlock>
    );
    if (provider) {
        return frame(null, <ProviderUsageNote provider={provider} native={agentState?.nativeprovider ?? ""} />);
    }
    if (fixture != null) {
        const none = () => {};
        return (
            <PlanUsageBody
                view={fixture}
                onShow={none}
                onHide={none}
                onRefresh={none}
                frame={({ tools, body }) => frame(tools, body)}
            />
        );
    }
    if (view.usage == null || !view.agent) {
        return null;
    }
    return <PlanUsageSection target={target} agent={view.agent} frame={({ tools, body }) => frame(tools, body)} />;
}

// The latest answer follows the session; browsing back pins an earlier one until "Latest".
function AnswerBlock({ target, view }: { target: string; view: CompanionView }) {
    const t = useT();
    const [pinned, setPinned] = useState<number>(null);
    const [earlier, setEarlier] = useState<CompanionAnswer>(null);
    const [error, setError] = useState<string>(null);
    const [full, setFull] = useState(false);
    const answers = view.answers ?? [];
    const latest = view.latest;
    useEffect(() => {
        setEarlier(null);
        setError(null);
        if (pinned == null) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const a = await companionCall<CompanionAnswer>(CompanionAnswerCommand, {
                    blockid: target,
                    index: pinned,
                });
                if (!cancelled) {
                    setEarlier(a);
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
    }, [target, pinned]);
    const shown = pinned == null ? latest : earlier;
    const current = shown?.index ?? latest?.index;
    const pos = answers.findIndex((a) => a.index === current);
    const go = (step: -1 | 1) => {
        const next = neighbourAnswer(answers, current, step);
        if (next == null) {
            return;
        }
        setPinned(next === latest?.index ? null : next);
    };
    const markdown = useMemo(() => companionMarkdown(shown?.markdown), [shown?.markdown]);
    const long = (shown?.markdown?.length ?? 0) > LongAnswer;
    const tools =
        latest == null ? null : (
            <>
                <BlockTool label={t("companion.answer.earlier")} disabled={pos <= 0} onClick={() => go(-1)}>
                    <i className="fa fa-solid fa-chevron-left" aria-hidden="true" />
                </BlockTool>
                <span className="mt-cb-tool-meta" data-testid="companion-answer-pos">
                    {pos + 1} / {answers.length}
                </span>
                <BlockTool
                    label={t("companion.answer.later")}
                    disabled={pos < 0 || pos >= answers.length - 1}
                    onClick={() => go(1)}
                >
                    <i className="fa fa-solid fa-chevron-right" aria-hidden="true" />
                </BlockTool>
                {pinned != null ? (
                    <button type="button" className="mt-cb-tool" onClick={() => setPinned(null)}>
                        {t("companion.answer.latestButton")}
                    </button>
                ) : null}
                <CopyButton
                    className="mt-cb-tool"
                    title={t("companion.answer.copy")}
                    onClick={() => fireAndForget(() => navigator.clipboard.writeText(shown?.markdown ?? ""))}
                />
            </>
        );
    return (
        <CompanionBlock
            flowId="answer"
            label={pinned == null ? t("companion.answer.latest") : t("companion.answer.earlier")}
            icon={SectionTiles.answer}
            tools={tools}
            data-testid="companion-answer-block"
        >
            {latest == null ? (
                <div className="mt-cb-empty">{t("companion.answer.none")}</div>
            ) : (
                <>
                    {error ? <div className="text-12 text-danger">{error}</div> : null}
                    <div
                        className="mt-cdash-answer"
                        data-folded={long && !full ? "" : undefined}
                        data-testid="companion-answer"
                    >
                        {shown ? (
                            <AnswerMarkdown markdown={markdown} />
                        ) : (
                            <div className="text-12 text-muted">
                                <DominoLoader className="mr-1.5" />
                                {t("companion.loading")}
                            </div>
                        )}
                    </div>
                    {long ? (
                        <button
                            type="button"
                            className="mt-cdash-readmore"
                            aria-expanded={full}
                            onClick={(e) => {
                                e.stopPropagation();
                                setFull(!full);
                            }}
                            data-testid="companion-answer-more"
                        >
                            {full ? t("companion.dash.readLess") : t("companion.dash.readAll")}
                        </button>
                    ) : null}
                </>
            )}
        </CompanionBlock>
    );
}

const AnswerMarkdown = memo(({ markdown }: { markdown: string }) => {
    return <Markdown text={markdown} scrollable={false} fontSizeOverride={13} fixedFontSizeOverride={12} />;
});
AnswerMarkdown.displayName = "AnswerMarkdown";

// ── Arranging ────────────────────────────────────────────────────────────────────────────────────────────────────────

// What each block says while arranging, in one line: what it holds now, or when it shows.
function useSummaries(view: CompanionView, agentState: AgentStateInfo, provider: string) {
    const t = useT();
    const tCount = useTCount();
    const now = Date.now();
    const agents = agentsView(view, agentState, now);
    const running = agents.rows.filter((r) => !r.main).length;
    const ended = finishedLabel(agents.finished, agents.failed);
    const request = permissionRequest(view.pending, agentState?.state);
    const lead = mainName(mainAgentRow(view, agentState));
    const topics = view.topics?.length ?? 0;
    const answers = view.answers?.length ?? 0;
    const files = view.files?.length ?? 0;
    const usage = !!provider || (view.usage != null && !!view.agent);
    const sums: Record<CompanionSectionId, { text: string; absent?: boolean }> = {
        permission: request
            ? { text: `${t("companion.dash.wantsToRun", { name: lead })} ${request.tool}` }
            : { text: t("companion.dash.sum.permission"), absent: true },
        tasks: { text: t("companion.dash.sum.tasks") },
        agents: {
            text: [tCount("companion.dash.sum.agents", running, { count: running }), ended]
                .filter((s) => !!s)
                .join(" · "),
        },
        usage: usage
            ? { text: t("companion.dash.sum.usage") }
            : { text: t("companion.dash.sum.usageNone"), absent: true },
        topics:
            topics > 0
                ? { text: tCount("companion.dash.sum.topics", topics, { count: topics }) }
                : { text: t("companion.topics.empty"), absent: true },
        answer:
            answers > 0
                ? { text: tCount("companion.dash.sum.answers", answers, { count: answers }) }
                : { text: t("companion.answer.none"), absent: true },
        task: { text: t("companion.dash.sum.task") },
        files:
            files > 0
                ? { text: tCount("companion.dash.sum.files", files, { count: files }) }
                : { text: t("companion.files.none"), absent: true },
    };
    return sums;
}

// The arranging mode in place (#2395, #2441): every block folds to its label and one line, with its rank, Up and Down
// (the arrows, Home and End on its handle), full width or fluid, and the eye. The changes are drafted here and saved
// when the mode is left, however it is left (Done, Escape, the Arrange tool, the pane closing).
function ArrangingFlow(props: CompanionDashboardProps & { onColumns: (cols: Columns) => void }) {
    const { layout, onSaveLayout, onLeaveArranging, view, agentState, provider } = props;
    const t = useT();
    const flowRef = useRef<HTMLDivElement>(null);
    const titleRef = useRef<HTMLHeadingElement>(null);
    const [draft, setDraft] = useState<CompanionLayout>(() => normalizeLayout(layout));
    const [note, setNote] = useState("");
    const announced = useRef(false);
    const focusAfter = useRef<{ id: CompanionSectionId; what: string }>(null);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const saveRef = useRef(onSaveLayout);
    saveRef.current = onSaveLayout;
    const committer = useRef<(draft: CompanionLayout) => boolean>(null);
    committer.current ??= makeLayoutCommit(draft, (next) => saveRef.current(next));
    const sums = useSummaries(view, agentState, provider);
    useEffect(() => {
        titleRef.current?.focus({ preventScroll: true });
        return () => {
            committer.current(draftRef.current);
        };
    }, []);
    useLayoutEffect(() => {
        const after = focusAfter.current;
        if (after == null) {
            return;
        }
        focusAfter.current = null;
        flowRef.current
            ?.querySelector<HTMLElement>(`[data-flow-id="${after.id}"] [data-arrange="${after.what}"]`)
            ?.focus();
    }, [draft]);
    const leave = () => {
        committer.current(draftRef.current);
        onLeaveArranging();
    };
    const announce = (text: string) => {
        announced.current = !announced.current;
        setNote(announced.current ? `${text}${InvisibleMark}` : text);
    };
    const nameOf = (id: CompanionSectionId) => t(SectionNameKeys[id]);
    const move = (id: CompanionSectionId, to: number, what: string) => {
        const from = draft.findIndex((p) => p.id === id);
        const target = Math.max(0, Math.min(draft.length - 1, to));
        if (target === from) {
            announce(t(from === 0 ? "companion.arrange.first" : "companion.arrange.last", { name: nameOf(id) }));
            return;
        }
        const next = moveSection(draft, from, target);
        focusAfter.current = { id, what };
        setDraft(next);
        announce(t("companion.arrange.moved", { name: nameOf(id), position: target + 1, total: next.length }));
    };
    const isDefault = isDefaultLayout(draft);
    const items: FlowItem[] = draft.map((p) => ({ id: p.id, full: p.span === "full" }));
    return (
        <>
            <CompanionBlock
                className="mt-cdash-arrbar"
                label={
                    <span ref={titleRef} tabIndex={-1} className="outline-none">
                        {t("companion.arrange.title")}
                    </span>
                }
                icon={<i className="fa fa-solid fa-table-columns" aria-hidden="true" />}
                data-testid="companion-arrange"
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.stopPropagation();
                        leave();
                    }
                }}
            >
                <div className="mt-cdash-arrbar-in">
                    <p>{t("companion.arrange.hint")}</p>
                    <div className="mt-cdash-arrbar-actions">
                        <button
                            type="button"
                            className="molten-btn-ghost inline-flex h-row cursor-pointer items-center gap-1.5 rounded-4 border border-border px-3 text-12 aria-disabled:cursor-default aria-disabled:opacity-40"
                            aria-disabled={isDefault}
                            onClick={() => {
                                if (isDefault) {
                                    return;
                                }
                                setDraft(resetLayout());
                                announce(t("companion.arrange.resetDone"));
                            }}
                            data-testid="companion-arrange-reset"
                        >
                            {t("companion.arrange.reset")}
                        </button>
                        <button
                            type="button"
                            className="molten-btn inline-flex h-row cursor-pointer items-center gap-1.5 rounded-4 px-3 text-12 font-medium"
                            onClick={leave}
                            data-testid="companion-arrange-done"
                        >
                            {t("companion.arrange.done")}
                            <MoltenWave />
                        </button>
                    </div>
                </div>
            </CompanionBlock>
            <div
                className="contents"
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.stopPropagation();
                        leave();
                    }
                }}
            >
                <Flow items={items} arranging={true} onColumns={props.onColumns} flowRef={flowRef}>
                    {draft.map((p, i) => {
                        const name = nameOf(p.id);
                        const shown = !p.hidden;
                        const full = p.span === "full";
                        const { position, total } = positionOf(draft, p.id);
                        const sum = sums[p.id];
                        return (
                            <CompanionBlock
                                key={p.id}
                                flowId={p.id}
                                label={name}
                                icon={SectionTiles[p.id]}
                                tone={p.id === "permission" ? "waiting" : undefined}
                                data-hidden={shown ? undefined : ""}
                                data-absent={sum.absent ? "" : undefined}
                                data-testid="companion-arrange-row"
                                data-section={p.id}
                                data-span={p.span}
                                grip={
                                    <button
                                        type="button"
                                        className="mt-cb-tool mt-cb-grip"
                                        data-arrange="handle"
                                        aria-label={t("companion.arrange.handle", { name })}
                                        title={t("companion.arrange.handleHelp")}
                                        onKeyDown={(e) => {
                                            const to = handleTarget(e.key, i, draft.length);
                                            if (to == null) {
                                                return;
                                            }
                                            e.preventDefault();
                                            move(p.id, to, "handle");
                                        }}
                                        data-testid="companion-arrange-handle"
                                    >
                                        <i className="fa-solid fa-grip-vertical" aria-hidden="true" />
                                    </button>
                                }
                                chips={
                                    shown ? null : (
                                        <span className="mt-cb-chip mt-cb-chip-off">
                                            {t("companion.arrange.hidden")}
                                        </span>
                                    )
                                }
                                tools={
                                    <>
                                        <span
                                            className="mt-cb-tool-meta shrink-0"
                                            title={t("companion.arrange.rankTitle")}
                                            data-testid="companion-arrange-rank"
                                        >
                                            {t("companion.arrange.rank", { position, total })}
                                        </span>
                                        <BlockTool
                                            label={t("companion.arrange.up", { name })}
                                            marker="up"
                                            onClick={() => move(p.id, i - 1, "up")}
                                        >
                                            <i className="fa fa-solid fa-arrow-up" aria-hidden="true" />
                                        </BlockTool>
                                        <BlockTool
                                            label={t("companion.arrange.down", { name })}
                                            marker="down"
                                            onClick={() => move(p.id, i + 1, "down")}
                                        >
                                            <i className="fa fa-solid fa-arrow-down" aria-hidden="true" />
                                        </BlockTool>
                                        <BlockTool
                                            label={t("companion.arrange.wide", { name })}
                                            pressed={full}
                                            onClick={() => {
                                                setDraft(setSectionSpan(draft, p.id, full ? "flow" : "full"));
                                                announce(
                                                    t(full ? "companion.arrange.wideOff" : "companion.arrange.wideOn", {
                                                        name,
                                                    })
                                                );
                                            }}
                                            testId="companion-arrange-wide"
                                        >
                                            <i className="fa fa-solid fa-arrows-left-right" aria-hidden="true" />
                                        </BlockTool>
                                        <BlockTool
                                            label={t("companion.arrange.show", { name })}
                                            pressed={shown}
                                            onClick={() => {
                                                setDraft(setSectionHidden(draft, p.id, shown));
                                                announce(
                                                    t(
                                                        shown
                                                            ? "companion.arrange.hiddenNow"
                                                            : "companion.arrange.shownNow",
                                                        {
                                                            name,
                                                        }
                                                    )
                                                );
                                            }}
                                            testId="companion-arrange-switch"
                                        >
                                            <i
                                                className={shown ? "fa fa-solid fa-eye" : "fa fa-solid fa-eye-slash"}
                                                aria-hidden="true"
                                            />
                                        </BlockTool>
                                    </>
                                }
                            >
                                <div className="mt-cb-sum" title={sum.text}>
                                    {sum.text}
                                </div>
                            </CompanionBlock>
                        );
                    })}
                </Flow>
            </div>
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
                data-testid="companion-arrange-note"
            >
                {note}
            </div>
        </>
    );
}
