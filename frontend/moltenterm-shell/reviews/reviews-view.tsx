// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view (FR-REV-001, DS-REV-012): the pull requests of the workspace's project waiting for the developer's
// review, each with its ticket, CI, test report and merge state, read through the developer's gh by Mission Control's
// collector. Drafts wait below in their own group, where they open and can be marked ready for review (#687). A row
// opens the PR's assisted review, which its hover/focus link names (#708); the keyboard walks the rows (arrows, Home,
// End) and Enter opens one.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../empty-state";
import { I18nModel, t as translate, useLocale, useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { CiIcon, CiIconState } from "../mission/ci-icon";
import { ActiveProject, MissionFrame, MissionHeader } from "../mission/mission-frame";
import { MissionSnapshot } from "../mission/mission-model";
import { timeAgo } from "../mission/time-format";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import type { ReviewMergeMethod } from "../review/review-client";
import { ValidateSheet } from "../review/review-validate";
import { DominoLoader } from "../suite/suite";
import { DraftTurnChip, RowAgentLine } from "./reviews-agent-bar";
import { BatchBanner, BatchCheckbox, BatchConfirmDialog, BatchRowChip, BatchSelectBar } from "./reviews-batch";
import { BatchRuns, useBatchRun } from "./reviews-batch-client";
import {
    batchPlan,
    BatchRowMark,
    batchRowMark,
    batchSelectable,
    batchShown,
    batchStartRequest,
    queueOrder,
    toggleBatchSelection,
} from "./reviews-batch-model";
import { CheckAgentsBar } from "./reviews-check";
import { CiFailureButtons, RerunConfirm, useRerunFailed } from "./reviews-ci-actions";
import { useReviews } from "./reviews-client";
import {
    ForecastLinks,
    ForecastMarkChip,
    ForecastNote,
    ForecastStatusLine,
    linkedRowClass,
    listForecast,
    RowForecast,
} from "./reviews-forecast";
import { useForecastAnswer, useForecastWatch } from "./reviews-forecast-client";
import { forecastRequestOf, forecastStatus } from "./reviews-forecast-model";
import { MarkReadyButton, MarkReadyConfirm, MarkReadyState, useMarkReady } from "./reviews-mark-ready";
import { MergedSection } from "./reviews-merged";
import {
    ciLabel,
    mergeLabelOf,
    MoltentermReviewsView,
    navigableRows,
    nextRow,
    RebaseAsk,
    rebaseAskKey,
    rebaseAskShown,
    RebaseOutcome,
    reportLabel,
    reviewAriaLabel,
    reviewHeadline,
    ReviewPr,
    ReviewsAnswer,
    reviewsEmptyState,
    reviewsRetryIsPrimary,
    splitReviews,
    Tone,
    validateBlocked,
} from "./reviews-model";
import { NotesAsk, NotesSection } from "./reviews-notes-view";
import { MergeOrderBar, MergeOrderRank, MergeOrderReason, RowOrder, useMergeOrderChoice } from "./reviews-order";
import { mergeOrderHeader, mergeOrderReason, orderedPrs, suggestedMergeOrder } from "./reviews-order-model";
import { ReviewsModel } from "./reviews-store";
import { UpcomingSection } from "./reviews-upcoming";

export { MoltentermReviewsView };

// How long a PR another surface asked for stays marked.
const FocusMarkMs = 4000;
const RowKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

const ToneClasses: Record<Tone, string> = {
    success: "border-success/40 bg-success/10 text-success",
    failure: "border-error/40 bg-error/10 text-danger",
    pending: "border-warning/40 bg-warning/10 text-warning",
    neutral: "border-border bg-hover text-muted",
};

const ToneCiStates: Record<Tone, CiIconState> = {
    success: "success",
    failure: "failure",
    pending: "warning",
    neutral: "neutral",
};

const Chip = "inline-flex items-center gap-1 rounded-4 border px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap";

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
    const startBatch = async (method: ReviewMergeMethod): Promise<string> => {
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
            return serverErrorText(e);
        }
        endSelection();
        return "";
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

function ToneChip({
    label,
    tone,
    title,
    icon,
    testId,
}: {
    label: string;
    tone: Tone;
    title: string;
    icon?: CiIconState;
    testId?: string;
}) {
    return (
        <span className={cn(Chip, ToneClasses[tone])} title={title} data-testid={testId}>
            <CiIcon state={icon ?? ToneCiStates[tone]} />
            {label}
        </span>
    );
}

// The row's own buttons: their click and their keys stay theirs, the row's click and Enter open the review.
function stopRow(e: React.SyntheticEvent) {
    e.stopPropagation();
}

const SecondaryButton =
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

// The link is always laid out and only fades in, so showing it never moves the chips (#708).
const AssistedLinkClasses =
    "flex shrink-0 cursor-pointer items-center gap-1 rounded-4 px-0.5 text-12 leading-5 font-medium text-accent outline-none " +
    "translate-x-1 opacity-0 transition-[opacity,translate] duration-120 ease-mt " +
    "group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 " +
    "focus-visible:translate-x-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-(--mt-focus-ring) " +
    "hover:underline motion-reduce:translate-x-0";

// The row's click opens the assisted review (the PR's Review tab); this link names it on hover and keyboard focus
// and does the same. On a narrow panel it keeps an icon and the arrow, named for assistive technologies.
export function AssistedReviewLink({ number, onOpen }: { number: number; onOpen: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onOpen();
            }}
            onKeyDown={stopRow}
            aria-label={t("reviews.assistedReviewAria", { number })}
            title={t("reviews.assistedReviewAria", { number })}
            className={AssistedLinkClasses}
            data-testid="reviews-assisted-review"
        >
            <span className="@[6.25rem]/link:hidden" aria-hidden>
                <i className="fa fa-solid fa-sparkles text-11" />
            </span>
            <span className="hidden whitespace-nowrap @[6.25rem]/link:inline">{t("reviews.assistedReview")}</span>
            <i className="fa fa-solid fa-arrow-right text-11" aria-hidden />
        </button>
    );
}

// The row's two buttons: GitHub (secondary) opens the PR's page, Validate (primary) merges through its plan sheet, or
// Mark ready on a draft. Neither opens the assisted review.
export function ReviewRowActions({
    pr,
    blocked,
    markReady,
    onValidate,
}: {
    pr: ReviewPr;
    blocked: string;
    markReady: MarkReadyState;
    onValidate: () => void;
}) {
    const t = useT();
    const validate = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (blocked) {
            return;
        }
        onValidate();
    };
    const openOnGithub = (e: React.MouseEvent) => {
        e.stopPropagation();
        fireAndForget(() => openWebLink(pr.url));
    };
    return (
        <div className="flex shrink-0 items-center gap-1.5">
            <button
                type="button"
                onClick={openOnGithub}
                onKeyDown={stopRow}
                className={SecondaryButton}
                title={t("reviews.openOnGithub")}
                data-testid="reviews-github"
            >
                <i className="fa fa-brands fa-github text-12" aria-hidden />
                GitHub
                <i className="fa fa-solid fa-arrow-up-right-from-square text-10 text-muted" aria-hidden />
            </button>
            {pr.draft ? (
                <MarkReadyButton state={markReady} className="px-2.5 py-1" />
            ) : (
                <button
                    type="button"
                    onClick={validate}
                    onKeyDown={stopRow}
                    aria-disabled={blocked ? true : undefined}
                    className="molten-btn cursor-pointer rounded-6 px-2.5 py-1 text-12"
                    title={blocked || t("reviews.validate.title")}
                    data-testid="reviews-validate"
                >
                    {t("reviews.validate.button")}
                    <MoltenWave />
                </button>
            )}
        </div>
    );
}

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
    forecast,
    forecastActive,
    order,
    batchCheck,
    batchMark,
}: {
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
    forecast?: RowForecast;
    forecastActive?: boolean;
    order?: RowOrder;
    // batchCheck: the row's box while PRs are selected for a batch merge, null otherwise; batchMark: its place in the run.
    batchCheck?: boolean;
    batchMark?: BatchRowMark;
}) {
    const t = useT();
    useLocale();
    const [asking, setAsking] = useState(false);
    const [outcome, setOutcome] = useState<RebaseOutcome>(null);
    const head = reviewHeadline(pr);
    const ci = ciLabel(pr.ci);
    const report = reportLabel(pr.report);
    const merge = mergeLabelOf(pr);
    const blocked = validateBlocked(pr);
    const asked = rebaseAskShown(rebaseAsk, pr);
    const conflicts = pr.merge === "conflicts";
    const outcomeShown = outcome != null && (outcome.kind !== "asked" || outcome.note);
    const markReady = useMarkReady(dir, pr.number, repo);
    const rerun = useRerunFailed(dir, pr.number);
    const [investigating, setInvestigating] = useState(false);
    useEffect(() => {
        setOutcome(null);
    }, [pr.headoid]);
    const askRebase = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (asking) {
            return;
        }
        setAsking(true);
        setOutcome(null);
        fireAndForget(async () => {
            try {
                setOutcome(await onAskRebase());
            } finally {
                setAsking(false);
            }
        });
    };
    const investigate = () => {
        if (investigating || onInvestigate == null) {
            return;
        }
        setInvestigating(true);
        setOutcome(null);
        fireAndForget(async () => {
            try {
                setOutcome(await onInvestigate());
            } finally {
                setInvestigating(false);
            }
        });
    };
    // Retry (#954): the row's task again, its outcome on the row's line like the first ask's.
    const retry = () => {
        if (asking || rebaseAsk == null) {
            return;
        }
        setAsking(true);
        setOutcome(null);
        fireAndForget(async () => {
            try {
                setOutcome(await ReviewsModel.getInstance().retryTask(dir, pr, repo, rebaseAsk.kind ?? "rebase"));
            } finally {
                setAsking(false);
            }
        });
    };
    const openReport = (e: React.MouseEvent) => {
        e.stopPropagation();
        fireAndForget(() => openWebLink(pr.report.url));
    };
    return (
        <div
            role="listitem"
            tabIndex={0}
            data-pr={pr.number}
            aria-label={[
                order ? t("reviews.order.rankTitle", { rank: order.rank }) : "",
                reviewAriaLabel(pr),
                order?.reason,
                forecast?.mark?.aria,
                forecast?.note,
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
                "group flex cursor-pointer flex-col gap-1.5 border-b border-border px-3 py-2.5 outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover",
                selected && "bg-hover/60",
                marked && "ring-2 ring-accent/70 ring-inset",
                linkedRowClass(forecast?.linked)
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-13 leading-5 font-medium">
                        {batchCheck != null ? <BatchCheckbox checked={batchCheck} number={pr.number} /> : null}
                        <MergeOrderRank order={order} />
                        {head.ticket ? <span className="mr-1.5 text-accent">{head.ticket}</span> : null}
                        {head.title}
                    </div>
                    <div className="truncate text-12 text-muted">
                        PR #{pr.number} · <code>{pr.branch}</code>
                        {pr.author ? ` · ${pr.author}` : ""} ·{" "}
                        {t("reviews.opened", { when: timeAgo(pr.createdat || pr.updatedat) })} ·{" "}
                        {t("reviews.updated", { when: timeAgo(pr.updatedat) })}
                    </div>
                    <MergeOrderReason order={order} />
                </div>
                <ReviewRowActions pr={pr} blocked={blocked} markReady={markReady} onValidate={onValidate} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
                <ToneChip
                    label={ci.label}
                    tone={ci.tone}
                    title={ci.title}
                    icon={ci.tone === "pending" ? "running" : undefined}
                    testId="reviews-ci"
                />
                {pr.report?.state === "present" && pr.report.url ? (
                    <button
                        type="button"
                        onClick={openReport}
                        className={cn(Chip, ToneClasses[report.tone], "cursor-pointer hover:brightness-125")}
                        title={report.title}
                        data-testid="reviews-report"
                    >
                        <CiIcon state="success" />
                        {report.label}
                    </button>
                ) : (
                    <ToneChip label={report.label} tone={report.tone} title={report.title} testId="reviews-report" />
                )}
                <ToneChip label={merge.label} tone={merge.tone} title={merge.title} testId="reviews-merge" />
                {pr.draft ? <DraftTurnChip dir={dir} branch={pr.branch} /> : null}
                <ForecastMarkChip mark={forecast?.mark} active={forecastActive} />
                <BatchRowChip mark={batchMark} />
                {pr.unpublished > 0 ? (
                    <span className={cn(Chip, ToneClasses.pending)} title={t("reviews.unpublishedTitle")}>
                        <i className="fa fa-solid fa-comment text-11" />
                        {t("reviews.unpublished", { count: pr.unpublished })}
                    </span>
                ) : null}
                {asked ? (
                    <span
                        className={cn(Chip, ToneClasses.neutral)}
                        title={t("reviews.rebase.chipTitle")}
                        data-testid="reviews-rebase-asked"
                    >
                        <i className="fa fa-solid fa-code-branch text-11" />
                        {t("reviews.rebase.chip", { name: rebaseAsk.name })}
                    </span>
                ) : null}
                {conflicts && !asked ? (
                    <button
                        type="button"
                        onClick={askRebase}
                        onKeyDown={stopRow}
                        aria-busy={asking || undefined}
                        className={cn(SecondaryButton, "py-0.5 text-11")}
                        title={t("reviews.rebase.buttonTitle", { base: pr.base, branch: pr.branch })}
                        data-testid="reviews-rebase"
                    >
                        {asking ? <DominoLoader /> : <i className="fa fa-solid fa-code-branch text-11" />}
                        {asking ? t("reviews.rebase.asking") : t("reviews.rebase.button")}
                    </button>
                ) : null}
                {onInvestigate != null ? (
                    <CiFailureButtons pr={pr} rerun={rerun} investigating={investigating} onInvestigate={investigate} />
                ) : null}
                {/* Joins the chips' line as soon as an icon fits there, then takes the rest of it: the label shows
                    when it fits, so the link never wraps to a line of its own. */}
                <div
                    className={cn(
                        "@container/link relative flex min-w-10 grow basis-10 justify-end",
                        forecast?.note && "[&>button]:invisible"
                    )}
                >
                    <AssistedReviewLink number={pr.number} onOpen={onOpen} />
                    <ForecastNote text={forecast?.note} />
                </div>
            </div>
            <MarkReadyConfirm state={markReady} />
            <RerunConfirm pr={pr} state={rerun} />
            {outcomeShown ? (
                <div
                    className={cn(
                        "flex flex-wrap items-center gap-2 text-12 leading-4",
                        outcome.kind === "failed" ? "text-danger" : "text-secondary"
                    )}
                    role="status"
                    data-testid="reviews-rebase-outcome"
                >
                    <span className="min-w-0">{outcome.text}</span>
                </div>
            ) : null}
            {/* Last: the agent bar docks at the tile's bottom edge (-mb-2.5), anything after it lands below it. */}
            <RowAgentLine
                dir={dir}
                pr={pr}
                task={rebaseAsk}
                onRetry={retry}
                onOpenWork={(blockId) => ReviewsModel.getInstance().openAgentWork(dir, pr, repo, blockId)}
                onStop={(blockId) => ReviewsModel.getInstance().stopAgent(blockId)}
            />
        </div>
    );
}
