// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view (FR-REV-001, DS-REV-012): the pull requests of the workspace's project waiting for the developer's
// review, each with its ticket, CI, test report and merge state, read through the developer's gh by Mission Control's
// collector. Drafts wait below in a collapsed "In testing" group. A row opens the PR's review; the keyboard walks the
// rows (arrows, Home, End) and Enter opens one.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { openLink } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../empty-state";
import { CiIcon, CiIconState } from "../mission/ci-icon";
import { ActiveProject, MissionFrame, MissionHeader } from "../mission/mission-frame";
import { MissionSnapshot } from "../mission/mission-model";
import { timeAgo } from "../mission/time-format";
import { useReviews } from "./reviews-client";
import {
    ciLabel,
    mergeLabel,
    MoltentermReviewsView,
    navigableRows,
    nextRow,
    reportLabel,
    reviewAriaLabel,
    reviewHeadline,
    ReviewPr,
    ReviewsAnswer,
    reviewsEmptyState,
    Tone,
} from "./reviews-model";
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
    viewName = atom("Reviews");
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return ReviewsView;
    }
}

function ReviewsView() {
    return (
        <MissionFrame title="Reviews">
            {({ project, snapshot }) => <ReviewsContent project={project} snapshot={snapshot} />}
        </MissionFrame>
    );
}

function ReviewsContent({ project, snapshot }: { project: ActiveProject; snapshot: MissionSnapshot }) {
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
                        title={`Pull requests into ${answer.target} (${answer.targetfrom})`}
                    >
                        into <code>{answer.target}</code>
                    </span>
                ) : null}
            </MissionHeader>
            <ReviewsBody dir={project.dir} answer={answer} error={error} refresh={refresh} />
        </>
    );
}

function ReviewsBody({
    dir,
    answer,
    error,
    refresh,
}: {
    dir: string;
    answer: ReviewsAnswer;
    error: string;
    refresh: () => void;
}) {
    if (answer == null && error) {
        return (
            <EmptyState
                icon="triangle-exclamation"
                title="Reviews could not answer"
                hint="MoltenTerm could not read this project's pull requests. Try again in a moment."
                primary={{ label: "Try again", onClick: refresh }}
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
                primary={{ label: "Try again", onClick: refresh }}
                details={empty.details}
                testId={`reviews-empty-${answer.state}`}
            />
        );
    }
    return <ReviewsList dir={dir} answer={answer} />;
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

function ReviewsList({ dir, answer }: { dir: string; answer: ReviewsAnswer }) {
    const model = ReviewsModel.getInstance();
    const focus = useAtomValue(model.focusAtom);
    const [draftsOpen, setDraftsOpen] = useState(false);
    const [selected, setSelected] = useState<number>(null);
    const [marked, setMarked] = useState<number>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const rows = navigableRows(answer, draftsOpen);
    useEffect(() => {
        if (focus == null || focus.dir !== dir) {
            return;
        }
        const isDraft = answer.drafts.some((pr) => pr.number === focus.number);
        if (!isDraft && !answer.ready.some((pr) => pr.number === focus.number)) {
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
    }, [focus, dir, answer, model]);
    useEffect(() => {
        if (selected == null) {
            return;
        }
        listRef.current?.querySelector<HTMLElement>(`[data-pr="${selected}"]`)?.scrollIntoView?.({ block: "nearest" });
    }, [selected, draftsOpen]);
    const open = (pr: ReviewPr) => fireAndForget(() => model.openPullRequestReview(dir, pr));
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (RowKeys.has(e.key)) {
            e.preventDefault();
            const next = nextRow(rows, selected, e.key);
            setSelected(next);
            listRef.current?.querySelector<HTMLElement>(`[data-pr="${next}"]`)?.focus();
            return;
        }
        if (e.key === "Enter") {
            const pr = rows.find((r) => r.number === selected);
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
    });
    return (
        <div
            ref={listRef}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3"
            onKeyDown={onKeyDown}
            data-role="molten-reviews"
        >
            {answer.prserror ? <Problem text={`The pull requests could not be read: ${answer.prserror}`} /> : null}
            {answer.reportserror ? (
                <div className="text-11 text-muted" title={answer.reportserror}>
                    The test reports could not be read; they show as unknown.
                </div>
            ) : null}
            <section className="flex flex-col gap-2" aria-label="Waiting for review">
                <h2 className="text-13 leading-5 font-semibold">
                    Waiting for review
                    <span className="ml-2 text-12 font-normal text-muted">{answer.ready.length}</span>
                </h2>
                {answer.ready.length === 0 ? (
                    <p className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted">
                        No pull request waiting for review into <code>{answer.target}</code>.
                    </p>
                ) : (
                    <div className="overflow-hidden rounded-4 border border-border" role="list">
                        {answer.ready.map((pr) => (
                            <ReviewRow key={pr.number} {...rowProps(pr)} />
                        ))}
                    </div>
                )}
            </section>
            {answer.drafts.length > 0 ? (
                <section className="flex flex-col gap-2" aria-label="In testing">
                    <button
                        type="button"
                        onClick={() => setDraftsOpen(!draftsOpen)}
                        aria-expanded={draftsOpen}
                        className="flex w-fit cursor-pointer items-center gap-1.5 rounded-4 text-13 leading-5 font-semibold text-secondary hover:text-primary"
                        data-testid="reviews-drafts-toggle"
                    >
                        <i
                            className={cn(
                                "fa fa-solid fa-chevron-right text-11 transition-transform duration-120 ease-mt",
                                draftsOpen && "rotate-90"
                            )}
                            aria-hidden
                        />
                        In testing
                        <span className="text-12 font-normal text-muted">
                            {answer.drafts.length} draft{answer.drafts.length > 1 ? "s" : ""}
                        </span>
                    </button>
                    {draftsOpen ? (
                        <div className="overflow-hidden rounded-4 border border-border" role="list">
                            {answer.drafts.map((pr) => (
                                <ReviewRow key={pr.number} {...rowProps(pr)} />
                            ))}
                        </div>
                    ) : null}
                </section>
            ) : null}
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

function ReviewRow({
    pr,
    selected,
    marked,
    onSelect,
    onOpen,
}: {
    pr: ReviewPr;
    selected: boolean;
    marked: boolean;
    onSelect: () => void;
    onOpen: () => void;
}) {
    const head = reviewHeadline(pr);
    const ci = ciLabel(pr.ci);
    const report = reportLabel(pr.report);
    const merge = mergeLabel(pr.merge, pr.base);
    const openReport = (e: React.MouseEvent) => {
        e.stopPropagation();
        fireAndForget(() => openLink(pr.report.url));
    };
    const openOnGithub = (e: React.MouseEvent) => {
        e.stopPropagation();
        fireAndForget(() => openLink(pr.url));
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
                "group flex cursor-pointer flex-col gap-1.5 border-b border-border px-3 py-2.5 outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover",
                selected && "bg-hover/60",
                marked && "ring-2 ring-accent/70 ring-inset"
            )}
            title="Open the review"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-13 leading-5 font-medium">
                        {head.ticket ? <span className="mr-1.5 text-accent">{head.ticket}</span> : null}
                        {head.title}
                    </div>
                    <div className="truncate text-12 text-muted">
                        PR #{pr.number} · <code>{pr.branch}</code>
                        {pr.author ? ` · ${pr.author}` : ""} · opened {timeAgo(pr.createdat || pr.updatedat)} · updated{" "}
                        {timeAgo(pr.updatedat)}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={openOnGithub}
                    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
                    title="Open the pull request on GitHub"
                >
                    <i className="fa fa-solid fa-arrow-up-right-from-square text-11" />
                    GitHub
                </button>
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
                    <span className={cn(Chip, ToneClasses.pending)} title="Comments written here, not published yet">
                        <i className="fa fa-solid fa-comment text-11" />
                        {pr.unpublished} unpublished
                    </span>
                ) : null}
            </div>
        </div>
    );
}
