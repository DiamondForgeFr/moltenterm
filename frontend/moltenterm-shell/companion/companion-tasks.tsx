// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's Tasks block (FR-SHELL-018, #2392, #2416): a suite block whose label is one tab per open milestone, the
// selected milestone's header (name, state, due date, count, progress), its remaining tickets in flush rows, or, for a
// finished milestone that waits for its release, the "No tickets left" placeholder. The agent's own tasks close the
// block. Display only: the data comes from companion-work.tsx.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { openLink } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useId } from "react";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { StateMark, StateMarkKind } from "../state-mark";
import { DominoLoader, SectionBlock, suiteTabId } from "../suite/suite";
import { suiteIcon } from "../suite/suite-icons";
import {
    daysLate,
    dueText,
    heatOf,
    LinkAgent,
    MilestoneInfo,
    milestoneProgress,
    milestoneReady,
    milestoneStanding,
    MilestoneTicket,
    splitTabs,
    Standing,
    tabLabel,
    tabRoom,
    ticketEnd,
    todoEnd,
} from "./companion-milestone-model";
import { CompanionTodo, todoCounts } from "./companion-model";

// The room the block's label pocket leaves the tabs: the icon tile's corner on the left, and the pocket's own padding
// and gutter on the right (suite.css, --df-pocket-left, .df-pocket max-width).
const PocketRoomPx = 68;
// Below this width the block uses the narrow forms: shorter names and counts, a ticket's agent on its first line.
export const CompactBlockPx = 420;

export function openPage(e: React.MouseEvent, url: string) {
    // The block's own click handler would take the focus back from the browser panel the page opens in.
    e.stopPropagation();
    if (url?.startsWith("https://")) {
        fireAndForget(() => openLink(url));
    }
}

// The project's view is where the release starts (the release menu of its header): loaded when asked, since only a
// finished milestone offers it.
function openProjectView(e: React.MouseEvent) {
    e.stopPropagation();
    fireAndForget(async () => {
        const { openProjectTab } = await import("../project/project-tab");
        await openProjectTab();
    });
}

export type SummariesOffer = { yes: () => void; no: () => void };

export type EndMarks = { chips: boolean; lit: Set<string>; ends: Set<string> };

export function endAttrs(end: string, heat: StateMarkKind, marks: EndMarks) {
    return {
        "data-link-end": end,
        "data-linked": marks.ends.has(end) ? "" : undefined,
        "data-link-hot": marks.lit.has(end) ? "" : undefined,
        "data-heat": heat,
    };
}

export function LinkChip({ agent }: { agent: LinkAgent }) {
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

export type TasksBlockProps = {
    loading: boolean;
    // The tabs, in order, and the one shown.
    milestones: MilestoneInfo[];
    selected: MilestoneInfo;
    onSelect: (number: number) => void;
    // The block's own width, from which the tabs that fit and the narrow forms follow.
    width: number;
    // The rows shown of the selected milestone, and the open tickets left out.
    rows: MilestoneTicket[];
    more: number;
    phrasing: boolean;
    offer: SummariesOffer;
    links: Map<number, LinkAgent[]>;
    todos: CompanionTodo[];
    todoAgents: Map<number, LinkAgent>;
    now: number;
} & EndMarks;

function standingText(
    standing: Standing,
    m: MilestoneInfo,
    now: number,
    compact: boolean,
    t: ReturnType<typeof useT>,
    tCount: ReturnType<typeof useTCount>
): string {
    if (standing === "ready") {
        return t("companion.work.ready");
    }
    if (standing !== "late") {
        return "";
    }
    const days = daysLate(m.due, now);
    return compact
        ? t("companion.work.lateShort", { count: days })
        : tCount("companion.work.lateLong", days, { count: days });
}

function StandingMark({ standing, text, size }: { standing: Standing; text?: string; size?: "tab" }) {
    if (standing === "") {
        return null;
    }
    return (
        <StateMark
            kind={standing === "ready" ? "ready" : "blocked"}
            label={text}
            className={size === "tab" ? "mt-cwork-tabmark" : undefined}
        />
    );
}

export function TasksBlock(props: TasksBlockProps) {
    const { loading, milestones, selected, onSelect, width, rows, more, todos, todoAgents, now, ...marks } = props;
    const t = useT();
    const tCount = useTCount();
    const panelId = useId();
    const compact = width > 0 && width < CompactBlockPx;
    const tabbed = milestones.length > 0 && selected != null;
    const standings = milestones.map((m) => milestoneStanding(m, now));
    const room = tabRoom(
        milestones.map((m, i) => ({ label: tabLabel(m.title), marked: standings[i] !== "" })),
        width > 0 ? width - PocketRoomPx : Infinity
    );
    const split = tabbed ? splitTabs(milestones, selected.number, room) : { shown: [], more: [] };
    const standingOf = (m: MilestoneInfo) => standings[milestones.indexOf(m)];
    const tabState = (m: MilestoneInfo) => standingText(standingOf(m), m, now, true, t, tCount);
    const openMore = (e: React.MouseEvent<HTMLButtonElement>) => {
        ContextMenuModel.getInstance().showContextMenu(
            split.more.map((m) => ({
                label: [m.title, tabState(m)].filter((s) => !!s).join(" · "),
                click: () => onSelect(m.number),
            })),
            e
        );
    };
    const tabs = tabbed
        ? {
              label: t("companion.work.tabsLabel"),
              panelId,
              tabs: split.shown.map((m) => ({
                  value: String(m.number),
                  label: tabLabel(m.title),
                  title: [m.title, tabState(m)].filter((s) => !!s).join(" · "),
                  mark: <StandingMark standing={standingOf(m)} text={tabState(m)} size="tab" />,
              })),
              selected: String(selected.number),
              onSelect: (value: string) => onSelect(Number(value)),
              more:
                  split.more.length > 0
                      ? {
                            label: t("companion.work.moreTabs", { count: split.more.length }),
                            title: tCount("companion.work.moreTabsTitle", split.more.length, {
                                count: split.more.length,
                            }),
                            onOpen: openMore,
                        }
                      : undefined,
          }
        : undefined;
    const footer = tabbed && selected.url ? <OpenMilestone url={selected.url} /> : undefined;
    return (
        <SectionBlock
            title={tabbed ? undefined : t("companion.tasks")}
            tabs={tabs}
            icon={suiteIcon("tasks")}
            footer={footer}
            aria-label={tabbed ? t("companion.tasks") : undefined}
            className="mt-cwork-block"
            data-testid="companion-tasks"
        >
            {loading ? (
                <div className="flex items-center gap-2 text-12 text-muted" data-testid="companion-milestone-loading">
                    <DominoLoader size="card" />
                    {t("companion.work.reading")}
                </div>
            ) : null}
            {tabbed ? (
                <div
                    role="tabpanel"
                    id={panelId}
                    aria-labelledby={suiteTabId(panelId, String(selected.number))}
                    className="flex flex-col gap-2.5"
                    data-testid="companion-milestone"
                    data-milestone={selected.number}
                    data-standing={milestoneStanding(selected, now) || undefined}
                >
                    <MilestoneHeader milestone={selected} now={now} compact={compact} />
                    {marks.offer != null ? <Offer offer={marks.offer} /> : null}
                    {marks.phrasing ? (
                        <div
                            className="flex items-center gap-1.5 text-11 text-muted"
                            title={t("companion.work.phrasingTitle")}
                        >
                            <DominoLoader />
                            {t("companion.work.phrasing")}
                        </div>
                    ) : null}
                    <div className="mt-cwork-flush">
                        <MilestoneBody
                            milestone={selected}
                            rows={rows}
                            more={more}
                            links={marks.links}
                            compact={compact}
                            lit={marks.lit}
                            ends={marks.ends}
                            chips={marks.chips}
                        />
                        {todos.length > 0 ? (
                            <TodoList
                                todos={todos}
                                links={todoAgents}
                                titled
                                compact={compact}
                                chips={marks.chips}
                                lit={marks.lit}
                                ends={marks.ends}
                            />
                        ) : null}
                    </div>
                </div>
            ) : todos.length > 0 ? (
                <div className="mt-cwork-flush" data-bare="">
                    <TodoList
                        todos={todos}
                        links={todoAgents}
                        titled={loading}
                        compact={compact}
                        chips={marks.chips}
                        lit={marks.lit}
                        ends={marks.ends}
                    />
                </div>
            ) : null}
        </SectionBlock>
    );
}

function OpenMilestone({ url }: { url: string }) {
    const t = useT();
    return (
        <button
            type="button"
            className="mt-cwork-foot"
            onClick={(e) => openPage(e, url)}
            data-testid="companion-milestone-open"
        >
            {t("companion.work.openMilestone")}
            <i className="fa fa-solid fa-arrow-up-right-from-square" aria-hidden="true" />
        </button>
    );
}

function MilestoneHeader({ milestone, now, compact }: { milestone: MilestoneInfo; now: number; compact: boolean }) {
    const t = useT();
    const tCount = useTCount();
    const locale = useLocale();
    const progress = milestoneProgress(milestone);
    const progressTitle = t("companion.work.progressTitle", { closed: progress.closed, total: progress.total });
    const standing = milestoneStanding(milestone, now);
    const state = standingText(standing, milestone, now, compact, t, tCount);
    const due = dueText(milestone.due, now, locale);
    // A late milestone says how late; the date shows in its title. Any other shows its due date.
    const dueLabel =
        due == null || standing === "late"
            ? ""
            : due.kind === "today"
              ? t("companion.work.dueToday")
              : t(due.kind === "overdue" ? "companion.work.overdue" : "companion.work.due", { date: due.date });
    return (
        <div className="flex flex-col gap-2.5" data-testid="companion-milestone-header">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span
                    className="mt-cwork-name min-w-0 truncate"
                    data-compact={compact ? "" : undefined}
                    title={milestone.title}
                    data-testid="companion-milestone-title"
                >
                    {milestone.title}
                </span>
                {state ? (
                    <span
                        className="mt-cwork-state"
                        data-standing={standing}
                        title={due != null ? t("companion.work.due", { date: due.date }) : undefined}
                        data-testid="companion-milestone-state"
                    >
                        <StandingMark standing={standing} />
                        {state}
                    </span>
                ) : null}
                {dueLabel ? (
                    <span
                        className="shrink-0 text-11 text-muted"
                        data-due={due.kind}
                        data-testid="companion-milestone-due"
                    >
                        {dueLabel}
                    </span>
                ) : null}
                <span
                    className="ml-auto shrink-0 font-mono text-11 text-muted tabular-nums"
                    title={progressTitle}
                    data-testid="companion-milestone-progress"
                >
                    {compact ? (
                        `${progress.closed}/${progress.total}`
                    ) : (
                        <>
                            <span className="text-primary">{progress.closed}</span>{" "}
                            {t("companion.work.doneOf", { total: progress.total })}
                        </>
                    )}
                </span>
            </div>
            <span
                className="mt-cwork-bar"
                role="progressbar"
                aria-label={progressTitle}
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.closed}
                style={{ "--mt-cwork-progress": progress.ratio.toFixed(3) } as React.CSSProperties}
            />
        </div>
    );
}

function Offer({ offer }: { offer: SummariesOffer }) {
    const t = useT();
    return (
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
    );
}

function MilestoneBody({
    milestone,
    rows,
    more,
    links,
    compact,
    ...marks
}: {
    milestone: MilestoneInfo;
    rows: MilestoneTicket[];
    more: number;
    links: Map<number, LinkAgent[]>;
    compact: boolean;
} & EndMarks) {
    const t = useT();
    const tCount = useTCount();
    if (milestoneReady(milestone)) {
        return <ReadyPlaceholder milestone={milestone} />;
    }
    if (milestone.open <= 0) {
        return (
            <div className="mt-cwork-empty" data-testid="companion-milestone-empty">
                {t("companion.work.empty")}
            </div>
        );
    }
    if (milestone.loaded === false) {
        return (
            <div className="mt-cwork-empty flex items-center gap-2" data-testid="companion-milestone-loading">
                <DominoLoader size="card" />
                {t("companion.work.reading")}
            </div>
        );
    }
    const mine = rows.filter((row) => links.has(row.number));
    const free = rows.filter((row) => !links.has(row.number));
    const freeCount = Math.max(0, milestone.remaining - mine.length);
    return (
        <>
            {mine.length > 0 ? (
                <section className="mt-cwork-section" data-section="mine">
                    <SectionHead label={t("companion.work.inProgressHere")} count={mine.length} />
                    <ol>
                        {mine.map((row) => (
                            <TicketRow
                                key={row.number}
                                ticket={row}
                                agents={links.get(row.number) ?? []}
                                compact={compact}
                                {...marks}
                            />
                        ))}
                    </ol>
                </section>
            ) : null}
            {free.length > 0 ? (
                <section className="mt-cwork-section" data-section="free">
                    <SectionHead label={t("companion.work.toTake")} count={freeCount} />
                    <ol>
                        {free.map((row) => (
                            <TicketRow key={row.number} ticket={row} agents={[]} compact={compact} {...marks} />
                        ))}
                    </ol>
                </section>
            ) : null}
            {more > 0 ? (
                <div className="mt-cwork-slim" data-testid="companion-milestone-more">
                    {tCount("companion.work.more", more, { count: more })}
                </div>
            ) : null}
        </>
    );
}

function SectionHead({ label, count }: { label: string; count: number }) {
    return (
        <div className="mt-cwork-sec">
            <span>{label}</span>
            <span className="mt-cwork-n">{count}</span>
        </div>
    );
}

// A finished milestone that waits for its release: its tab and its count stay, and the list the tickets would fill is a
// placeholder, never an empty list. "Prepare the release" is the one action, in orange; the tickets are one click away.
function ReadyPlaceholder({ milestone }: { milestone: MilestoneInfo }) {
    const t = useT();
    const tCount = useTCount();
    return (
        <div className="mt-cwork-ready" data-testid="companion-milestone-ready">
            <span className="mt-cwork-ring" aria-hidden="true">
                <i className="fa fa-solid fa-check" />
            </span>
            <div className="mt-cwork-ready-title">{t("companion.work.noneLeft")}</div>
            <p className="mt-cwork-ready-text">{t("companion.work.noneLeftText")}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
                    title={t("companion.work.prepareReleaseTitle")}
                    onClick={openProjectView}
                    data-testid="companion-milestone-prepare"
                >
                    {t("companion.work.prepareRelease")}
                    <MoltenWave />
                </button>
                {milestone.url ? (
                    <button
                        type="button"
                        className="cursor-pointer rounded-4 border border-border px-3 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
                        onClick={(e) => openPage(e, `${milestone.url}?closed=1`)}
                        data-testid="companion-milestone-see"
                    >
                        {tCount("companion.work.seeTickets", milestone.closed, { count: milestone.closed })}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function TicketRow({
    ticket,
    agents,
    compact,
    ...marks
}: { ticket: MilestoneTicket; agents: LinkAgent[]; compact: boolean } & EndMarks) {
    const t = useT();
    const working = agents.length > 0;
    const heat = working ? heatOf(agents[0].state) : "draft";
    const text = ticket.sentence || ticket.title;
    const title = ticket.sentence ? t("companion.work.ticketTitle", { title: ticket.title }) : ticket.title;
    const mark = (
        <span className="mt-cwork-mark" data-free={working ? undefined : ""}>
            <StateMark kind={heat} label={working ? t("companion.work.inProgress") : t("companion.work.open")} />
        </span>
    );
    const id = (
        <button
            type="button"
            className="mt-cwork-id"
            data-mine={working ? "" : undefined}
            title={t("companion.work.openTicket", { number: ticket.number })}
            onClick={(e) => openPage(e, ticket.url)}
        >
            {`#${ticket.number}`}
        </button>
    );
    const body = (
        <span
            className="mt-cwork-text"
            data-free={working ? undefined : ""}
            title={title}
            data-translated={ticket.sentence ? "" : undefined}
            data-testid="companion-milestone-text"
        >
            {text}
        </span>
    );
    const chips =
        marks.chips && working ? (
            <span className="mt-cwork-chips">
                {agents.map((agent) => (
                    <LinkChip key={agent.id} agent={agent} />
                ))}
            </span>
        ) : null;
    return (
        <li
            className="mt-cwork-end mt-cwork-row"
            data-compact={compact ? "" : undefined}
            {...endAttrs(ticketEnd(ticket.number), heat, marks)}
            data-testid="companion-milestone-ticket"
        >
            {compact ? (
                working ? (
                    <>
                        <div className="mt-cwork-head">
                            {mark}
                            {id}
                            <span className="grow" />
                            {chips}
                        </div>
                        {body}
                    </>
                ) : (
                    <div className="mt-cwork-head" data-top="">
                        {mark}
                        <span
                            className="mt-cwork-text"
                            data-free=""
                            title={title}
                            data-testid="companion-milestone-text"
                        >
                            {id}
                            {text}
                        </span>
                    </div>
                )
            ) : (
                <>
                    {mark}
                    {id}
                    {body}
                    {chips}
                </>
            )}
        </li>
    );
}

const TodoMarks: Record<string, StateMarkKind> = { completed: "ready", in_progress: "running", pending: "draft" };

export function TodoList({
    todos,
    links,
    titled,
    compact,
    ...marks
}: {
    todos: CompanionTodo[];
    links: Map<number, LinkAgent>;
    titled: boolean;
    compact: boolean;
} & EndMarks) {
    const t = useT();
    const { done, total } = todoCounts(todos);
    return (
        <section className="mt-cwork-section" data-section="todos" data-testid="companion-todos">
            {titled ? (
                <div className="mt-cwork-sec">
                    <span>{t("companion.work.ownTasks")}</span>
                    <span className="mt-cwork-n">{`${done} / ${total}`}</span>
                </div>
            ) : (
                <div className="mt-cwork-sec" data-quiet="">
                    <span className="mt-cwork-n ml-auto">{`${done} / ${total}`}</span>
                </div>
            )}
            <ul>
                {todos.map((todo, i) => {
                    const agent = links.get(i);
                    const heat = agent != null ? heatOf(agent.state) : (TodoMarks[todo.status] ?? "draft");
                    return (
                        <li
                            key={i}
                            className="mt-cwork-end mt-cwork-row"
                            data-compact={compact ? "" : undefined}
                            {...endAttrs(todoEnd(i), heat, marks)}
                        >
                            <span className="mt-cwork-mark" data-free={todo.status === "pending" ? "" : undefined}>
                                <StateMark kind={TodoMarks[todo.status] ?? "draft"} />
                            </span>
                            <span
                                className={cn("mt-cwork-text", todo.status === "completed" && "line-through")}
                                data-free={todo.status === "completed" || todo.status === "pending" ? "" : undefined}
                            >
                                {todo.text}
                            </span>
                            {marks.chips && agent != null ? (
                                <span className="mt-cwork-chips">
                                    <LinkChip agent={agent} />
                                </span>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
