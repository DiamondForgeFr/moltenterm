// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view (FR-REV-001, DS-REV-012): the pull requests of the workspace's project waiting for the developer's
// review, each with its ticket, CI, test report and merge state, read through the developer's gh by Mission Control's
// collector. Drafts wait below in their own group, where they open and can be marked ready for review (#687). Each card
// shows one computed state (#1060, reviews-card.tsx); a card opens the PR's assisted review; the keyboard walks the
// rows (arrows, Home, End) and Enter opens one.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../empty-state";
import { I18nModel, t as translate, useLocale, useT } from "../i18n/i18n";
import { errorPhrase, Phrase } from "../i18n/phrase";
import { ActiveProject, MissionFrame, MissionHeader } from "../mission/mission-frame";
import { MissionSnapshot } from "../mission/mission-model";
import type { ReviewMergeMethod } from "../review/review-client";
import { ValidateSheet } from "../review/review-validate";
import { BatchBanner, BatchConfirmDialog, BatchSelectBar } from "./reviews-batch";
import { BatchRuns, useBatchRun } from "./reviews-batch-client";
import {
    batchPlan,
    batchRowMark,
    batchSelectable,
    batchShown,
    batchStartRequest,
    queueOrder,
    toggleBatchSelection,
} from "./reviews-batch-model";
import { ReviewRow } from "./reviews-card";
import { CheckAgentsBar } from "./reviews-check";
import { useReviews } from "./reviews-client";
import { ForecastLinks, ForecastStatusLine, listForecast } from "./reviews-forecast";
import { useForecastAnswer, useForecastWatch } from "./reviews-forecast-client";
import { forecastRequestOf, forecastStatus } from "./reviews-forecast-model";
import { LaunchBar, LaunchDialogs } from "./reviews-launch";
import { MergedSection } from "./reviews-merged";
import {
    MoltentermReviewsView,
    navigableRows,
    nextRow,
    rebaseAskKey,
    ReviewPr,
    ReviewsAnswer,
    reviewsEmptyState,
    reviewsRetryIsPrimary,
    splitReviews,
} from "./reviews-model";
import { NotesAsk, NotesSection } from "./reviews-notes-view";
import { MergeOrderBar, RowOrder, useMergeOrderChoice } from "./reviews-order";
import {
    mergeOrderHeader,
    mergeOrderReason,
    mergeOutsideReason,
    orderedPrs,
    suggestedMergeOrder,
} from "./reviews-order-model";
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

function ReviewsList({ dir, answer, blockId }: { dir: string; answer: ReviewsAnswer; blockId: string }) {
    const t = useT();
    const model = ReviewsModel.getInstance();
    const focus = useAtomValue(model.focusAtom);
    const asks = useAtomValue(model.rebaseAsksAtom);
    const readied = useAtomValue(model.readiedAtom);
    const [draftsOpen, setDraftsOpen] = useState(true);
    const [selected, setSelected] = useState<number>(null);
    const [marked, setMarked] = useState<number>(null);
    const [hovered, setHovered] = useState<number>(null);
    const [notesAsk, setNotesAsk] = useState<NotesAsk>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const listSplit = useMemo(() => splitReviews(answer, readied), [answer, readied]);
    const mergedNumbers = useMemo(() => (answer.merged ?? []).map((pr) => pr.number), [answer.merged]);
    // The conflict forecast (FR-REV-023): asked for the PRs listed, shown for the hovered row, else the selected one.
    const forecastReq = useMemo(() => forecastRequestOf(answer, listSplit), [answer, listSplit]);
    useForecastWatch(dir, forecastReq);
    const forecast = useForecastAnswer(dir);
    // The suggested merge order (FR-REV-024), from the same forecast; the list's own order on the developer's choice.
    const locale = useLocale();
    const orderChoice = useMergeOrderChoice();
    const suggested = orderChoice === "suggested";
    const mergeOrder = useMemo(
        () => suggestedMergeOrder(forecast, listSplit.ready, [...listSplit.ready, ...listSplit.drafts]),
        [forecast, listSplit]
    );
    const orderHeader = useMemo(() => mergeOrderHeader(mergeOrder, suggested), [mergeOrder, suggested, locale]);
    const split = useMemo(
        () => (suggested ? { ...listSplit, ready: orderedPrs(mergeOrder, listSplit.ready) } : listSplit),
        [listSplit, mergeOrder, suggested]
    );
    const rowOrders = useMemo(() => {
        const rtn: Record<number, RowOrder> = {};
        if (!suggested || !mergeOrder.usable) {
            return rtn;
        }
        for (const step of mergeOrder.steps) {
            const pr = listSplit.ready.find((p) => p.number === step.number);
            rtn[step.number] = { rank: step.rank, reason: mergeOrderReason(step, answer.target, pr) };
        }
        for (const step of mergeOrder.outside) {
            rtn[step.number] = { rank: null, reason: mergeOutsideReason(answer.target) };
        }
        return rtn;
    }, [mergeOrder, suggested, listSplit, answer.target, locale]);
    const rows = navigableRows(split, draftsOpen);
    const forecastActive = hovered ?? selected;
    const shownForecast = useMemo(
        () => listForecast(forecast, split.ready, [...split.ready, ...split.drafts], forecastActive),
        [forecast, split, forecastActive]
    );
    const status = forecastStatus(forecast, forecastReq);
    // The batch merge (FR-REV-025): the PRs selected for it, the confirmation modal, and the merge queue they join
    // (FR-REV-026), which wavesrv publishes.
    const batchRun = useBatchRun(dir, answer.target);
    const [selecting, setSelecting] = useState(false);
    const [batchSelected, setBatchSelected] = useState<number[]>([]);
    const [confirming, setConfirming] = useState(false);
    const plannedBatch = useMemo(
        () =>
            confirming
                ? batchPlan(
                      forecast,
                      listSplit.ready.filter((pr) => batchSelected.includes(pr.number)),
                      [...listSplit.ready, ...listSplit.drafts],
                      answer.target
                  )
                : null,
        [confirming, forecast, listSplit, batchSelected, answer.target, locale]
    );
    const endSelection = () => {
        setSelecting(false);
        setBatchSelected([]);
        setConfirming(false);
    };
    const startBatch = async (method: ReviewMergeMethod): Promise<Phrase> => {
        const workspaceId = globalStore.get(atoms.workspace)?.oid;
        try {
            const listed = [...listSplit.ready, ...listSplit.drafts];
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
        endSelection();
        return null;
    };
    useEffect(() => {
        if (focus == null || focus.dir !== dir) {
            return;
        }
        const isDraft = split.drafts.some((pr) => pr.number === focus.number);
        if (!isDraft && !split.ready.some((pr) => pr.number === focus.number)) {
            return;
        }
        globalStore.set(model.focusAtom, null);
        if (isDraft) {
            setDraftsOpen(true);
        }
        setSelected(focus.number);
        setMarked(focus.number);
    }, [focus, dir, split, model]);
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
    }, [selected, draftsOpen]);
    const openReview = (pr: ReviewPr) => fireAndForget(() => model.openPullRequestReview(dir, pr, answer.repo));
    // While PRs are being selected for a batch, a row's click and Enter select it instead of opening its review.
    const open = (pr: ReviewPr) => {
        if (selecting && batchSelectable(pr)) {
            setBatchSelected((current) => toggleBatchSelection(current, pr.number));
            return;
        }
        openReview(pr);
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
                open(pr);
            }
        }
    };
    const rowProps = (pr: ReviewPr) => ({
        pr,
        selected: selected === pr.number,
        marked: marked === pr.number,
        onSelect: () => setSelected(pr.number),
        onOpen: () => open(pr),
        onValidate: () => model.openValidate(dir, pr, answer.repo, blockId),
        onAskRebase: () => model.askRebase(dir, pr, answer.repo),
        onInvestigate: () => model.investigate(dir, pr, answer.repo),
        rebaseAsk: asks[rebaseAskKey(dir, pr.number)],
        dir,
        repo: answer.repo,
        forecast: shownForecast.rows[pr.number],
        forecastActive: forecastActive === pr.number,
        order: rowOrders[pr.number],
        batchCheck: selecting && batchSelectable(pr) ? batchSelected.includes(pr.number) : null,
        batchMark: batchRowMark(batchRun, pr.number),
    });
    // Read from the row under the pointer, not from each row's enter and leave: a scroll under a still pointer
    // changes the row without a leave.
    const onPointerOver = (e: React.MouseEvent) => {
        const row = (e.target as HTMLElement).closest?.("[data-pr]");
        setHovered(row == null ? null : Number(row.getAttribute("data-pr")));
    };
    return (
        <div
            ref={listRef}
            className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3"
            onKeyDown={onKeyDown}
            onMouseOver={onPointerOver}
            onMouseLeave={() => setHovered(null)}
            data-role="molten-reviews"
        >
            <ForecastLinks listRef={listRef} source={forecastActive} targets={shownForecast.targets} />
            {answer.prserror ? <Problem text={t("reviews.prsError", { error: answer.prserror })} /> : null}
            <LaunchBar dir={dir} mergedNumbers={mergedNumbers} trunk={answer.target} />
            <LaunchDialogs trunk={answer.target} />
            <CheckAgentsBar dir={dir} repo={answer.repo} prs={[...split.ready, ...split.drafts]} />
            {answer.reportserror ? (
                <div className="text-11 text-muted" title={answer.reportserror}>
                    {t("reviews.reportsError")}
                </div>
            ) : null}
            <section className="flex flex-col gap-2" aria-label={t("reviews.waiting")}>
                <h2 className="flex items-baseline gap-2 text-13 leading-5 font-semibold">
                    {t("reviews.waiting")}
                    <span className="text-12 font-normal text-muted">{split.ready.length}</span>
                    <ForecastStatusLine status={status} />
                    {split.ready.length > 1 && !selecting ? (
                        <button
                            type="button"
                            onClick={() => {
                                setSelecting(true);
                                setBatchSelected([]);
                            }}
                            className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 self-center rounded-4 border border-border px-1.5 py-0.5 text-11 leading-4 font-normal text-secondary hover:bg-hover hover:text-primary"
                            title={t("reviews.batch.select.startTitle")}
                            data-testid="reviews-batch-start"
                        >
                            <i className="fa fa-solid fa-layer-group text-10" aria-hidden />
                            {t("reviews.batch.select.start")}
                        </button>
                    ) : null}
                </h2>
                {batchShown(batchRun) ? <BatchBanner run={batchRun} /> : null}
                {selecting ? (
                    <BatchSelectBar
                        count={batchSelected.length}
                        onMerge={() => setConfirming(true)}
                        onCancel={endSelection}
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
                {forecastReq != null && split.ready.length > 1 ? (
                    <MergeOrderBar choice={orderChoice} header={orderHeader} />
                ) : null}
                {split.ready.length === 0 ? (
                    <p className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted">
                        {t("reviews.noneWaiting")} <code>{answer.target}</code>.
                    </p>
                ) : (
                    <div
                        className="overflow-clip rounded-4 border border-border [overflow-clip-margin:1px]"
                        role="list"
                    >
                        {split.ready.map((pr) => (
                            <ReviewRow key={pr.number} {...rowProps(pr)} />
                        ))}
                    </div>
                )}
            </section>
            <section className="flex flex-col gap-2" aria-label={t("reviews.draftsTitle")}>
                <button
                    type="button"
                    onClick={() => setDraftsOpen(!draftsOpen)}
                    aria-expanded={draftsOpen}
                    className="flex w-fit cursor-pointer items-center gap-1.5 rounded-4 text-13 leading-5 font-semibold hover:text-primary"
                    data-testid="reviews-drafts-toggle"
                >
                    <i
                        className={cn(
                            "fa fa-solid fa-chevron-right text-11 text-muted transition-transform duration-120 ease-mt",
                            draftsOpen && "rotate-90"
                        )}
                        aria-hidden
                    />
                    {t("reviews.draftsTitle")}
                    <span className="ml-0.5 text-12 font-normal text-muted">{split.drafts.length}</span>
                </button>
                {!draftsOpen ? null : split.drafts.length === 0 ? (
                    <p
                        className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted"
                        data-testid="reviews-drafts-empty"
                    >
                        {t("reviews.noneDrafts")} <code>{answer.target}</code>.
                    </p>
                ) : (
                    <div
                        className="overflow-clip rounded-4 border border-border [overflow-clip-margin:1px]"
                        role="list"
                        data-testid="reviews-drafts"
                    >
                        {split.drafts.map((pr) => (
                            <ReviewRow key={pr.number} {...rowProps(pr)} />
                        ))}
                    </div>
                )}
            </section>
            <UpcomingSection dir={dir} reviews={answer} />
            {answer.repo ? <NotesSection dir={dir} repo={answer.repo} blockId={blockId} ask={notesAsk} /> : null}
            {answer.repo ? (
                <MergedSection answer={answer} onShowNotes={(filter) => setNotesAsk({ filter, at: Date.now() })} />
            ) : null}
        </div>
    );
}

function Problem({ text }: { text: string }) {
    return <div className="rounded-4 border border-error/40 bg-error/10 px-3 py-2 text-12 text-danger">{text}</div>;
}
