// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's Upcoming section (#712, FR-REV-022 AC1 and AC11), after the PR sections: the ticket branches with
// commits and no PR yet. Each is a card like a PR's (#1061): a rail and a state sentence (an agent waits for you, an
// agent is on it, nobody on it), one action (Answer, Go there, Open the ticket) and a "…" menu holding Launch. What
// waits for the developer comes first; branches whose agents run inside one session are grouped under it, with one
// Go there. A branch leaves as soon as its PR is listed. A merged PR's branch holding nothing new is not upcoming: it
// shows under the leftovers right after (#1088, reviews-leftovers.tsx).

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AgentStates } from "../agent-state-store";
import { modelDisplayName } from "../companion/companion-proportion";
import { TFunction, useT, useTCount } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { showPanel } from "../review/review-panels";
import { StateMark } from "../state-mark";
import { DominoLoader } from "../suite/suite";
import { AgentBar, useMinuteNow } from "./reviews-agent-bar";
import { CalmButton, MoltenButton, MoreButton, RailColours, SentenceClasses, ToneMarks } from "./reviews-card";
import type { CardTone } from "./reviews-card-model";
import { LaunchCardActions } from "./reviews-launch";
import { LaunchModel } from "./reviews-launch-client";
import { launchTargetOfBranch } from "./reviews-launch-model";
import type { ReviewsAnswer } from "./reviews-model";
import { ReviewsFolds, sectionOpen } from "./reviews-order-store";
import { SectionHeading } from "./reviews-section-heading";
import { upcomingEntries, UpcomingEntry, UpcomingItem, upcomingWaitingCount } from "./reviews-sections-model";
import { ReviewsModel } from "./reviews-store";
import { useUpcomingAnswer, useUpcomingWatch } from "./reviews-upcoming-client";
import {
    afterPrText,
    AgentBarFacts,
    aheadText,
    boardStatusText,
    branchAgent,
    durationText,
    UpcomingBranch,
    upcomingFocusBranch,
    UpcomingFocusMarkMs,
    upcomingRows,
} from "./reviews-upcoming-model";

// Loaded on demand: the leftovers only show once a PR has merged, so their code stays out of the JS every tab view
// loads up front (NFR-PERF-003, bundle.initialJsMB).
const LeftoversSection = lazy(() => import("./reviews-leftovers").then((m) => ({ default: m.LeftoversSection })));

function ticketUrl(branch: UpcomingBranch, repoUrl: string): string {
    if (branch.url) {
        return branch.url;
    }
    return repoUrl && branch.ticket > 0 ? `${repoUrl.replace(/\/$/, "")}/issues/${branch.ticket}` : "";
}

function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

// The menu under its button, whether clicked or pressed from the keyboard.
function showMenu(e: React.MouseEvent, items: ContextMenuItem[]) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const anchored = {
        clientX: rect.left,
        clientY: rect.bottom,
        target: e.currentTarget,
        altKey: e.altKey,
        type: e.type,
        detail: e.detail,
        stopPropagation: () => e.stopPropagation(),
        preventDefault: () => e.preventDefault(),
    } as unknown as React.MouseEvent;
    ContextMenuModel.getInstance().showContextMenu(items, anchored);
}

// The terminal an agent's Go there shows: its own panel, or its parent session's.
function agentPanel(agent: AgentBarFacts): string {
    if (agent == null) {
        return "";
    }
    return agent.kind === "panel" ? (agent.blockId ?? "") : (agent.parentBlockId ?? "");
}

export function UpcomingSection({
    dir,
    reviews,
    defaultOpen = true,
}: {
    dir: string;
    reviews: ReviewsAnswer;
    // Folded by default when the panel's content is longer than the panel (#1061), unless an agent here waits.
    defaultOpen?: boolean;
}) {
    const t = useT();
    const tCount = useTCount();
    useUpcomingWatch(dir, reviews);
    const upcoming = useUpcomingAnswer(dir);
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const folds = useAtomValue(ReviewsFolds.getInstance().foldsAtom);
    const rows = useMemo(() => upcomingRows(upcoming, reviews), [upcoming, reviews]);
    const entries = useMemo(
        () =>
            upcomingEntries(
                rows,
                (branch) => branchAgent(upcoming, states, branch),
                (blockId) => states?.states?.[blockId]?.state === "waiting"
            ),
        [rows, upcoming, states]
    );
    const waiting = upcomingWaitingCount(entries);
    const open = sectionOpen(folds, dir, "upcoming", defaultOpen || waiting > 0);
    const setOpen = (value: boolean) => ReviewsFolds.getInstance().set(dir, "upcoming", value);
    const model = ReviewsModel.getInstance();
    const focus = useAtomValue(model.focusAtom);
    const [marked, setMarked] = useState<string>(null);
    const listRef = useRef<HTMLDivElement>(null);
    // A future PR's entry asked by another surface (the browser's test context, #962): brought into sight and marked.
    useEffect(() => {
        const branch = upcomingFocusBranch(focus, dir, rows);
        if (branch == null) {
            return;
        }
        globalStore.set(model.focusAtom, null);
        setOpen(true);
        setMarked(branch);
    }, [focus, dir, rows, model]);
    useEffect(() => {
        if (marked == null) {
            return;
        }
        const timer = setTimeout(() => setMarked(null), UpcomingFocusMarkMs);
        return () => clearTimeout(timer);
    }, [marked]);
    useEffect(() => {
        if (marked == null || !open) {
            return;
        }
        for (const row of listRef.current?.querySelectorAll<HTMLElement>("[data-branch]") ?? []) {
            if (row.dataset.branch === marked) {
                row.scrollIntoView?.({ block: "nearest" });
                row.focus();
            }
        }
    }, [marked, open, rows]);
    return (
        <>
            <section className="flex flex-col gap-2" aria-label={t("reviewsAgents.upcoming.title")}>
                <SectionHeading
                    title={t("reviewsAgents.upcoming.title")}
                    count={upcoming == null ? "" : rows.length}
                    hint={waiting > 0 ? tCount("reviewsAgents.upcoming.waitingHint", waiting) : undefined}
                    open={open}
                    onToggle={() => setOpen(!open)}
                    testId="reviews-upcoming-toggle"
                />
                {!open ? null : upcoming == null ? null : rows.length === 0 ? (
                    <p
                        className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted"
                        data-testid="reviews-upcoming-empty"
                        title={serverText(upcoming.errortext, upcoming.error) || undefined}
                    >
                        {t("reviewsAgents.upcoming.none")}
                    </p>
                ) : (
                    <div
                        ref={listRef}
                        className="overflow-clip rounded-4 border border-border [overflow-clip-margin:1px]"
                        role="list"
                        data-testid="reviews-upcoming"
                    >
                        {entries.map((entry) =>
                            entry.kind === "session" ? (
                                <SessionCard
                                    key={entry.key}
                                    dir={dir}
                                    entry={entry}
                                    repoUrl={reviews?.url}
                                    marked={marked}
                                />
                            ) : (
                                <UpcomingRow
                                    key={entry.key}
                                    dir={dir}
                                    item={entry.item}
                                    repoUrl={reviews?.url}
                                    marked={marked === entry.item.branch.branch}
                                />
                            )
                        )}
                    </div>
                )}
                {open && upcoming?.ticketserror ? (
                    <div className="text-11 text-muted" title={upcoming.ticketserror}>
                        {t("reviewsAgents.upcoming.ticketsError")}
                    </div>
                ) : null}
            </section>
            <Suspense fallback={null}>
                <LeftoversSection dir={dir} reviews={reviews} upcoming={upcoming} defaultOpen={defaultOpen} />
            </Suspense>
        </>
    );
}

type UpcomingState = { tone: CardTone; sentence: string; why?: string; saysStatus?: boolean };

// An upcoming branch's state: an agent waiting for you, an agent on it (or done, idle), or nobody on it.
export function upcomingState(t: TFunction, branch: UpcomingBranch, agent: AgentBarFacts): UpcomingState {
    if (agent == null) {
        const why = [
            branch.status ? boardStatusText(t, branch.status) : "",
            branch.remote ? t("reviewsAgents.upcoming.remote") : "",
        ]
            .filter(Boolean)
            .join(", ");
        return { tone: "wait", sentence: t("reviewsAgents.upcoming.state.nobody"), why, saysStatus: true };
    }
    if (agent.kind === "background") {
        return agent.parentName
            ? { tone: "agent", sentence: t("reviewsAgents.upcoming.state.subagent", { name: agent.parentName }) }
            : { tone: "agent", sentence: t("reviewsAgents.upcoming.state.background") };
    }
    if (agent.kind === "subagent") {
        const name = agent.parentName || t("reviewsAgents.subagent.name");
        return agent.state === "done"
            ? { tone: "wait", sentence: t("reviewsAgents.upcoming.state.subagentDone", { name }) }
            : { tone: "agent", sentence: t("reviewsAgents.upcoming.state.subagent", { name }) };
    }
    switch (agent.state) {
        case "waiting":
            return { tone: "you", sentence: t("reviews.card.state.agentWaiting", { name: agent.name }) };
        case "working":
            return { tone: "agent", sentence: t("reviews.card.state.agentWorking", { name: agent.name }) };
        case "done":
            return { tone: "wait", sentence: t("reviewsAgents.upcoming.state.done", { name: agent.name }) };
    }
    return { tone: "wait", sentence: t("reviewsAgents.upcoming.state.idle", { name: agent.name }) };
}

function UpcomingRow({
    dir,
    item,
    repoUrl,
    marked,
}: {
    dir: string;
    item: UpcomingItem;
    repoUrl: string;
    marked: boolean;
}) {
    const t = useT();
    const { branch, agent } = item;
    const url = ticketUrl(branch, repoUrl);
    const panel = agentPanel(agent);
    const state = upcomingState(t, branch, agent);
    const afterText = afterPrText(t, branch);
    const answers = agent?.kind === "panel" && agent.state === "waiting" && !!panel;
    const openTicket = () => {
        if (url) {
            fireAndForget(() => openWebLink(url));
        }
    };
    const goThere = () => fireAndForget(() => showPanel(panel));
    const open = panel ? goThere : openTicket;
    const primary = answers
        ? { label: t("reviews.card.action.answer", { name: agent.name }), run: goThere, molten: true }
        : panel
          ? { label: t("reviewsAgents.upcoming.goThere"), run: goThere, molten: false }
          : url
            ? { label: t("reviewsAgents.upcoming.openTicket"), run: openTicket, molten: false }
            : null;
    const openMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = [
            {
                label: t("reviews.card.action.launch"),
                click: () => LaunchModel.getInstance().ask(dir, launchTargetOfBranch(branch)),
            },
        ];
        if (url && primary?.run !== openTicket) {
            items.push({ label: t("reviewsAgents.upcoming.openTicket"), click: openTicket });
        }
        showMenu(e, items);
    };
    return (
        <div
            role="listitem"
            tabIndex={0}
            data-branch={branch.branch}
            data-tone={state.tone}
            onClick={open}
            onKeyDown={(e) => {
                if (e.key !== "Enter" || e.target !== e.currentTarget) {
                    return;
                }
                e.preventDefault();
                open();
            }}
            aria-current={marked || undefined}
            className={cn(
                "relative flex cursor-pointer flex-col gap-1 border-b border-border py-2.5 pr-3 pl-[15px] outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover",
                marked && "bg-hover/60 ring-2 ring-accent/70 ring-inset"
            )}
            title={panel ? t("reviewsAgents.upcoming.openAgent") : t("reviewsAgents.upcoming.openTicket")}
            data-testid="reviews-upcoming-row"
        >
            <span
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ background: RailColours[state.tone] }}
                aria-hidden
            />
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-1.5 text-13 leading-5 font-medium">
                        <span className="shrink-0 text-accent">#{branch.ticket}</span>
                        <span className="min-w-0 truncate" title={branch.branch}>
                            {branch.title || branch.branch}
                        </span>
                    </div>
                    <StateLine state={state} />
                    <div className="flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1 text-11 leading-4 text-muted">
                        <span>{aheadText(t, branch.ahead)}</span>
                        {afterText ? <span data-testid="reviews-upcoming-after">{afterText}</span> : null}
                        {branch.remote && !state.saysStatus ? <span>{t("reviewsAgents.upcoming.remote")}</span> : null}
                        {branch.status && !state.saysStatus ? (
                            <span title={t("reviewsAgents.upcoming.statusTitle")} data-testid="reviews-upcoming-status">
                                {boardStatusText(t, branch.status)}
                            </span>
                        ) : null}
                        <LaunchCardActions dir={dir} target={launchTargetOfBranch(branch)} runningOnly />
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {primary != null ? (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                primary.run();
                            }}
                            onKeyDown={stop}
                            className={primary.molten ? MoltenButton : CalmButton}
                            data-testid="reviews-upcoming-primary"
                            data-molten={primary.molten || undefined}
                        >
                            {primary.label}
                            {primary.molten ? <MoltenWave /> : null}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={openMenu}
                        onKeyDown={stop}
                        aria-haspopup="menu"
                        aria-label={t("reviewsAgents.upcoming.moreTitle", { ticket: branch.ticket })}
                        title={t("reviews.card.more")}
                        className={MoreButton}
                        data-testid="reviews-upcoming-more"
                    >
                        <i className="fa fa-solid fa-ellipsis text-12" aria-hidden />
                    </button>
                </div>
            </div>
            {agent != null ? <AgentBar facts={agent} /> : null}
        </div>
    );
}

function StateLine({ state }: { state: UpcomingState }) {
    return (
        <div
            className={cn(
                "flex min-w-0 items-baseline gap-1.5 text-12 leading-4 font-medium",
                SentenceClasses[state.tone]
            )}
            data-testid="reviews-upcoming-state"
        >
            <StateMark kind={ToneMarks[state.tone]} className="self-center" />
            <span className="min-w-0 truncate">
                {state.sentence}
                {state.why ? <span className="font-normal text-secondary"> · {state.why}</span> : null}
            </span>
        </div>
    );
}

// A session's card (FR-REV-022 AC11): the tickets its sub-agents and background agents work on, one line each with
// its own state, and one Go there for the session's panel.
function SessionCard({
    dir,
    entry,
    repoUrl,
    marked,
}: {
    dir: string;
    entry: Extract<UpcomingEntry, { kind: "session" }>;
    repoUrl: string;
    marked: string;
}) {
    const t = useT();
    const tCount = useTCount();
    const now = useMinuteNow();
    const name = entry.parentName;
    const tone: CardTone = entry.waiting ? "you" : "agent";
    const sentence = entry.waiting
        ? t("reviews.card.state.agentWaiting", { name: name || t("reviews.card.anAgent") })
        : tCount("reviewsAgents.upcoming.session.orchestrates", entry.items.length, {
              name: name || t("reviews.card.anAgent"),
          });
    const goThere = () => fireAndForget(() => showPanel(entry.parentBlockId));
    const openMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = entry.items.map((item) => ({
            label: t("reviewsAgents.upcoming.session.launch", { ticket: item.branch.ticket }),
            click: () => LaunchModel.getInstance().ask(dir, launchTargetOfBranch(item.branch)),
        }));
        showMenu(e, items);
    };
    return (
        <div
            role="listitem"
            tabIndex={0}
            data-session={entry.parentBlockId}
            data-tone={tone}
            onClick={goThere}
            onKeyDown={(e) => {
                if (e.key !== "Enter" || e.target !== e.currentTarget) {
                    return;
                }
                e.preventDefault();
                goThere();
            }}
            className="relative flex cursor-pointer flex-col gap-1 border-b border-border py-2.5 pr-3 pl-[15px] outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover"
            title={t("reviewsAgents.upcoming.openAgent")}
            data-testid="reviews-upcoming-session"
        >
            <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: RailColours[tone] }} aria-hidden />
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-1.5 text-13 leading-5 font-medium">
                        <span className="min-w-0 truncate text-secondary">
                            {name
                                ? t("reviewsAgents.upcoming.session.title", { name })
                                : t("reviewsAgents.upcoming.session.titleUnknown")}
                        </span>
                        <span className="shrink-0 rounded-2 border border-border px-1 text-10 leading-[14px] font-semibold tracking-[0.06em] text-muted uppercase">
                            {tCount("reviewsAgents.upcoming.session.agents", entry.items.length)}
                        </span>
                    </div>
                    <StateLine state={{ tone, sentence }} />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            goThere();
                        }}
                        onKeyDown={stop}
                        className={entry.waiting ? MoltenButton : CalmButton}
                        data-testid="reviews-upcoming-primary"
                    >
                        {entry.waiting
                            ? t("reviews.card.action.answer", { name })
                            : t("reviewsAgents.upcoming.goThere")}
                        {entry.waiting ? <MoltenWave /> : null}
                    </button>
                    <button
                        type="button"
                        onClick={openMenu}
                        onKeyDown={stop}
                        aria-haspopup="menu"
                        aria-label={t("reviews.card.more")}
                        title={t("reviews.card.more")}
                        className={MoreButton}
                        data-testid="reviews-upcoming-more"
                    >
                        <i className="fa fa-solid fa-ellipsis text-12" aria-hidden />
                    </button>
                </div>
            </div>
            <div className="-mx-3 -mb-2.5 mt-1 flex flex-col border-t border-border bg-black/10">
                {entry.items.map((item) => (
                    <SessionLine
                        key={item.branch.branch}
                        item={item}
                        now={now}
                        url={ticketUrl(item.branch, repoUrl)}
                        marked={marked === item.branch.branch}
                    />
                ))}
            </div>
        </div>
    );
}

function SessionLine({ item, now, url, marked }: { item: UpcomingItem; now: number; url: string; marked: boolean }) {
    const t = useT();
    const { branch, agent } = item;
    const working = agent.kind === "background" || agent.state === "working";
    const stateText =
        agent.kind === "background"
            ? t("reviewsAgents.state.background")
            : agent.subState === "done"
              ? t("reviewsAgents.subagent.finishedAgo", { duration: durationText(t, now - (agent.since ?? now)) })
              : agent.subState === "quiet"
                ? t("reviewsAgents.subagent.state.quiet")
                : t("reviewsAgents.state.working");
    const detail =
        agent.kind === "background"
            ? t("reviewsAgents.upcoming.session.background")
            : modelDisplayName(agent.model) || (branch.status ? boardStatusText(t, branch.status) : "");
    return (
        <div
            tabIndex={-1}
            data-branch={branch.branch}
            onClick={(e) => {
                if (!url) {
                    return;
                }
                e.stopPropagation();
                fireAndForget(() => openWebLink(url));
            }}
            className={cn(
                "flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 pl-[15px] text-11 leading-4 text-muted outline-none last:border-b-0",
                url && "cursor-pointer hover:text-secondary",
                marked && "ring-2 ring-accent/70 ring-inset"
            )}
            title={url ? t("reviewsAgents.upcoming.openTicket") : undefined}
            data-testid="reviews-upcoming-session-line"
        >
            <b className="shrink-0 font-semibold text-accent">#{branch.ticket}</b>
            <span className="min-w-0 truncate text-secondary">{branch.title || branch.branch}</span>
            {working && agent.kind !== "background" ? (
                <DominoLoader className="shrink-0 text-[var(--mt-state-working)]" label={stateText} />
            ) : (
                <span className="shrink-0">· {stateText}</span>
            )}
            <span className="ml-auto shrink-0">{detail}</span>
        </div>
    );
}
