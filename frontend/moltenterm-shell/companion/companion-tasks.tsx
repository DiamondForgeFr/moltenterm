// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's Tasks block (FR-SHELL-018, #2392, #2416): a suite block whose label is one tab per open milestone, the
// selected milestone's header (name, state, due date, count, progress), its remaining tickets in flush rows, or, for a
// finished milestone that waits for its release, the "No tickets left" placeholder. The agent's own tasks close the
// block. Display only: the data comes from companion-work.tsx.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { openLink } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { Flag } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { boardStatusText } from "../reviews/reviews-upcoming-model";
import { StateMark, StateMarkKind } from "../state-mark";
import { DominoLoader, nextToggleIndex, suiteTabId, SuiteTabs } from "../suite/suite";
import { CompanionBlock, FootLink, MoreButton } from "./companion-block";
import { capList } from "./companion-flow-model";
import { ownerNames, stripSquares, TaskLists, TicketHold, TicketOwner } from "./companion-holds-model";
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
} from "./companion-milestone-model";

// The tickets other agents hold that the group lists, before it says how many more.
const MaxTakenRows = 8;

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

export type EndMarks = { chips: boolean; lit: ReadonlySet<string>; ends: ReadonlySet<string> };

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
    // The selected milestone's tickets by who holds them: the rows of work shown, and the group of those others hold.
    lists: TaskLists;
    // The group's fold state as the developer left it, undefined while he never chose: the block's width decides then
    // (folded when narrow). onTakenChange is asked to remember his choice.
    takenOpen: boolean | undefined;
    onTakenChange: (open: boolean) => void;
    phrasing: boolean;
    offer: SummariesOffer;
    links: Map<number, LinkAgent[]>;
    now: number;
    // The block's place in the companion's flow, and what the flow attaches to it (the pointer on its link ends).
    flowId?: string;
    blockProps?: React.HTMLAttributes<HTMLElement>;
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
    const {
        loading,
        milestones,
        selected,
        onSelect,
        width,
        lists,
        takenOpen,
        onTakenChange,
        now,
        flowId,
        blockProps,
        ...marks
    } = props;
    const t = useT();
    const tCount = useTCount();
    const panelId = useId();
    const compact = width > 0 && width < CompactBlockPx;
    const takenShown = takenOpen ?? !compact;
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
        <CompanionBlock
            flowId={flowId}
            label={tabbed ? undefined : t("companion.tasks")}
            tabs={tabs != null ? <BlockTabs tabs={tabs} /> : undefined}
            icon={<Flag strokeWidth={2} aria-hidden />}
            foot={footer}
            aria-label={tabbed ? t("companion.tasks") : undefined}
            className="mt-cwork-block"
            data-testid="companion-tasks"
            {...blockProps}
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
                    <MilestoneHeader milestone={selected} lists={lists} now={now} compact={compact} />
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
                            lists={lists}
                            takenOpen={takenShown}
                            onToggleTaken={() => onTakenChange(!takenShown)}
                            links={marks.links}
                            compact={compact}
                            lit={marks.lit}
                            ends={marks.ends}
                            chips={marks.chips}
                        />
                    </div>
                </div>
            ) : null}
        </CompanionBlock>
    );
}

// The tabs of the block's label: one tab stop on the selected tab, the arrows and Home / End move and choose (WAI-ARIA
// tabs with automatic activation, as the suite's blocks have them).
function BlockTabs({ tabs }: { tabs: SuiteTabs }) {
    const listRef = useRef<HTMLSpanElement>(null);
    const selectedIndex = tabs.tabs.findIndex((tab) => tab.value === tabs.selected);
    const tabStop = selectedIndex < 0 ? 0 : selectedIndex;
    const onKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
        const nodes = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
        const next = nextToggleIndex(e.key, nodes.indexOf(document.activeElement as HTMLElement), tabs.tabs.length);
        if (next < 0) {
            return;
        }
        e.preventDefault();
        nodes[next]?.focus();
        tabs.onSelect(tabs.tabs[next].value);
    };
    return (
        <span
            ref={listRef}
            role="tablist"
            aria-label={tabs.label}
            className="flex min-w-0 items-center gap-1.5"
            onKeyDown={onKeyDown}
        >
            {tabs.tabs.map((tab, i) => (
                <button
                    key={tab.value}
                    type="button"
                    role="tab"
                    id={tabs.panelId ? suiteTabId(tabs.panelId, tab.value) : undefined}
                    aria-selected={tab.value === tabs.selected}
                    aria-controls={tabs.panelId}
                    tabIndex={i === tabStop ? 0 : -1}
                    title={tab.title}
                    className={cn("mt-cb-chip", tab.value !== tabs.selected && "mt-cb-chip-off")}
                    onClick={(e) => {
                        e.stopPropagation();
                        tabs.onSelect(tab.value);
                    }}
                >
                    <span className="mt-cb-chip-text">{tab.label}</span>
                    {tab.mark}
                </button>
            ))}
            {tabs.more ? (
                <button
                    type="button"
                    aria-haspopup="menu"
                    title={tabs.more.title}
                    className="mt-cb-chip mt-cb-chip-off"
                    data-mono=""
                    onClick={tabs.more.onOpen}
                >
                    {tabs.more.label}
                </button>
            ) : null}
        </span>
    );
}

function OpenMilestone({ url }: { url: string }) {
    const t = useT();
    return (
        <FootLink onClick={(e) => openPage(e, url)} testId="companion-milestone-open">
            {t("companion.work.openMilestone")}
        </FootLink>
    );
}

// The strip under the progress bar: one square per open ticket, this agent's (incandescent), another's (iron) and free
// (hollow), then the three counts in words, so no state rests on its colour alone.
function Strip({ lists, compact }: { lists: TaskLists; compact: boolean }) {
    const t = useT();
    const { counts } = lists;
    const left = counts.mine + counts.taken + counts.free;
    if (left <= 0) {
        return null;
    }
    return (
        <div className="mt-cwork-strip" data-compact={compact ? "" : undefined} data-testid="companion-milestone-strip">
            {compact ? null : <span className="text-11 text-muted">{t("companion.work.left", { count: left })}</span>}
            <span className="mt-cwork-squares" aria-hidden="true">
                {stripSquares(counts).map((kind, i) => (
                    <span key={i} data-kind={kind} />
                ))}
            </span>
            <span className="mt-cwork-counts">
                {counts.mine > 0 ? (
                    <span data-kind="mine">{t("companion.work.countMine", { count: counts.mine })}</span>
                ) : null}
                {counts.taken > 0 ? (
                    <span data-kind="other">{t("companion.work.countOthers", { count: counts.taken })}</span>
                ) : null}
                {counts.free > 0 ? (
                    <span data-kind="free">{t("companion.work.countFree", { count: counts.free })}</span>
                ) : null}
            </span>
        </div>
    );
}

function MilestoneHeader({
    milestone,
    lists,
    now,
    compact,
}: {
    milestone: MilestoneInfo;
    lists: TaskLists;
    now: number;
    compact: boolean;
}) {
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
            {lists != null && milestone.loaded !== false ? <Strip lists={lists} compact={compact} /> : null}
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
    lists,
    takenOpen,
    onToggleTaken,
    links,
    compact,
    ...marks
}: {
    milestone: MilestoneInfo;
    lists: TaskLists;
    takenOpen: boolean;
    onToggleTaken: () => void;
    links: Map<number, LinkAgent[]>;
    compact: boolean;
} & EndMarks) {
    const t = useT();
    const tCount = useTCount();
    const [mineOpen, setMineOpen] = useState(false);
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
    // Every ticket in progress here, eight at a time (#2441); the free ones fill what is left of the rows.
    const allMine = lists.mine?.length > 0 ? lists.mine : lists.rows.filter((row) => links.has(row.number));
    const mine = capList(allMine, mineOpen);
    const free = lists.rows.filter((row) => !links.has(row.number));
    return (
        <>
            {mine.shown.length > 0 ? (
                <section className="mt-cwork-section" data-section="mine">
                    <SectionHead label={t("companion.work.inProgressHere")} count={lists.counts.mine} />
                    <ol>
                        {mine.shown.map((row) => (
                            <TicketRow
                                key={row.number}
                                ticket={row}
                                agents={links.get(row.number) ?? []}
                                compact={compact}
                                {...marks}
                            />
                        ))}
                    </ol>
                    <MoreButton
                        more={mine.more}
                        open={mineOpen}
                        onToggle={() => setMineOpen(!mineOpen)}
                        label={tCount("companion.dash.andMore", mine.more, { count: mine.more })}
                        lessLabel={t("companion.dash.showLess")}
                        testId="companion-milestone-mine-more"
                    />
                </section>
            ) : null}
            {free.length > 0 ? (
                <section className="mt-cwork-section" data-section="free">
                    <SectionHead label={t("companion.work.toTake")} count={lists.counts.free} />
                    <ol>
                        {free.map((row) => (
                            <TicketRow key={row.number} ticket={row} agents={[]} compact={compact} {...marks} />
                        ))}
                    </ol>
                </section>
            ) : null}
            {lists.more > 0 ? (
                <div className="mt-cwork-slim" data-testid="companion-milestone-more">
                    {tCount("companion.work.more", lists.more, { count: lists.more })}
                </div>
            ) : null}
            {lists.taken.length > 0 ? (
                <TakenGroup taken={lists.taken} open={takenOpen} onToggle={onToggleTaken} />
            ) : null}
        </>
    );
}

// What the Taken by others group says of a ticket's holder, on its right: the agent to go to, or, with no agent known,
// the board column, the pull request or the worktree that says it is taken.
function HoldTag({ hold }: { hold: TicketHold }) {
    const t = useT();
    switch (hold.kind) {
        case "agent":
            return <OwnerLink owner={hold.owner} />;
        case "status":
            return (
                <span className="mt-cwork-tag" data-testid="companion-taken-status">
                    {boardStatusText(t, hold.status)}
                </span>
            );
        case "pr":
            return hold.url ? (
                <button
                    type="button"
                    className="mt-cwork-tag mt-cwork-tag-link"
                    onClick={(e) => openPage(e, hold.url)}
                    title={t("companion.work.openPr", { number: hold.pr })}
                    data-testid="companion-taken-pr"
                >
                    {t("companion.work.pr", { number: hold.pr })}
                </button>
            ) : (
                <span className="mt-cwork-tag" data-testid="companion-taken-pr">
                    {hold.pr > 0 ? t("companion.work.pr", { number: hold.pr }) : t("companion.work.prDraft")}
                </span>
            );
        case "branch":
            return (
                <span className="mt-cwork-tag" title={hold.branch} data-testid="companion-taken-branch">
                    {t("companion.work.onBranch")}
                </span>
            );
        case "away":
            return (
                <span className="mt-cwork-tag" title={t("companion.work.awayTitle")} data-testid="companion-taken-away">
                    {t("companion.work.away")}
                </span>
            );
    }
    return null;
}

// The agent that holds the ticket: its first name and tool, "sub-agent of" its lead's name for a sub-agent. A click goes
// to that agent's panel, as Go to the agent does in the Integration panel.
function OwnerLink({ owner }: { owner: TicketOwner }) {
    const t = useT();
    const label = [owner.name, owner.tool].filter((s) => !!s).join(" · ") || t("companion.work.someAgent");
    const title = owner.subagent
        ? t("companion.work.subagentOf", { name: owner.name || t("companion.work.someAgent") })
        : t("companion.work.goTo", { name: label });
    return (
        <button
            type="button"
            className="mt-cwork-owner"
            title={title}
            disabled={!owner.blockId}
            onClick={(e) => goToAgent(e, owner.blockId)}
            data-testid="companion-taken-owner"
            data-subagent={owner.subagent ? "" : undefined}
        >
            <span className="mt-cwork-initial" aria-hidden="true">
                {(owner.name || "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="truncate">{label}</span>
            {owner.subagent ? <span className="mt-cwork-sub">{t("companion.work.subagent")}</span> : null}
        </button>
    );
}

function goToAgent(e: React.MouseEvent, blockId: string) {
    e.stopPropagation();
    if (!blockId) {
        return;
    }
    fireAndForget(async () => {
        const { showPanel } = await import("../review/review-panels");
        await showPanel(blockId);
    });
}

// The tickets other agents hold, compact and apart: never work to do (no sentence, no link line, not in "and N more").
// It folds to one line, with the owners' names, and opens on click.
function TakenGroup({ taken, open, onToggle }: { taken: TaskLists["taken"]; open: boolean; onToggle: () => void }) {
    const t = useT();
    const tCount = useTCount();
    const names = ownerNames(taken);
    return (
        <section className="mt-cwork-section" data-section="taken" data-testid="companion-taken">
            <button
                type="button"
                className="mt-cwork-sec mt-cwork-sec-fold"
                aria-expanded={open}
                onClick={(e) => {
                    e.stopPropagation();
                    onToggle();
                }}
                data-testid="companion-taken-head"
            >
                <i className={cn("fa fa-solid", open ? "fa-chevron-down" : "fa-chevron-right")} aria-hidden="true" />
                <span>{t("companion.work.takenByOthers")}</span>
                <span className="mt-cwork-n">{taken.length}</span>
                {!open && names.length > 0 ? <span className="mt-cwork-names">{names.join(", ")}</span> : null}
            </button>
            {open ? (
                <ul>
                    {taken.slice(0, MaxTakenRows).map(({ ticket, hold }) => (
                        <li
                            key={ticket.number}
                            className="mt-cwork-taken"
                            data-testid="companion-taken-ticket"
                            data-hold={hold.kind}
                        >
                            <span className="mt-cwork-mark" data-other="">
                                <StateMark kind="running" label={t("companion.work.takenElsewhere")} />
                            </span>
                            <button
                                type="button"
                                className="mt-cwork-id"
                                title={t("companion.work.openTicket", { number: ticket.number })}
                                onClick={(e) => openPage(e, ticket.url)}
                            >
                                {`#${ticket.number}`}
                            </button>
                            <span className="mt-cwork-title truncate" title={ticket.title}>
                                {ticket.title}
                            </span>
                            <HoldTag hold={hold} />
                        </li>
                    ))}
                    {taken.length > MaxTakenRows ? (
                        <li className="mt-cwork-slim" data-testid="companion-taken-more">
                            {tCount("companion.work.takenMore", taken.length - MaxTakenRows, {
                                count: taken.length - MaxTakenRows,
                            })}
                        </li>
                    ) : null}
                </ul>
            ) : null}
        </section>
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
