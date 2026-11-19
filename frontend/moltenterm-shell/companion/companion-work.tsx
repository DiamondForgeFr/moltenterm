// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's work area (FR-SHELL-018, #2392): the Tasks block first (the project's active milestone, then the
// agent's own task list), the agents at work beside it when the companion is wide enough and under it otherwise, and a
// line from each task in progress to the agent working on it, only on a certain match. Loaded on demand, out of the
// startup bundle (companion-view.tsx).

import { ClientModel } from "@/app/store/client-model";
import { getSettingsKeyAtom, openLink } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentStateInfo } from "../agent-state-model";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { StateMark, StateMarkKind } from "../state-mark";
import { DominoLoader, SectionBlock } from "../suite/suite";
import { TabActivity, whileShown } from "../tab-activity";
import { everyInPanel, panelActivityAtom, usePanelBlockId } from "../view360/offcarpet-model";
import { ColumnsBand, CompanionSectionId, defaultWorkBand, workLayout } from "./companion-layout";
import {
    agentEnd,
    DrawnLink,
    drawnLinks,
    dueText,
    heatOf,
    hotEnds,
    LinkAgent,
    linkAgents,
    LinkPath,
    linkPath,
    MilestoneInfo,
    milestoneProgress,
    MilestonesEvent,
    MilestonesGetCommand,
    MilestonesRoute,
    MilestonesView,
    MilestoneTicket,
    offersSummaries,
    previewTickets,
    samePaths,
    SummariesConsentKey,
    SummariesSettingKey,
    ticketEnd,
    ticketLinks,
    todoEnd,
    todoLinks,
    wantedTickets,
} from "./companion-milestone-model";
import { CompanionTodo, CompanionView, todoCounts } from "./companion-model";
import { useCompanionPref } from "./companion-prefs";
import { AgentsList } from "./companion-recap";
import { AgentRow, agentsView, finishedLabel } from "./companion-recap-model";
import type { SessionSectionSlots } from "./companion-section";
import "./companion-work.css";

const RpcTimeoutMs = 5000;
// While it shows, the block asks again on this beat; wavesrv reads the forge at most once a minute anyway.
const RefreshMs = 30000;

function cleanDir(dir: string): string {
    const trimmed = (dir ?? "").trim();
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

// The companion is on screen: its tab shows, and its panel is on the carpet.
function onScreen(panelId: string): boolean {
    const state = globalStore.get(panelId ? panelActivityAtom(panelId) : TabActivity.getInstance().stateAtom);
    return state === "active" || state === "visible";
}

// The project's active milestone, in the interface language: asked at once, on each change wavesrv announces or of the
// sentences' setting, and on a beat while the companion shows. Each ask says whether the companion is on screen: a
// hidden one only gets what was read last, and never makes wavesrv read the forge or write sentences.
export function useMilestones(dir: string, want: number[]): MilestonesView {
    const locale = useLocale();
    const panelId = usePanelBlockId();
    const summaries = useAtomValue(getSettingsKeyAtom(SummariesSettingKey));
    const [view, setView] = useState<MilestonesView>(null);
    const [rev, setRev] = useState(0);
    const project = cleanDir(dir);
    const wantKey = (want ?? []).join(",");
    useEffect(() => {
        if (!project) {
            setView(null);
            return;
        }
        let cancelled = false;
        const ask = () =>
            fireAndForget(async () => {
                try {
                    const next = await TabRpcClient.wshRpcCall(
                        MilestonesGetCommand,
                        { dir: project, lang: locale, want: want ?? [], shown: onScreen(panelId) },
                        { route: MilestonesRoute, timeout: RpcTimeoutMs }
                    );
                    if (!cancelled) {
                        setView(next as MilestonesView);
                    }
                } catch (e) {
                    console.log("companion: milestone", e);
                }
            });
        ask();
        const stop = everyInPanel(panelId, whileShown(RefreshMs), ask, "companion-milestone");
        return () => {
            cancelled = true;
            stop();
        };
    }, [project, locale, wantKey, rev, panelId, summaries]);
    useEffect(() => {
        if (!project) {
            return;
        }
        let unsubscribe = () => {};
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: MilestonesEvent as WaveEventName,
                scope: project,
                handler: () => setRev((r) => r + 1),
            });
        } catch (e) {
            console.log("companion: no event bus", e);
        }
        return () => unsubscribe();
    }, [project]);
    return view;
}

function useWidth(ref: React.RefObject<HTMLElement>): number {
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (el == null) {
            return;
        }
        const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
        measure();
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    return width;
}

function linkKeyOf(target: EventTarget): string {
    const el = (target as Element)?.closest?.("[data-link-id],[data-link-end]");
    if (el == null) {
        return null;
    }
    return el.getAttribute("data-link-id") ?? el.getAttribute("data-link-end");
}

// The developer's yes to the offer: the agreement wavesrv requires first, then the setting, whose change asks again.
function turnSummariesOn() {
    const clientId = ClientModel.getInstance().clientId;
    fireAndForget(async () => {
        if (clientId != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("client", clientId),
                meta: { [SummariesConsentKey]: Date.now() } as MetaType,
            });
        }
        await RpcApi.SetConfigCommand(TabRpcClient, { [SummariesSettingKey]: true } as SettingsType);
    });
}

type SummariesOffer = { yes: () => void; no: () => void };

function openPage(e: React.MouseEvent, url: string) {
    // The block's own click handler would take the focus back from the browser panel the page opens in.
    e.stopPropagation();
    if (url?.startsWith("https://")) {
        fireAndForget(() => openLink(url));
    }
}

export type CompanionWorkProps = {
    view: CompanionView;
    agentState: AgentStateInfo;
    // The project's folder, where wavesrv reads its forge.
    dir: string;
    now: number;
    // The band of the layout this area draws (companion-layout.ts), the defaults' without one, and what its other
    // sections show.
    band?: ColumnsBand;
    slots?: SessionSectionSlots;
    // A fixed width instead of the measured one (the tests, which have no layout).
    width?: number;
    // The milestone as given instead of asked (the tests).
    milestones?: MilestonesView;
};

export function CompanionWork(props: CompanionWorkProps) {
    const { view, agentState, dir, now } = props;
    const t = useT();
    const rootRef = useRef<HTMLDivElement>(null);
    const measured = useWidth(rootRef);
    const layout = workLayout(props.width ?? measured);
    const band = props.band ?? defaultWorkBand();
    const [want, setWant] = useState<number[]>([]);
    const asked = useMilestones(props.milestones != null ? "" : dir, want);
    const milestones = props.milestones ?? asked;
    const [offerAnswered, answerOffer] = useCompanionPref("summariesasked");
    const offer: SummariesOffer = offersSummaries(milestones, offerAnswered)
        ? {
              yes: () => {
                  answerOffer(true);
                  turnSummariesOn();
              },
              no: () => answerOffer(true),
          }
        : null;
    const [hot, setHot] = useState<string>(null);
    const agents = agentsView(view, agentState, now);
    const linkable = linkAgents(agents.rows, view);
    const m = milestones?.state === "ok" ? milestones.milestone : null;
    const tickets = ticketLinks(m?.tickets, linkable);
    const preview = m != null ? previewTickets(m, tickets, linkable) : null;
    const wanted = wantedTickets(preview?.rows).join(",");
    useEffect(() => {
        setWant(wanted ? wanted.split(",").map(Number) : []);
    }, [wanted]);
    const todos = view?.todos ?? [];
    const todoAgents = todoLinks(todos, linkable);
    const links = drawnLinks(preview?.rows, tickets, todoAgents);
    const lit = hotEnds(links, hot);
    const ends = new Set(links.flatMap((l) => [l.from, l.to]));
    const loading = milestones?.state === "loading";
    const hasTasks = loading || m != null || todos.length > 0;
    const ended = finishedLabel(agents.finished, agents.failed);
    const agentHeat = (row: AgentRow) => (ends.has(agentEnd(row.id)) ? heatOf(row.state) : undefined);
    const shows = (id: CompanionSectionId) =>
        id === "tasks" ? hasTasks : id === "agents" || props.slots?.[id] != null;
    const left = band.left.filter(shows);
    const right = band.right.filter(shows);
    const columns = layout === "columns" && left.length > 0 && right.length > 0;
    // A line needs the tasks and the agents in the two columns; anywhere else, the chips say who works on what.
    const sideBySide = columns && hasTasks && left.includes("tasks") !== left.includes("agents");
    const chips = !sideBySide;
    const sections: Partial<Record<CompanionSectionId, React.ReactNode>> = {
        ...props.slots,
        tasks: hasTasks ? (
            <SectionBlock title={t("companion.tasks")} className="mt-cwork-block" data-testid="companion-tasks">
                {loading ? (
                    <div
                        className="flex items-center gap-2 text-12 text-muted"
                        data-testid="companion-milestone-loading"
                    >
                        <DominoLoader size="card" />
                        {t("companion.work.reading")}
                    </div>
                ) : null}
                {m != null ? (
                    <MilestoneSection
                        milestone={m}
                        rows={preview.rows}
                        more={preview.more}
                        phrasing={milestones.phrasing}
                        offer={offer}
                        links={tickets}
                        chips={chips}
                        lit={lit}
                        ends={ends}
                        now={now}
                    />
                ) : null}
                {todos.length > 0 ? (
                    <TodoList
                        todos={todos}
                        links={todoAgents}
                        titled={m != null || loading}
                        chips={chips}
                        lit={lit}
                        ends={ends}
                    />
                ) : null}
            </SectionBlock>
        ) : null,
        agents: (
            <SectionBlock title={t("companion.agents.title")} className="mt-cwork-block" data-testid="companion-agents">
                <AgentsList rows={agents.rows} marks={{ ends, hot: lit, heat: agentHeat }} />
                {ended ? <div className="text-11 text-muted">{ended}</div> : null}
            </SectionBlock>
        ),
    };
    const place = (ids: CompanionSectionId[]) => ids.map((id) => <Fragment key={id}>{sections[id]}</Fragment>);
    return (
        <div
            ref={rootRef}
            className="mt-cwork"
            data-layout={layout}
            data-both={columns ? "" : undefined}
            data-testid="companion-work"
            onPointerOver={(e) => {
                const key = linkKeyOf(e.target);
                if (key !== hot) {
                    setHot(key);
                }
            }}
            onPointerLeave={() => setHot(null)}
        >
            {columns ? (
                <>
                    <div className="mt-cwork-col" data-column="left">
                        {place(left)}
                    </div>
                    <div className="mt-cwork-col" data-column="right">
                        {place(right)}
                    </div>
                </>
            ) : (
                place(band.ids.filter(shows))
            )}
            {sideBySide && links.length > 0 ? <LinkLayer rootRef={rootRef} links={links} lit={lit} /> : null}
        </div>
    );
}

function LinkChip({ agent }: { agent: LinkAgent }) {
    const t = useT();
    return (
        <span
            className="mt-cwork-chip text-11"
            data-heat={heatOf(agent.state)}
            title={t("companion.work.linkTitle", { agent: agent.name })}
            data-testid="companion-work-chip"
        >
            <span className="truncate">{t("companion.work.linkChip", { agent: agent.name })}</span>
        </span>
    );
}

type EndMarks = { chips: boolean; lit: Set<string>; ends: Set<string> };

function endAttrs(end: string, heat: StateMarkKind, marks: EndMarks) {
    return {
        "data-link-end": end,
        "data-linked": marks.ends.has(end) ? "" : undefined,
        "data-link-hot": marks.lit.has(end) ? "" : undefined,
        "data-heat": heat,
    };
}

function MilestoneSection({
    milestone,
    rows,
    more,
    phrasing,
    offer,
    links,
    now,
    ...marks
}: {
    milestone: MilestoneInfo;
    rows: MilestoneTicket[];
    more: number;
    phrasing: boolean;
    offer: SummariesOffer;
    links: Map<number, LinkAgent[]>;
    now: number;
} & EndMarks) {
    const t = useT();
    const tCount = useTCount();
    const locale = useLocale();
    const progress = milestoneProgress(milestone);
    const progressTitle = t("companion.work.progressTitle", { closed: progress.closed, total: progress.total });
    const due = dueText(milestone.due, now, locale);
    const dueLabel =
        due == null
            ? ""
            : due.kind === "today"
              ? t("companion.work.dueToday")
              : t(due.kind === "overdue" ? "companion.work.overdue" : "companion.work.due", { date: due.date });
    return (
        <div
            className="flex flex-col gap-1.5"
            aria-label={t("companion.work.milestone", { title: milestone.title })}
            data-testid="companion-milestone"
        >
            <div className="flex min-w-0 items-center gap-2">
                <i className="fa fa-solid fa-flag fa-fw shrink-0 text-11 text-secondary" aria-hidden="true" />
                <button
                    type="button"
                    className="min-w-0 cursor-pointer truncate text-left text-12 font-semibold text-primary hover:underline"
                    title={t("companion.work.openMilestone")}
                    onClick={(e) => openPage(e, milestone.url)}
                    data-testid="companion-milestone-title"
                >
                    {milestone.title}
                </button>
                {dueLabel ? (
                    <span
                        className={cn(
                            "ml-auto shrink-0 rounded-4 border px-1.5 text-11 tabular-nums",
                            due.kind === "overdue"
                                ? "border-(--mt-state-blocked) text-(--mt-state-blocked-text)"
                                : "border-border text-secondary"
                        )}
                        data-due={due.kind}
                        data-testid="companion-milestone-due"
                    >
                        {dueLabel}
                    </span>
                ) : null}
            </div>
            <div className="flex items-center gap-2" title={progressTitle}>
                <span
                    className="mt-cwork-bar"
                    role="progressbar"
                    aria-label={progressTitle}
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                    aria-valuenow={progress.closed}
                    style={{ "--mt-cwork-progress": progress.ratio.toFixed(3) } as React.CSSProperties}
                />
                <span
                    className="shrink-0 text-11 text-secondary tabular-nums"
                    data-testid="companion-milestone-progress"
                >
                    {`${progress.closed}/${progress.total}`}
                </span>
            </div>
            {offer != null ? (
                <div
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-4 border border-border px-2 py-1.5 text-11 text-secondary"
                    data-testid="companion-summaries-offer"
                >
                    <span className="min-w-0 flex-1 basis-48">{t("companion.work.offer")}</span>
                    <span className="flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            className="molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11"
                            onClick={(e) => {
                                e.stopPropagation();
                                offer.yes();
                            }}
                            data-testid="companion-summaries-yes"
                        >
                            {t("companion.work.offerYes")}
                            <MoltenWave />
                        </button>
                        <button
                            type="button"
                            className="cursor-pointer rounded-4 px-2 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary"
                            onClick={(e) => {
                                e.stopPropagation();
                                offer.no();
                            }}
                            data-testid="companion-summaries-no"
                        >
                            {t("companion.work.offerNo")}
                        </button>
                    </span>
                </div>
            ) : null}
            {phrasing ? (
                <div className="flex items-center gap-1.5 text-11 text-muted" title={t("companion.work.phrasingTitle")}>
                    <DominoLoader />
                    {t("companion.work.phrasing")}
                </div>
            ) : null}
            {rows.length === 0 ? (
                <div className="text-12 text-muted">{t("companion.work.allDone")}</div>
            ) : (
                <ol className="flex flex-col gap-0.5">
                    {rows.map((row) => (
                        <TicketRow key={row.number} ticket={row} agents={links.get(row.number) ?? []} {...marks} />
                    ))}
                </ol>
            )}
            {more > 0 || milestone.url ? (
                <div className="flex items-center gap-2 text-11">
                    {more > 0 ? (
                        <span className="text-muted" data-testid="companion-milestone-more">
                            {tCount("companion.work.more", more, { count: more })}
                        </span>
                    ) : null}
                    {milestone.url ? (
                        <button
                            type="button"
                            className="ml-auto inline-flex cursor-pointer items-center gap-1 text-secondary hover:text-primary hover:underline"
                            onClick={(e) => openPage(e, milestone.url)}
                            data-testid="companion-milestone-open"
                        >
                            {t("companion.work.openMilestone")}
                            <i className="fa fa-solid fa-arrow-up-right-from-square" aria-hidden="true" />
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function TicketRow({ ticket, agents, ...marks }: { ticket: MilestoneTicket; agents: LinkAgent[] } & EndMarks) {
    const t = useT();
    const working = agents.length > 0;
    const heat = working ? heatOf(agents[0].state) : "draft";
    const text = ticket.sentence || ticket.title;
    const title = ticket.sentence ? t("companion.work.ticketTitle", { title: ticket.title }) : ticket.title;
    return (
        <li
            className="mt-cwork-end mt-cwork-row"
            {...endAttrs(ticketEnd(ticket.number), heat, marks)}
            data-testid="companion-milestone-ticket"
        >
            <StateMark
                kind={heat}
                label={working ? t("companion.work.inProgress") : t("companion.work.open")}
                className="mt-1 shrink-0"
            />
            <button
                type="button"
                className="mt-px shrink-0 cursor-pointer font-mono text-11 text-secondary tabular-nums hover:text-primary hover:underline"
                title={t("companion.work.openTicket", { number: ticket.number })}
                onClick={(e) => openPage(e, ticket.url)}
            >
                {`#${ticket.number}`}
            </button>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                    className="line-clamp-2 text-12 text-primary"
                    title={title}
                    data-translated={ticket.sentence ? "" : undefined}
                    data-testid="companion-milestone-text"
                >
                    {text}
                </span>
                {marks.chips && working ? (
                    <span className="flex flex-wrap gap-1">
                        {agents.map((agent) => (
                            <LinkChip key={agent.id} agent={agent} />
                        ))}
                    </span>
                ) : null}
            </span>
        </li>
    );
}

const TodoMarks: Record<string, StateMarkKind> = { completed: "ready", in_progress: "running", pending: "draft" };

function TodoList({
    todos,
    links,
    titled,
    ...marks
}: { todos: CompanionTodo[]; links: Map<number, LinkAgent>; titled: boolean } & EndMarks) {
    const t = useT();
    const { done, total } = todoCounts(todos);
    return (
        <div className="flex flex-col gap-1" data-testid="companion-todos">
            <div className="flex items-center gap-2 text-11 text-muted">
                {titled ? (
                    <span className="font-semibold tracking-wide uppercase">{t("companion.work.ownTasks")}</span>
                ) : null}
                <span className="ml-auto tabular-nums">{`${done} / ${total}`}</span>
            </div>
            <ul className="flex flex-col gap-0.5">
                {todos.map((todo, i) => {
                    const agent = links.get(i);
                    const heat = agent != null ? heatOf(agent.state) : (TodoMarks[todo.status] ?? "draft");
                    return (
                        <li key={i} className="mt-cwork-end mt-cwork-row" {...endAttrs(todoEnd(i), heat, marks)}>
                            <StateMark kind={TodoMarks[todo.status] ?? "draft"} className="mt-1 shrink-0" />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span
                                    className={cn(
                                        "text-12",
                                        todo.status === "completed" ? "text-muted line-through" : "text-primary"
                                    )}
                                >
                                    {todo.text}
                                </span>
                                {marks.chips && agent != null ? (
                                    <span className="flex flex-wrap gap-1">
                                        <LinkChip agent={agent} />
                                    </span>
                                ) : null}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function scrollParent(el: HTMLElement): HTMLElement {
    for (let p = el.parentElement; p != null; p = p.parentElement) {
        const overflow = getComputedStyle(p).overflowY;
        if (overflow === "auto" || overflow === "scroll") {
            return p;
        }
    }
    return null;
}

// The lines, drawn over the two columns: each follows its two ends as the layout resizes or scrolls.
function LinkLayer({
    rootRef,
    links,
    lit,
}: {
    rootRef: React.RefObject<HTMLDivElement>;
    links: DrawnLink[];
    lit: Set<string>;
}) {
    const [paths, setPaths] = useState<LinkPath[]>([]);
    const schedule = useRef<() => void>(null);
    const key = links.map((l) => `${l.id}:${l.heat}`).join("|");
    useLayoutEffect(() => {
        const root = rootRef.current;
        if (root == null) {
            return;
        }
        let frame = 0;
        const measure = () => {
            frame = 0;
            const origin = root.getBoundingClientRect();
            const boxes = new Map<string, DOMRect>();
            root.querySelectorAll<HTMLElement>("[data-link-end]").forEach((el) =>
                boxes.set(el.getAttribute("data-link-end"), el.getBoundingClientRect())
            );
            const next = links
                .map((l) => linkPath(l, boxes.get(l.from), boxes.get(l.to), origin))
                .filter((p) => p != null);
            setPaths((prev) => (samePaths(prev, next) ? prev : next));
        };
        const later = () => {
            if (frame === 0) {
                frame = requestAnimationFrame(measure);
            }
        };
        schedule.current = later;
        measure();
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
        observer?.observe(root);
        root.querySelectorAll("[data-link-end]").forEach((el) => observer?.observe(el));
        const scroller = scrollParent(root);
        scroller?.addEventListener("scroll", later, { passive: true });
        root.addEventListener("scroll", later, { capture: true, passive: true });
        window.addEventListener("resize", later);
        return () => {
            schedule.current = null;
            if (frame !== 0) {
                cancelAnimationFrame(frame);
            }
            observer?.disconnect();
            scroller?.removeEventListener("scroll", later);
            root.removeEventListener("scroll", later, { capture: true });
            window.removeEventListener("resize", later);
        };
    }, [key]);
    // A row that moves without changing size (a sentence arrived above it) is measured again after each render.
    useLayoutEffect(() => {
        schedule.current?.();
    });
    return (
        <svg className="mt-cwork-links" aria-hidden="true" data-testid="companion-work-links">
            {paths.map((p) => (
                <g
                    key={p.id}
                    data-heat={p.heat}
                    data-link-hot={lit.has(p.id) ? "" : undefined}
                    data-testid="companion-work-link"
                >
                    <path className="mt-cwork-link" d={p.d} />
                    <path className="mt-cwork-flow" d={p.d} pathLength={100} />
                    <circle className="mt-cwork-dot" cx={p.x1} cy={p.y1} r={2.5} />
                    <circle className="mt-cwork-dot" cx={p.x2} cy={p.y2} r={2.5} />
                    <path className="mt-cwork-hit" d={p.d} data-link-id={p.id} />
                </g>
            ))}
        </svg>
    );
}
