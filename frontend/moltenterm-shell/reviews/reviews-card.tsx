// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A Reviews card (#1060, FR-REV-001 AC11): one computed state (reviews-card-model.ts) draws the left rail, one state
// sentence with its reason, one primary action and a "…" menu for the rest; the facts line carries what is true but
// is no state; every agent of the branch has its own line below. In the merge queue (#1062) the card carries its rank
// and its place in the order's direction, and its conflicts with the other cards; its "…" menu takes it out of the group
// merge or puts it back (#1108). Its number is its ticket's, its PR's a chip (#1108). A click on the card, or Enter on it, opens the PR's
// assisted review; the card's own buttons keep their clicks and keys.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { cn, fireAndForget } from "@/util/util";
import { useMemo, useState } from "react";
import { useEscape } from "../dialog-frame";
import { useLocale, useT } from "../i18n/i18n";
import { Phrase, phrase, useWordPhrase } from "../i18n/phrase";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { showPanel } from "../review/review-panels";
import { DominoLoader } from "../suite/suite";
import { RowAgentLine, useCardContext, useHeadStillFails } from "./reviews-agent-bar";
import type { QueuedAsk } from "./reviews-ask-queue";
import { BatchRowChip } from "./reviews-batch";
import type { BatchRowMark } from "./reviews-batch-model";
import { CardAction, CardFact, CardFactTone, cardState, CardState, CardTone } from "./reviews-card-model";
import { RerunConfirm, useRerunFailed } from "./reviews-ci-actions";
import { relationClass } from "./reviews-forecast";
import { LaunchCardActions } from "./reviews-launch";
import { LaunchModel } from "./reviews-launch-client";
import { launchTargetOfPr } from "./reviews-launch-model";
import { MarkReadyConfirm, useMarkReady } from "./reviews-mark-ready";
import { blockersText, RebaseAsk, RebaseOutcome, reviewHeadline, ReviewPr } from "./reviews-model";
import { MergeOrderRank } from "./reviews-order";
import { QueuedAskLine } from "./reviews-queue";
import { CardRelation, groupMergeAction } from "./reviews-queue-model";
import { cardInputOf } from "./reviews-sections-model";
import { ReviewsModel } from "./reviews-store";
import type { PrTaskKind } from "./reviews-task-model";

export const RailColours: Record<CardTone, string> = {
    ready: "var(--mt-state-done)",
    you: "var(--mt-state-waiting)",
    agent: "var(--mt-state-working)",
    broken: "var(--mt-state-error)",
    wait: "var(--mt-line-2)",
};

export const SentenceClasses: Record<CardTone, string> = {
    ready: "text-success",
    you: "text-[var(--mt-state-waiting)]",
    agent: "text-accent",
    broken: "text-danger",
    wait: "text-secondary",
};

const FactClasses: Record<CardFactTone, string> = {
    ok: "text-muted",
    soft: "text-[var(--mt-state-waiting)]",
    bad: "text-danger",
    muted: "text-muted",
    running: "text-muted",
};

export const CalmButton =
    "flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2.5 text-12 whitespace-nowrap text-primary hover:bg-hover";
export const MoltenButton =
    "molten-btn flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-6 px-2.5 text-12";
// A disabled action keeps the calm look, never the molten one, and says why on hover and to assistive technologies.
const DisabledButton =
    "flex h-[26px] shrink-0 items-center gap-1.5 rounded-6 border border-border/60 px-2.5 text-12 whitespace-nowrap text-muted opacity-70";
export const MoreButton =
    "flex h-[26px] w-[26px] shrink-0 cursor-pointer items-center justify-center rounded-6 border border-transparent text-secondary hover:border-border hover:text-primary";
const ConfirmButton =
    "flex shrink-0 cursor-pointer items-center rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

// The card's own controls keep their click and keys: the card's click opens the review.
function stopRow(e: React.SyntheticEvent) {
    e.stopPropagation();
}

// What a primary button names on hover, when its label alone does not say it.
function actionTitle(action: CardAction, pr: ReviewPr, name: Phrase): Phrase {
    switch (action.id) {
        case "answer":
        case "follow":
            return agentActionTitle(action, name);
        case "relaunch":
            return phrase("reviews.card.actionTitle.relaunch", { name });
        case "start-agent":
            return phrase("reviews.card.actionTitle.startAgent");
        case "resume":
            return phrase("reviews.card.actionTitle.resume", { name });
        case "rebase":
            return phrase("reviews.card.actionTitle.rebase", { base: pr.base });
        case "investigate":
            return phrase("reviews.card.actionTitle.investigate", { blockers: blockersText(pr) });
    }
    return null;
}

// A confirmation asked in the card before an action runs (#943: it asks, it never blocks).
type CardConfirm = { action: CardAction; text: Phrase };

export function ReviewRow({
    pr,
    selected,
    marked,
    onSelect,
    onOpen,
    onValidate,
    onAskRebase,
    onInvestigate,
    rebaseAsk,
    dir,
    repo,
    relation,
    rank,
    queueWhy,
    waitWhy,
    groupMerge,
    onGroupMerge,
    queued,
    batchMark,
    card: cardProp,
}: {
    // The state the list computed for the card's section (#1061).
    card?: CardState;
    pr: ReviewPr;
    selected: boolean;
    marked: boolean;
    onSelect: () => void;
    onOpen: () => void;
    onValidate: () => void;
    onAskRebase: () => Promise<RebaseOutcome>;
    onInvestigate?: () => Promise<RebaseOutcome>;
    rebaseAsk: RebaseAsk;
    dir: string;
    repo: string;
    // The card's conflicts with the other cards (#1062, FR-REV-023): its facts line, and its part while a card is
    // hovered or focused.
    relation?: CardRelation;
    // Its place in the merge queue (#1062, FR-REV-024): rank, and the words in the order's direction.
    rank?: number;
    queueWhy?: Phrase;
    // Why it waits instead of being ranked (#1211): one line under its state.
    waitWhy?: Phrase;
    // Its place in the group merge (#1108): in it, taken out, or no step; the "…" menu changes it.
    groupMerge?: "in" | "out" | null;
    onGroupMerge?: (inGroup: boolean) => void;
    // A task waiting for its busy agent (FR-REV-022 AC12).
    queued?: QueuedAsk;
    // batchMark: its place in the merge queue's run.
    batchMark?: BatchRowMark;
}) {
    const t = useT();
    useLocale();
    const word = useWordPhrase();
    const ctx = useCardContext(dir);
    const input = useMemo(() => cardInputOf(pr, rebaseAsk, ctx), [pr, rebaseAsk, ctx]);
    const prTask = input.task;
    useHeadStillFails(dir, pr, input.agents, input.taskState);
    const markReady = useMarkReady(dir, pr.number, repo);
    const rerun = useRerunFailed(dir, pr.number);
    const [busy, setBusy] = useState<string>(null);
    const [outcome, setOutcome] = useState<RebaseOutcome>(null);
    // The task the outcome answers, for the offer to queue it for a busy agent (#1062).
    const [outcomeTask, setOutcomeTask] = useState<PrTaskKind>(null);
    const [error, setError] = useState<Phrase>(null);
    const [confirm, setConfirm] = useState<CardConfirm>(null);
    const [lastHead, setLastHead] = useState(pr.headoid);
    if (lastHead !== pr.headoid) {
        setLastHead(pr.headoid);
        setOutcome(null);
    }
    useEscape(confirm != null, () => setConfirm(null));
    // The list passes the state it sorted the card by; alone (tests), the card computes the same.
    const card: CardState = cardProp ?? cardState(input);
    const head = reviewHeadline(pr);
    const outcomeShown = outcome != null && (outcome.kind !== "asked" || outcome.note);
    const ask = (id: string, kind: PrTaskKind, fn: () => Promise<RebaseOutcome>) => {
        if (busy != null) {
            return;
        }
        setBusy(id);
        setOutcome(null);
        setOutcomeTask(kind);
        fireAndForget(async () => {
            try {
                setOutcome(await fn());
            } finally {
                setBusy(null);
            }
        });
    };
    const runPhrase = (id: string, fn: () => Promise<Phrase>) => {
        if (busy != null) {
            return;
        }
        setBusy(id);
        setError(null);
        fireAndForget(async () => {
            try {
                setError(await fn());
            } finally {
                setBusy(null);
            }
        });
    };
    const model = ReviewsModel.getInstance();
    const run = (action: CardAction, confirmed = false) => {
        if (action.disabled != null) {
            return;
        }
        if (action.confirm != null && !confirmed && action.id !== "mark-ready") {
            setConfirm({ action, text: action.confirm });
            return;
        }
        setConfirm(null);
        switch (action.id) {
            case "answer":
            case "follow":
                fireAndForget(() => showPanel(action.blockId));
                return;
            case "relaunch":
            case "start-agent":
                ask(action.id, rebaseAsk != null ? (rebaseAsk.kind ?? "rebase") : "finish", () =>
                    rebaseAsk != null
                        ? model.retryTask(dir, pr, repo, rebaseAsk.kind ?? "rebase")
                        : model.askFinish(dir, pr, repo)
                );
                return;
            case "resume":
                ask(action.id, "finish", () => model.askFinish(dir, pr, repo, true));
                return;
            case "rebase":
                ask(action.id, "rebase", onAskRebase);
                return;
            case "investigate":
                if (onInvestigate != null) {
                    ask(action.id, "investigate", onInvestigate);
                }
                return;
            case "assisted-review":
                fireAndForget(() => model.openAssistedReview(dir, pr, repo));
                return;
            case "mark-ready":
                markReady.ask();
                return;
            case "validate":
                onValidate();
                return;
            case "open-work":
                runPhrase(action.id, () => model.openAgentWork(dir, pr, repo, action.blockId));
                return;
            case "stop":
                if (!confirmed) {
                    setConfirm({
                        action,
                        text: phrase("reviewsAgents.stop.confirm", { name: card.agent?.name || prTask?.name || "" }),
                    });
                    return;
                }
                runPhrase(action.id, () => model.stopAgent(action.blockId));
                return;
            case "rerun":
                rerun.ask();
                return;
            case "launch":
                LaunchModel.getInstance().ask(dir, launchTargetOfPr(pr));
                return;
            case "github":
                fireAndForget(() => openWebLink(pr.url));
                return;
        }
    };
    const group = onGroupMerge != null ? groupMergeAction(groupMerge) : null;
    const groupItem: ContextMenuItem =
        group == null ? null : { label: t(group.labelKey), click: () => onGroupMerge(group.inGroup) };
    const openMenu = (e: React.MouseEvent) => {
        e.stopPropagation();
        const items: ContextMenuItem[] = [];
        for (const action of card.menu) {
            if (action.id === "github" && items.length > 0) {
                if (groupItem != null) {
                    items.push(groupItem);
                }
                items.push({ type: "separator" });
            }
            items.push({
                label: word(action.label),
                sublabel:
                    action.disabled != null
                        ? word(action.disabled)
                        : action.confirm != null
                          ? word(action.confirm)
                          : undefined,
                enabled: action.disabled == null,
                click: () => run(action),
            });
        }
        if (groupItem != null && !items.includes(groupItem)) {
            items.push(groupItem);
        }
        // Under the button, whether it was clicked or pressed from the keyboard (a key's click has no pointer place).
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
    };
    const markReadyNotes =
        card.primary?.id === "mark-ready"
            ? word(card.primary.confirm)
            : word(card.menu.find((a) => a.id === "mark-ready")?.confirm);
    const sentence = word(card.sentence);
    // A queued card says its place in the order where its own state gives no reason, or only the CI's.
    const queueSays = queueWhy != null && (card.why == null || card.kind === "ready" || card.kind === "ci-running");
    const why = word(queueSays ? queueWhy : card.why);
    const wait = word(waitWhy);
    const primary = card.primary;
    // Every Validate looks the same (developer decision 2026-10-25, #1108): the suggested order is a proposal for the
    // group merge, never a constraint on which PR to validate first.
    const molten = card.molten;
    const relationFact = word(relation?.fact);
    const relationTag = word(relation?.tag);
    const primaryName =
        card.agent != null
            ? phrase("reviews.card.name", { name: card.agent.name || card.agent.parentName || "" })
            : phrase("reviews.card.name", { name: prTask?.name || "" });
    const primaryTitle =
        primary == null
            ? ""
            : primary.disabled != null
              ? word(primary.disabled)
              : word(actionTitle(primary, pr, primaryName));
    const primaryBusy =
        primary != null && (busy === primary.id || (primary.id === "mark-ready" && markReady.phase === "sending"));
    // A card that asks nothing says where taking it over lives (#1085): the menu, Mark ready first.
    const moreTitle =
        primary == null && card.menu.some((a) => a.id === "mark-ready")
            ? t("reviews.card.moreTakeOver")
            : t("reviews.card.more");
    const facts: CardFact[] = card.facts;
    return (
        <div
            role="listitem"
            tabIndex={0}
            data-pr={pr.number}
            data-state={card.kind}
            data-tone={card.tone}
            data-turn={card.turn}
            data-works={card.motion || undefined}
            aria-label={[
                rank != null ? t("reviews.order.rankTitle", { rank }) : "",
                head.ticket ? t("reviews.aria.ticket", { ticket: head.ticket, title: head.title }) : head.title,
                t("reviews.aria.pr", { number: pr.number }),
                pr.draft ? t("reviews.card.draftTag") : "",
                why ? `${sentence} · ${why}` : sentence,
                ...facts.map((f) => word(f.text)),
                relationFact,
                relationTag,
            ]
                .filter(Boolean)
                .join(", ")}
            aria-current={selected || undefined}
            onClick={() => {
                onSelect();
                onOpen();
            }}
            onFocus={onSelect}
            className={cn(
                "group relative flex cursor-pointer flex-col gap-1 border-b border-border py-2.5 pr-3 pl-[15px] outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover",
                selected && "bg-hover/60",
                marked && "ring-2 ring-accent/70 ring-inset",
                relationClass(relation?.role)
            )}
            data-relation={relation?.role || undefined}
        >
            <span
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ background: RailColours[card.tone] }}
                aria-hidden
                data-testid="reviews-card-rail"
            />
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-1.5 text-13 leading-5 font-medium">
                        <MergeOrderRank rank={rank} />
                        {/* One number per card (#1108): the ticket, else the PR's; the PR's chip beside a ticket. */}
                        <span className="shrink-0 text-accent" data-testid="reviews-card-number">
                            {head.ticket || `#${pr.number}`}
                        </span>
                        <span
                            className="min-w-0 truncate"
                            title={t("reviews.card.prChipTitle", { number: pr.number, branch: pr.branch })}
                        >
                            {head.title}
                        </span>
                        {head.ticket ? (
                            <span
                                className="shrink-0 rounded-2 border border-border px-1 text-10 leading-[14px] font-normal text-muted tabular-nums"
                                title={t("reviews.card.prChipTitle", { number: pr.number, branch: pr.branch })}
                                data-testid="reviews-card-pr"
                            >
                                {t("reviews.card.prChip", { number: pr.number })}
                            </span>
                        ) : null}
                        {pr.draft ? (
                            <span
                                className="shrink-0 rounded-2 border border-border px-1 text-10 leading-[14px] font-semibold tracking-[0.06em] text-muted uppercase"
                                title={t("reviews.card.draftTagTitle")}
                                data-testid="reviews-draft-tag"
                            >
                                {t("reviews.card.draftTag")}
                            </span>
                        ) : null}
                        {relationTag ? (
                            <span
                                className="inline-flex shrink-0 items-center gap-1 rounded-4 border border-[color-mix(in_srgb,var(--mt-state-waiting)_45%,transparent)] px-1.5 text-11 leading-4 font-normal whitespace-nowrap text-[var(--mt-state-waiting)]"
                                data-testid="reviews-conflict-tag"
                            >
                                {relationTag}
                            </span>
                        ) : null}
                    </div>
                    <CardStateLine tone={card.tone} sentence={sentence} why={why} working={card.motion === "state"} />
                    {wait ? (
                        <div
                            className="flex min-w-0 items-center gap-1.5 text-11 leading-4 text-secondary"
                            data-testid="reviews-card-wait"
                        >
                            <i className="fa fa-solid fa-hourglass-half text-10 text-muted" aria-hidden />
                            <span className="min-w-0 truncate" title={wait}>
                                {wait}
                            </span>
                        </div>
                    ) : null}
                    <div
                        className="relative flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1 text-11 leading-4"
                        data-testid="reviews-card-facts"
                    >
                        {facts.map((f) => (
                            <CardFactView key={f.id} fact={f} pr={pr} />
                        ))}
                        {relationFact ? (
                            <span
                                className="inline-flex min-w-0 items-center gap-1 text-[var(--mt-state-waiting)]"
                                data-testid="reviews-fact-conflicts-with"
                            >
                                <i className="fa fa-solid fa-code-merge text-10" aria-hidden />
                                <span className="min-w-0 truncate" title={relationFact}>
                                    {relationFact}
                                </span>
                            </span>
                        ) : null}
                        <BatchRowChip mark={batchMark} />
                        <LaunchCardActions dir={dir} target={launchTargetOfPr(pr)} runningOnly />
                    </div>
                    {card.history ? (
                        <div className="text-11 leading-4 text-muted" data-testid="reviews-card-history">
                            {word(card.history)}
                        </div>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {primary != null ? (
                        <CardPrimaryButton
                            primary={primary}
                            molten={molten}
                            title={primaryTitle}
                            busy={primaryBusy}
                            onRun={() => run(primary)}
                        />
                    ) : null}
                    <button
                        type="button"
                        onClick={openMenu}
                        onKeyDown={stopRow}
                        aria-haspopup="menu"
                        aria-label={t("reviews.card.moreTitle", { number: pr.number })}
                        title={moreTitle}
                        className={MoreButton}
                        data-testid="reviews-card-more"
                    >
                        <i className="fa fa-solid fa-ellipsis text-12" aria-hidden />
                    </button>
                </div>
            </div>
            <MarkReadyConfirm state={markReady} notes={markReadyNotes} />
            <RerunConfirm pr={pr} state={rerun} />
            {confirm != null ? (
                <div
                    className="flex flex-wrap items-center gap-2 text-12 leading-4 text-secondary"
                    role="status"
                    onClick={stopRow}
                    onKeyDown={stopRow}
                    data-testid="reviews-card-confirm"
                >
                    <span className="min-w-0 flex-1">{word(confirm.text)}</span>
                    <button
                        type="button"
                        onClick={() => run(confirm.action, true)}
                        className={cn(
                            "molten-btn flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 px-2.5 py-1 text-12",
                            confirm.action.id === "stop" && "molten-btn-destructive"
                        )}
                        data-testid="reviews-card-confirm-yes"
                    >
                        {confirm.action.id === "stop"
                            ? t("reviewsAgents.stop.button")
                            : t("reviews.card.confirm.validateAnyway")}
                        <MoltenWave />
                    </button>
                    <button type="button" onClick={() => setConfirm(null)} className={ConfirmButton}>
                        {t("common.cancel")}
                    </button>
                </div>
            ) : null}
            {outcomeShown ? (
                <div
                    className={cn(
                        "flex flex-wrap items-center gap-2 text-12 leading-4",
                        outcome.kind === "failed" ? "text-danger" : "text-secondary"
                    )}
                    role="status"
                    data-testid="reviews-rebase-outcome"
                >
                    <span className="min-w-0">{word(outcome.text)}</span>
                    {outcome.busy != null && outcomeTask != null && queued == null ? (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                model.queueAsk(
                                    dir,
                                    pr,
                                    repo,
                                    outcomeTask,
                                    outcome.busy,
                                    undefined,
                                    outcomeTask === "finish" && input.agentReadies
                                );
                                setOutcome(null);
                            }}
                            onKeyDown={stopRow}
                            className={ConfirmButton}
                            data-testid="reviews-queue-ask"
                        >
                            {t(outcomeTask === "rebase" ? "reviews.queue.ask.rebase" : "reviews.queue.ask.other", {
                                name: outcome.busy.name,
                            })}
                        </button>
                    ) : null}
                </div>
            ) : null}
            <QueuedAskLine ask={queued} />
            {error != null ? (
                <div className="text-12 leading-4 text-danger" role="status" data-testid="reviews-card-error">
                    {word(error)}
                </div>
            ) : null}
            {/* Last: the agent lines dock at the card's bottom edge (-mb-2.5), anything after them lands below. */}
            <RowAgentLine
                dir={dir}
                pr={pr}
                task={rebaseAsk}
                hideGone
                onOpenWork={(blockId) => model.openAgentWork(dir, pr, repo, blockId)}
                onStop={(blockId) => model.stopAgent(blockId)}
            />
        </div>
    );
}

// The card's state line: its dot (or the dominoes while something works, #1085), its sentence and its reason. A
// Leftovers card whose owner was asked draws the same (#1143).
export function CardStateLine({
    tone,
    sentence,
    why,
    working,
}: {
    tone: CardTone;
    sentence: string;
    why: string;
    working: boolean;
}) {
    return (
        <div
            className={cn("flex min-w-0 items-baseline gap-1.5 text-12 leading-4 font-medium", SentenceClasses[tone])}
            data-testid="reviews-card-state"
        >
            {/* Something works and nothing is the developer's (#1085): the dominoes, unless an agent line of the card
                already shows them. */}
            {working ? (
                <span className="-mx-1 inline-flex shrink-0 scale-75 self-center" data-testid="reviews-card-working">
                    <DominoLoader />
                </span>
            ) : (
                <span
                    className="h-[7px] w-[7px] shrink-0 -translate-y-px self-center rounded-full"
                    style={{ background: RailColours[tone] }}
                    aria-hidden
                    data-testid="reviews-card-dot"
                />
            )}
            <span className="min-w-0 truncate" title={why ? `${sentence} · ${why}` : sentence}>
                {sentence}
                {why ? <span className="font-normal text-secondary"> · {why}</span> : null}
            </span>
        </div>
    );
}

// The card's one primary action: molten when it is the developer's move now, calm otherwise, the calm look with its
// reason when refused. A Leftovers card whose owner was asked uses the same button (#1143): Answer {name}, Follow {name}.
export function CardPrimaryButton({
    primary,
    molten,
    title,
    busy,
    onRun,
}: {
    primary: CardAction;
    molten: boolean;
    title: string;
    busy: boolean;
    onRun: () => void;
}) {
    const word = useWordPhrase();
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onRun();
            }}
            onKeyDown={stopRow}
            aria-disabled={primary.disabled != null ? true : undefined}
            aria-busy={busy || undefined}
            className={primary.disabled != null ? DisabledButton : molten ? MoltenButton : CalmButton}
            title={title || undefined}
            data-testid="reviews-card-primary"
            data-action={primary.id}
            data-molten={molten || undefined}
        >
            {busy ? <DominoLoader /> : null}
            {word(primary.label)}
            {molten && primary.disabled == null ? <MoltenWave /> : null}
        </button>
    );
}

// What an agent action's button names on hover (Answer, Follow), as the PR card says it.
export function agentActionTitle(action: CardAction, name: Phrase): Phrase {
    if (action.id !== "answer" && action.id !== "follow") {
        return null;
    }
    return phrase(`reviews.card.actionTitle.${action.id}`, { name });
}

// One fact; the test report opens where it was posted.
function CardFactView({ fact, pr }: { fact: CardFact; pr: ReviewPr }) {
    const word = useWordPhrase();
    const text = word(fact.text);
    const mark =
        fact.tone === "ok" ? (
            <i className="text-success not-italic" aria-hidden>
                ✓
            </i>
        ) : fact.tone === "running" ? (
            <i className="fa fa-regular fa-clock text-10" aria-hidden data-testid="reviews-fact-running-mark" />
        ) : null;
    if (fact.id === "report" && pr.report?.state === "present" && pr.report.url) {
        return (
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    fireAndForget(() => openWebLink(pr.report.url));
                }}
                onKeyDown={stopRow}
                className={cn(
                    "inline-flex cursor-pointer items-center gap-1 whitespace-nowrap hover:text-primary hover:underline",
                    FactClasses[fact.tone]
                )}
                data-testid="reviews-fact-report"
            >
                {mark}
                {text}
            </button>
        );
    }
    return (
        <span
            className={cn("inline-flex items-center gap-1 whitespace-nowrap", FactClasses[fact.tone])}
            data-testid={`reviews-fact-${fact.id}`}
        >
            {mark}
            {text}
        </span>
    );
}
