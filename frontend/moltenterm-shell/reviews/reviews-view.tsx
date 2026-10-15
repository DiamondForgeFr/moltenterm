// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view (FR-REV-001, DS-REV-012): the pull requests of the workspace's project waiting for the developer's
// review, each with its ticket, CI, test report and merge state, read through the developer's gh by Mission Control's
// collector. Drafts wait below in their own group, where they open and can be marked ready for review (#687). A row
// opens the PR's assisted review, which its hover/focus link names (#708); the keyboard walks the rows (arrows, Home,
// End) and Enter opens one.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../empty-state";
import { I18nModel, t as translate, useLocale, useT } from "../i18n/i18n";
import { CiIcon, CiIconState } from "../mission/ci-icon";
import { ActiveProject, MissionFrame, MissionHeader } from "../mission/mission-frame";
import { MissionSnapshot } from "../mission/mission-model";
import { timeAgo } from "../mission/time-format";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { ValidateSheet } from "../review/review-validate";
import { useReviews } from "./reviews-client";
import { MarkReadyButton, MarkReadyConfirm, MarkReadyState, useMarkReady } from "./reviews-mark-ready";
import {
    ciLabel,
    mergeLabel,
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
    splitReviews,
    Tone,
    validateBlocked,
} from "./reviews-model";
import { NotesSection } from "./reviews-notes-view";
import { ReviewsModel } from "./reviews-store";

export { MoltentermReviewsView };

// How long a PR another surface asked for stays marked.
const FocusMarkMs = 4000;
const RowKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

const ToneClasses: Record<Tone, string> = {
    success: "border-success/40 bg-success/10 text-success",
    failure: "border-error/40 bg-error/10 text-error",
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
        return (
            <EmptyState
                icon={empty.icon}
                title={empty.title}
                hint={empty.hint}
                primary={{ label: t("reviews.tryAgain"), onClick: refresh }}
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
    const listRef = useRef<HTMLDivElement>(null);
    const split = useMemo(() => splitReviews(answer, readied), [answer, readied]);
    const rows = navigableRows(split, draftsOpen);
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
        const timer = setTimeout(() => setMarked(null), FocusMarkMs);
        return () => clearTimeout(timer);
    }, [focus, dir, split, model]);
    useEffect(() => {
        if (selected == null) {
            return;
        }
        listRef.current?.querySelector<HTMLElement>(`[data-pr="${selected}"]`)?.scrollIntoView?.({ block: "nearest" });
    }, [selected, draftsOpen]);
    const open = (pr: ReviewPr) => fireAndForget(() => model.openPullRequestReview(dir, pr, answer.repo));
    const onKeyDown = (e: React.KeyboardEvent) => {
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
        onAskRebase: (start: boolean) => model.askRebase(dir, pr, answer.repo, start),
        rebaseAsk: asks[rebaseAskKey(dir, pr.number)],
        dir,
        repo: answer.repo,
    });
    return (
        <div
            ref={listRef}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3"
            onKeyDown={onKeyDown}
            data-role="molten-reviews"
        >
            {answer.prserror ? <Problem text={t("reviews.prsError", { error: answer.prserror })} /> : null}
            {answer.reportserror ? (
                <div className="text-11 text-muted" title={answer.reportserror}>
                    {t("reviews.reportsError")}
                </div>
            ) : null}
            <section className="flex flex-col gap-2" aria-label={t("reviews.waiting")}>
                <h2 className="text-13 leading-5 font-semibold">
                    {t("reviews.waiting")}
                    <span className="ml-2 text-12 font-normal text-muted">{split.ready.length}</span>
                </h2>
                {split.ready.length === 0 ? (
                    <p className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted">
                        {t("reviews.noneWaiting")} <code>{answer.target}</code>.
                    </p>
                ) : (
                    <div className="overflow-hidden rounded-4 border border-border" role="list">
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
                        className="overflow-hidden rounded-4 border border-border"
                        role="list"
                        data-testid="reviews-drafts"
                    >
                        {split.drafts.map((pr) => (
                            <ReviewRow key={pr.number} {...rowProps(pr)} />
                        ))}
                    </div>
                )}
            </section>
            {answer.repo ? <NotesSection dir={dir} repo={answer.repo} blockId={blockId} /> : null}
        </div>
    );
}

function Problem({ text }: { text: string }) {
    return <div className="rounded-4 border border-error/40 bg-error/10 px-3 py-2 text-12 text-error">{text}</div>;
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
    "flex shrink-0 cursor-pointer items-center gap-1 rounded-4 px-1 text-12 leading-5 font-medium text-accent outline-none " +
    "translate-x-1 opacity-0 transition-[opacity,translate] duration-120 ease-mt " +
    "group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 " +
    "focus-visible:translate-x-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/70 " +
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
            className={AssistedLinkClasses}
            data-testid="reviews-assisted-review"
        >
            <i className="fa fa-solid fa-sparkles text-11 @xs:hidden" aria-hidden />
            <span className="hidden @xs:inline">{t("reviews.assistedReview")}</span>
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
    rebaseAsk,
    dir,
    repo,
}: {
    pr: ReviewPr;
    selected: boolean;
    marked: boolean;
    onSelect: () => void;
    onOpen: () => void;
    onValidate: () => void;
    onAskRebase: (start: boolean) => Promise<RebaseOutcome>;
    rebaseAsk: RebaseAsk;
    dir: string;
    repo: string;
}) {
    const t = useT();
    useLocale();
    const [asking, setAsking] = useState(false);
    const [outcome, setOutcome] = useState<RebaseOutcome>(null);
    const head = reviewHeadline(pr);
    const ci = ciLabel(pr.ci);
    const report = reportLabel(pr.report);
    const merge = mergeLabel(pr.merge, pr.base);
    const blocked = validateBlocked(pr);
    const asked = rebaseAskShown(rebaseAsk, pr);
    const conflicts = pr.merge === "conflicts";
    const outcomeShown = outcome != null && (outcome.kind !== "asked" || outcome.note);
    const markReady = useMarkReady(dir, pr.number, repo);
    useEffect(() => {
        setOutcome(null);
    }, [pr.headoid]);
    const askRebase = (e: React.MouseEvent, start: boolean) => {
        e.stopPropagation();
        if (asking) {
            return;
        }
        setAsking(true);
        setOutcome(null);
        fireAndForget(async () => {
            try {
                setOutcome(await onAskRebase(start));
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
            aria-label={reviewAriaLabel(pr)}
            aria-current={selected || undefined}
            onClick={() => {
                onSelect();
                onOpen();
            }}
            onFocus={onSelect}
            className={cn(
                "group @container flex cursor-pointer flex-col gap-1.5 border-b border-border px-3 py-2.5 outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover",
                selected && "bg-hover/60",
                marked && "ring-2 ring-accent/70 ring-inset"
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-13 leading-5 font-medium">
                        {head.ticket ? <span className="mr-1.5 text-accent">{head.ticket}</span> : null}
                        {head.title}
                    </div>
                    <div className="truncate text-12 text-muted">
                        PR #{pr.number} · <code>{pr.branch}</code>
                        {pr.author ? ` · ${pr.author}` : ""} ·{" "}
                        {t("reviews.opened", { when: timeAgo(pr.createdat || pr.updatedat) })} ·{" "}
                        {t("reviews.updated", { when: timeAgo(pr.updatedat) })}
                    </div>
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
                <div className="ml-auto flex items-center gap-1.5">
                    {conflicts && !asked ? (
                        <button
                            type="button"
                            onClick={(e) => askRebase(e, false)}
                            onKeyDown={stopRow}
                            aria-busy={asking || undefined}
                            className={cn(SecondaryButton, "py-0.5 text-11")}
                            title={t("reviews.rebase.buttonTitle", { base: pr.base, branch: pr.branch })}
                            data-testid="reviews-rebase"
                        >
                            <i
                                className={cn("fa fa-solid text-11", asking ? "fa-spinner fa-spin" : "fa-code-branch")}
                            />
                            {asking ? t("reviews.rebase.asking") : t("reviews.rebase.button")}
                        </button>
                    ) : null}
                    <AssistedReviewLink number={pr.number} onOpen={onOpen} />
                </div>
            </div>
            <MarkReadyConfirm state={markReady} />
            {outcomeShown ? (
                <div
                    className={cn(
                        "flex flex-wrap items-center gap-2 text-12 leading-4",
                        outcome.kind === "failed" ? "text-error" : "text-secondary"
                    )}
                    role="status"
                    data-testid="reviews-rebase-outcome"
                >
                    <span className="min-w-0">{outcome.text}</span>
                    {outcome.kind === "offer" ? (
                        <>
                            <button
                                type="button"
                                onClick={(e) => askRebase(e, true)}
                                onKeyDown={stopRow}
                                className="molten-btn cursor-pointer rounded-6 px-2.5 py-1 text-12"
                                data-testid="reviews-rebase-start"
                            >
                                {t("reviews.rebase.start")}
                                <MoltenWave />
                            </button>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setOutcome(null);
                                }}
                                onKeyDown={stopRow}
                                className={SecondaryButton}
                            >
                                {t("common.cancel")}
                            </button>
                        </>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
