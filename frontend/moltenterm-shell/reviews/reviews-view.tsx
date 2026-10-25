// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view (FR-REV-001, DS-REV-012): the pull requests of the workspace's project waiting for the developer's
// review, each with its ticket, CI, test report and merge state, read through the developer's gh by Mission Control's
// collector. Each card shows one computed state (#1060, reviews-card.tsx), and the cards are grouped by whose turn it
// is (#1061): Yours, Agents on it, Blocked, Waiting, then Upcoming, Notes and Recently merged; the header's control
// sorts them by state or by merge order. The numbered merge queue and the status line after a merge sit at the top of
// Yours (#1062), and a hovered or focused card lights up the cards it conflicts with. Cards move instead of jumping
// when they arrive, leave, reorder or change section (#1063, reviews-motion.tsx). A card opens the PR's assisted review; the keyboard walks the cards of the
// open sections (arrows, Home, End) and Enter opens one.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../empty-state";
import { I18nModel, t as translate, useLocale, useT } from "../i18n/i18n";
import { errorPhrase, Phrase, useWordPhrase } from "../i18n/phrase";
import { ActiveProject, MissionFrame, MissionHeader } from "../mission/mission-frame";
import { MissionSnapshot } from "../mission/mission-model";
import type { ReviewMergeMethod } from "../review/review-client";
import { ValidateSheet } from "../review/review-validate";
import { useCardContext } from "./reviews-agent-bar";
import { ReviewsAskQueue } from "./reviews-ask-queue";
import { BatchBanner, BatchConfirmDialog } from "./reviews-batch";
import { BatchRuns, useBatchRun } from "./reviews-batch-client";
import {
    batchItemEnded,
    batchPlan,
    batchRowMark,
    batchShown,
    batchStartRequest,
    queueItem,
    queueOrder,
} from "./reviews-batch-model";
import { ReviewRow } from "./reviews-card";
import type { CardTurn } from "./reviews-card-model";
import { CheckAgentsButton, CheckAgentsReport, useCheckAgents } from "./reviews-check";
import { useReviews } from "./reviews-client";
import { EdgeWhere, ForecastLinks } from "./reviews-forecast";
import { useForecastAnswer, useForecastWatch } from "./reviews-forecast-client";
import { forecastRequestOf, forecastStatus } from "./reviews-forecast-model";
import { LaunchBar, LaunchDialogs } from "./reviews-launch";
import { MergedSection } from "./reviews-merged";
import {
    MoltentermReviewsView,
    nextRow,
    rebaseAskKey,
    ReviewPr,
    ReviewsAnswer,
    reviewsEmptyState,
    reviewsRetryIsPrimary,
    splitReviews,
} from "./reviews-model";
import { CardMotion } from "./reviews-motion";
import { NotesAsk, NotesSection } from "./reviews-notes-view";
import { SortControl, useReviewsSort } from "./reviews-order";
import { ReviewsFolds, sectionOpen } from "./reviews-order-store";
import { AfterMergeLine, MergeQueueBlock } from "./reviews-queue";
import {
    cardRelations,
    edgeLine,
    mergeQueue,
    queueRanks,
    queueShown,
    queueWhy,
    withMerged,
} from "./reviews-queue-model";
import { SectionHeading } from "./reviews-section-heading";
import { cardStates, sectionOf, sectionRows, sectionsByTurn } from "./reviews-sections-model";
import { ReviewsModel } from "./reviews-store";
import { UpcomingSection } from "./reviews-upcoming";

export { MoltentermReviewsView, ReviewRow };

// How long a PR another surface asked for stays marked.
const FocusMarkMs = 4000;
const RowKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

export class ReviewsViewModel implements ViewModel {
    viewType = MoltentermReviewsView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("code-pull-request");
    viewName = atom((get) => {
        get(I18nModel.getInstance().localeAtom);
        return translate("reviews.viewName");
    });
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return ReviewsView;
    }
}

function ReviewsView({ model }: ViewComponentProps<ReviewsViewModel>) {
    const t = useT();
    return (
        <>
            <MissionFrame title={t("reviews.viewName")}>
                {({ project, snapshot }) => (
                    <ReviewsContent project={project} snapshot={snapshot} blockId={model.blockId} />
                )}
            </MissionFrame>
            <RowValidateSheet blockId={model.blockId} />
        </>
    );
}

// A row's Validate sheet (#707), over this tab: no Review tab is opened for it.
function RowValidateSheet({ blockId }: { blockId: string }) {
    const sheet = useAtomValue(ReviewsModel.getInstance().validateSheetAtom);
    if (sheet == null || (sheet.blockId && sheet.blockId !== blockId)) {
        return null;
    }
    return <ValidateSheet model={sheet.model} />;
}

function ReviewsContent({
    project,
    snapshot,
    blockId,
}: {
    project: ActiveProject;
    snapshot: MissionSnapshot;
    blockId: string;
}) {
    const t = useT();
    const { answer, error, refresh } = useReviews(project.dir, snapshot);
    const sort = useReviewsSort();
    const headerSnapshot = useMemo(
        () => (snapshot == null ? null : { ...snapshot, refreshing: snapshot.refreshing || answer?.refreshing }),
        [snapshot, answer?.refreshing]
    );
    return (
        <>
            <MissionHeader project={project} snapshot={headerSnapshot} onRefresh={refresh}>
                {answer?.target ? (
                    <span
                        className="text-11 text-muted"
                        title={t("reviews.intoTitle", { target: answer.target, from: answer.targetfrom })}
                    >
                        {t("reviews.into")} <code>{answer.target}</code>
                    </span>
                ) : null}
                {answer?.state === "ok" ? <SortControl sort={sort} /> : null}
            </MissionHeader>
            <ReviewsBody dir={project.dir} answer={answer} error={error} refresh={refresh} blockId={blockId} />
        </>
    );
}

function ReviewsBody({
    dir,
    answer,
    error,
    refresh,
    blockId,
}: {
    dir: string;
    answer: ReviewsAnswer;
    error: string;
    refresh: () => void;
    blockId: string;
}) {
    const t = useT();
    if (answer == null && error) {
        return (
            <EmptyState
                icon="triangle-exclamation"
                title={t("reviews.failedTitle")}
                hint={t("reviews.failedHint")}
                primary={{ label: t("reviews.tryAgain"), onClick: refresh }}
                details={error}
            />
        );
    }
    if (answer == null || !answer.state) {
        return <Loading />;
    }
    const empty = reviewsEmptyState(answer);
    if (empty != null) {
        const retry = { label: t("reviews.tryAgain"), onClick: refresh };
        const retryPrimary = reviewsRetryIsPrimary(answer);
        return (
            <EmptyState
                icon={empty.icon}
                title={empty.title}
                hint={empty.hint}
                primary={retryPrimary ? retry : undefined}
                secondary={retryPrimary ? undefined : retry}
                details={empty.details}
                testId={`reviews-empty-${answer.state}`}
            />
        );
    }
    return <ReviewsList dir={dir} answer={answer} blockId={blockId} />;
}

function Loading() {
    return (
        <div className="flex flex-col gap-3 p-3" aria-busy="true" data-testid="reviews-loading">
            {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-1.5">
                    <div className="h-4 w-3/4 mt-step-blink rounded-4 bg-hover" />
                    <div className="h-3 w-1/2 mt-step-blink rounded-4 bg-hover" />
                </div>
            ))}
        </div>
    );
}

// The sections by turn (#1061): each section's title key, hint key and test id.
const TurnSectionText: Record<CardTurn, { title: string; hint?: string }> = {
    yours: { title: "reviews.sections.yours", hint: "reviews.sections.yoursHint" },
    agents: { title: "reviews.sections.agents" },
    blocked: { title: "reviews.sections.blocked" },
    waiting: { title: "reviews.sections.waiting", hint: "reviews.sections.waitingHint" },
};

function ReviewsList({ dir, answer, blockId }: { dir: string; answer: ReviewsAnswer; blockId: string }) {
    const t = useT();
    const word = useWordPhrase();
    const model = ReviewsModel.getInstance();
    const focus = useAtomValue(model.focusAtom);
    const asks = useAtomValue(model.rebaseAsksAtom);
    const readied = useAtomValue(model.readiedAtom);
    const afterMerges = useAtomValue(model.afterMergeAtom);
    const queuedAsks = useAtomValue(ReviewsAskQueue.getInstance().asksAtom);
    const folds = useAtomValue(ReviewsFolds.getInstance().foldsAtom);
    const [selected, setSelected] = useState<number>(null);
    const [marked, setMarked] = useState<number>(null);
    const [hovered, setHovered] = useState<number>(null);
    const [notesAsk, setNotesAsk] = useState<NotesAsk>(null);
    const [handing, setHanding] = useState(false);
    // Whether the panel's content is longer than the panel, read once on the first render: the bottom sections then
    // start folded (FR-REV-001 AC12).
    const [long, setLong] = useState<boolean>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const listSplit = useMemo(() => splitReviews(answer, readied), [answer, readied]);
    const listed = useMemo(() => [...listSplit.ready, ...listSplit.drafts], [listSplit]);
    const mergedNumbers = useMemo(() => (answer.merged ?? []).map((pr) => pr.number), [answer.merged]);
    // The conflict forecast (FR-REV-023), asked for the PRs listed.
    const forecastReq = useMemo(() => forecastRequestOf(answer, listSplit), [answer, listSplit]);
    useForecastWatch(dir, forecastReq);
    const forecast = useForecastAnswer(dir);
    const locale = useLocale();
    const sort = useReviewsSort();
    // The merge queue (#1062, FR-REV-024): the suggested order of the PRs that can merge or wait for their CI.
    const baseQueue = useMemo(() => mergeQueue(forecast, listSplit.ready, listed), [forecast, listSplit, listed]);
    const afterMerge = afterMerges[dir];
    const queue = useMemo(
        () =>
            withMerged(
                baseQueue,
                afterMerge != null && afterMerge.read === (answer.githubat ?? 0) ? afterMerge.merged : []
            ),
        [baseQueue, afterMerge, answer.githubat]
    );
    const shown = forecastReq != null && queueShown(queue);
    const ranks = useMemo(() => (shown ? queueRanks(queue) : {}), [queue, shown]);
    // Only the first step that can merge keeps an orange Validate.
    const firstStep = shown ? queue.steps.find((s) => !s.merged && !s.wait)?.number : null;
    // Each card's one state (#1060), computed here once so its section and the card itself agree.
    const ctx = useCardContext(dir);
    const cards = useMemo(() => cardStates(listed, asks, (n) => rebaseAskKey(dir, n), ctx), [listed, asks, dir, ctx]);
    const sections = useMemo(() => sectionsByTurn(listed, cards, sort, ranks), [listed, cards, sort, ranks]);
    const turnOpen = (turn: CardTurn) => sectionOpen(folds, dir, turn, true);
    const foldedTurns: Partial<Record<CardTurn, boolean>> = {};
    for (const s of sections) {
        foldedTurns[s.turn] = !turnOpen(s.turn);
    }
    const rows = sectionRows(sections, foldedTurns);
    // The cards' places for their motion (#1063), folded sections included: folding never animates.
    const motionLayout = useMemo(
        () => sections.flatMap((s) => s.prs.map((pr) => ({ number: pr.number, section: s.turn }))),
        [sections]
    );
    // The conflicts as relations (FR-REV-023): the hovered card, else the focused (selected) one.
    const active = hovered ?? selected;
    const relations = useMemo(() => cardRelations(forecast, listed, active), [forecast, listed, active, locale]);
    const hot =
        active == null || relations.partners.length === 0 ? [] : [active, ...relations.partners.map((p) => p.number)];
    const status = forecastStatus(forecast, forecastReq);
    // The batch merge (FR-REV-025): the queue's steps in its order, the confirmation modal, and the merge queue they
    // join (FR-REV-026), which wavesrv publishes.
    const batchRun = useBatchRun(dir, answer.target);
    const [confirming, setConfirming] = useState(false);
    const queuePrs = useMemo(() => {
        const numbers = new Set(queue.steps.filter((s) => !s.merged).map((s) => s.number));
        return listSplit.ready.filter((pr) => numbers.has(pr.number));
    }, [queue, listSplit]);
    const plannedBatch = useMemo(
        () => (confirming ? batchPlan(forecast, queuePrs, listed, answer.target) : null),
        [confirming, forecast, queuePrs, listed, answer.target, locale]
    );
    const takenByQueue = (n: number) => {
        const item = queueItem(batchRun, n);
        return item != null && !batchItemEnded(item);
    };
    const canMerge = queuePrs.some((pr) => !takenByQueue(pr.number));
    const check = useCheckAgents(dir, answer.repo, listed);
    const startBatch = async (method: ReviewMergeMethod): Promise<Phrase> => {
        const workspaceId = globalStore.get(atoms.workspace)?.oid;
        try {
            const order = queueOrder(
                forecast,
                listed,
                batchRun,
                plannedBatch.steps.map((s) => s.pr.number)
            );
            await BatchRuns.getInstance().add(
                batchStartRequest(dir, answer.repo, answer.target, plannedBatch, method, workspaceId, order)
            );
        } catch (e) {
            return errorPhrase(e);
        }
        setConfirming(false);
        return null;
    };
    useEffect(() => {
        model.noteQueueRead(dir, answer, listed, baseQueue, forecast, takenByQueue);
    }, [dir, answer, listed, baseQueue, forecast]);
    useEffect(() => {
        ReviewsAskQueue.getInstance().refresh(dir, listed);
    }, [dir, listed]);
    useLayoutEffect(() => {
        const el = listRef.current;
        if (long != null || el == null) {
            return;
        }
        setLong(el.scrollHeight > el.clientHeight + 1);
    }, [long]);
    useEffect(() => {
        if (focus == null || focus.dir !== dir) {
            return;
        }
        const turn = sectionOf(sections, focus.number);
        if (turn == null) {
            return;
        }
        globalStore.set(model.focusAtom, null);
        if (!turnOpen(turn)) {
            ReviewsFolds.getInstance().set(dir, turn, true);
        }
        setSelected(focus.number);
        setMarked(focus.number);
    }, [focus, dir, sections, model]);
    // Its own effect: clearing the focus above re-runs that one, whose cleanup would cancel the timer (#962).
    useEffect(() => {
        if (marked == null) {
            return;
        }
        const timer = setTimeout(() => setMarked(null), FocusMarkMs);
        return () => clearTimeout(timer);
    }, [marked]);
    useEffect(() => {
        if (selected == null) {
            return;
        }
        listRef.current?.querySelector<HTMLElement>(`[data-pr="${selected}"]`)?.scrollIntoView?.({ block: "nearest" });
    }, [selected, folds]);
    useEffect(() => {
        if (notesAsk != null) {
            ReviewsFolds.getInstance().set(dir, "notes", true);
        }
    }, [notesAsk, dir]);
    const openReview = (pr: ReviewPr) => fireAndForget(() => model.openPullRequestReview(dir, pr, answer.repo));
    // A queue step brings its card into view, unfolding its section, and focuses it.
    const goToCard = (number: number) => {
        const turn = sectionOf(sections, number);
        if (turn != null && !turnOpen(turn)) {
            ReviewsFolds.getInstance().set(dir, turn, true);
        }
        setSelected(number);
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-pr="${number}"]`)?.focus());
    };
    const handOver = () => {
        if (handing) {
            return;
        }
        setHanding(true);
        fireAndForget(async () => {
            try {
                await model.handOverAfterMerge(dir, answer.repo, listed);
            } finally {
                setHanding(false);
            }
        });
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        // A dialog the list renders (the batch merge's modal) is portaled out of it: its keys are not the rows'.
        if (!listRef.current?.contains(e.target as Node)) {
            return;
        }
        // The focused row wins over the state: focus moves before React renders the selection it sets.
        const focused = Number((e.target as HTMLElement).closest?.("[data-pr]")?.getAttribute("data-pr"));
        const current = focused || selected;
        if (RowKeys.has(e.key)) {
            e.preventDefault();
            const next = nextRow(rows, current, e.key);
            setSelected(next);
            listRef.current?.querySelector<HTMLElement>(`[data-pr="${next}"]`)?.focus();
            return;
        }
        if (e.key === "Enter") {
            const pr = rows.find((r) => r.number === current);
            if (pr != null) {
                e.preventDefault();
                openReview(pr);
            }
        }
    };
    const rowProps = (pr: ReviewPr) => ({
        pr,
        card: cards[pr.number],
        selected: selected === pr.number,
        marked: marked === pr.number,
        onSelect: () => setSelected(pr.number),
        onOpen: () => openReview(pr),
        onValidate: () => model.openValidate(dir, pr, answer.repo, blockId),
        onAskRebase: () => model.askRebase(dir, pr, answer.repo),
        onInvestigate: () => model.investigate(dir, pr, answer.repo),
        rebaseAsk: asks[rebaseAskKey(dir, pr.number)],
        dir,
        repo: answer.repo,
        relation: relations.cards[pr.number],
        rank: ranks[pr.number],
        queueWhy: shown ? queueWhy(queue, pr.number, relations.byCard[pr.number]) : null,
        calm: ranks[pr.number] != null && pr.number !== firstStep,
        queued: queuedAsks[rebaseAskKey(dir, pr.number)],
        batchMark: batchRowMark(batchRun, pr.number),
    });
    const edgeText = (number: number, where: EdgeWhere) =>
        word(
            edgeLine(
                relations.partners.find((p) => p.number === number),
                where
            )
        );
    // Read from the row under the pointer, not from each row's enter and leave: a scroll under a still pointer
    // changes the row without a leave.
    const onPointerOver = (e: React.MouseEvent) => {
        const row = (e.target as HTMLElement).closest?.("[data-pr]");
        setHovered(row == null ? null : Number(row.getAttribute("data-pr")));
    };
    // Check the agents sits on the heading of the agents' section, else of the first PR section shown.
    const checkTurn = sections.some((s) => s.turn === "agents") ? "agents" : sections[0]?.turn;
    // The queue, its banner and the after-merge line sit at the top of "Yours", else above the sections.
    const queueTurn: CardTurn = sections[0]?.turn === "yours" ? "yours" : null;
    const queueBlock = (
        <>
            <AfterMergeLine
                after={afterMerge}
                busy={handing}
                onHandOver={handOver}
                onClose={() => model.closeAfterMerge(dir)}
            />
            {batchShown(batchRun) ? <BatchBanner run={batchRun} /> : null}
            {shown ? (
                <MergeQueueBlock
                    queue={queue}
                    prs={listed}
                    base={answer.target}
                    status={status}
                    hot={hot}
                    canMerge={canMerge}
                    onStep={goToCard}
                    onMerge={() => setConfirming(true)}
                />
            ) : null}
            {confirming && plannedBatch != null ? (
                <BatchConfirmDialog
                    plan={plannedBatch}
                    dir={dir}
                    repo={answer.repo}
                    base={answer.target}
                    onStart={startBatch}
                    onCancel={() => setConfirming(false)}
                />
            ) : null}
        </>
    );
    const bottomOpen = long !== true;
    const motionAround = [
        afterMerge?.merged.join(" ") ?? "",
        batchShown(batchRun) ? "batch" : "",
        shown ? queue.steps.map((s) => `${s.number}${s.merged ? "m" : ""}`).join(" ") : "",
    ].join("|");
    return (
        <div
            ref={listRef}
            className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3"
            onKeyDown={onKeyDown}
            onMouseOver={onPointerOver}
            onMouseLeave={() => setHovered(null)}
            data-role="molten-reviews"
        >
            <ForecastLinks
                listRef={listRef}
                source={hot.length > 0 ? active : null}
                targets={relations.partners.map((p) => p.number)}
                edgeText={edgeText}
            />
            {answer.prserror ? <Problem text={t("reviews.prsError", { error: answer.prserror })} /> : null}
            <LaunchBar dir={dir} mergedNumbers={mergedNumbers} trunk={answer.target} />
            <LaunchDialogs trunk={answer.target} />
            {answer.reportserror ? (
                <div className="text-11 text-muted" title={answer.reportserror}>
                    {t("reviews.reportsError")}
                </div>
            ) : null}
            {queueTurn == null ? queueBlock : null}
            {sections.length === 0 ? (
                <p
                    className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted"
                    data-testid="reviews-none-open"
                >
                    {t("reviews.sections.none")} <code>{answer.target}</code>.
                </p>
            ) : null}
            <CardMotion dir={dir} layout={motionLayout} merged={mergedNumbers} around={motionAround}>
                {sections.map((section) => {
                    const text = TurnSectionText[section.turn];
                    const isOpen = turnOpen(section.turn);
                    return (
                        <section
                            key={section.turn}
                            className="flex flex-col gap-2"
                            aria-label={t(text.title)}
                            data-testid={`reviews-section-${section.turn}`}
                        >
                            <SectionHeading
                                title={t(text.title)}
                                count={section.prs.length}
                                hint={text.hint ? t(text.hint) : undefined}
                                open={isOpen}
                                onToggle={() => ReviewsFolds.getInstance().set(dir, section.turn, !isOpen)}
                                testId={`reviews-section-${section.turn}-toggle`}
                            >
                                {section.turn === checkTurn ? <CheckAgentsButton check={check} /> : null}
                            </SectionHeading>
                            {section.turn === checkTurn ? <CheckAgentsReport check={check} /> : null}
                            {section.turn === queueTurn ? queueBlock : null}
                            {isOpen ? (
                                <div
                                    className="overflow-clip rounded-4 border border-border [overflow-clip-margin:1px]"
                                    role="list"
                                    data-testid={`reviews-section-${section.turn}-list`}
                                >
                                    {section.prs.map((pr) => (
                                        <ReviewRow key={pr.number} {...rowProps(pr)} />
                                    ))}
                                </div>
                            ) : null}
                        </section>
                    );
                })}
            </CardMotion>
            <UpcomingSection dir={dir} reviews={answer} defaultOpen={bottomOpen} />
            {answer.repo ? (
                <NotesSection dir={dir} repo={answer.repo} blockId={blockId} ask={notesAsk} defaultOpen={bottomOpen} />
            ) : null}
            {answer.repo ? (
                <MergedSection
                    answer={answer}
                    defaultOpen={bottomOpen}
                    onShowNotes={(filter) => setNotesAsk({ filter, at: Date.now() })}
                />
            ) : null}
        </div>
    );
}

function Problem({ text }: { text: string }) {
    return <div className="rounded-4 border border-error/40 bg-error/10 px-3 py-2 text-12 text-danger">{text}</div>;
}
