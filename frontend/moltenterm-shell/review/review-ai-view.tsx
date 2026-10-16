// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's AI panel (DS-REV-012): a pane right of the review block, with the review session's terminal split
// under it, so the cards the agent posts sit above the agent's own terminal. It shows the session's state and the PR's
// briefing (FR-REV-005): what changed, why, the risks and the files to look at first (links that open the file in the
// diff at the line), what was tested and its gaps. The briefing is kept in the review store and shown again when the
// PR is reopened. Its markdown is the agent's: rendered, never executed. Under it, the questions waiting for the agent
// and its answers on their lines (FR-REV-006, review-answers-view.tsx), then the PR's review comments (FR-REV-009):
// the agent's proposals, the staged comments and the drafts, with their discussion.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { Markdown } from "@/app/element/markdown";
import * as WOS from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { codingAgentName } from "../coding-agent/coding-agent";
import { EmptyState } from "../empty-state";
import { I18nModel, t as translate, useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import { AskBox } from "./review-actions-view";
import { AnswersSection, QuestionQueue } from "./review-answers-view";
import { ReviewPrInfo, ReviewPrMetaKey } from "./review-client";
import { CommentsPanel } from "./review-comments-view";
import { briefingNote, MoltentermReviewAiView, parseFileLink, reviewKey } from "./review-model";
import { ReviewAiState, ReviewBriefAsk, ReviewTabModel, ReviewTabModels } from "./review-tab-model";

export { MoltentermReviewAiView };

const SecondaryButton =
    "flex h-6 w-fit cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 text-12 whitespace-nowrap text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

// A minute is enough for the "written … ago" line.
const ClockMs = 60_000;

export class ReviewAiViewModel implements ViewModel {
    viewType = MoltentermReviewAiView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("sparkles");
    viewName: Atom<string>;
    noPadding = atom(true);
    prAtom: Atom<ReviewPrInfo>;
    // The Review tab's model of the PR (its review block), null while it is not mounted.
    reviewAtom: Atom<ReviewTabModel>;

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
        this.prAtom = atom((get) => (get(blockAtom)?.meta?.[ReviewPrMetaKey] as ReviewPrInfo) ?? null);
        this.viewName = atom((get) => {
            const pr = get(this.prAtom);
            get(I18nModel.getInstance().localeAtom);
            return pr ? translate("review.ai.viewNamePr", { number: pr.number }) : translate("review.ai.viewName");
        });
        this.reviewAtom = atom((get) => {
            const pr = get(this.prAtom);
            return pr == null ? null : (get(ReviewTabModels).get(reviewKey(pr.repo, pr.number)) ?? null);
        });
    }

    get viewComponent(): ViewComponent {
        return ReviewAiView;
    }
}

export function ReviewAiView({ model }: ViewComponentProps<ReviewAiViewModel>) {
    const t = useT();
    const pr = useAtomValue(model.prAtom);
    const review = useAtomValue(model.reviewAtom);
    if (pr == null) {
        return <EmptyState icon="sparkles" title={t("review.ai.noPr")} hint={t("review.ai.noPrHint")} />;
    }
    if (review == null) {
        return (
            <EmptyState
                icon="code-pull-request"
                title={t("review.ai.notOpen", { number: pr.number })}
                hint={t("review.ai.notOpenHint")}
            />
        );
    }
    return <AiPanel review={review} />;
}

function AiPanel({ review }: { review: ReviewTabModel }) {
    const t = useT();
    const ai = useAtomValue(review.aiAtom);
    const worktree = useAtomValue(review.worktreeAtom);
    const focusTerminal = () => {
        const layout = getLayoutModelForStaticTab();
        const node = ai.session?.blockid ? layout?.getNodeByBlockId(ai.session.blockid) : null;
        if (node != null) {
            layout.focusNode(node.id);
        }
    };
    return (
        <div
            className="molten-review-ai flex h-full min-h-0 w-full flex-col gap-3 overflow-auto p-3 text-12"
            aria-label={t("review.ai.viewName")}
            data-testid="review-ai"
        >
            <AiStatus
                ai={ai}
                onRetry={() => fireAndForget(() => review.openAi())}
                onShowTerminal={focusTerminal}
                onStartWith={(agent) => fireAndForget(() => review.startSession(undefined, agent))}
            />
            <AskBox model={review} />
            <QuestionQueue model={review} />
            <section className="flex flex-col gap-2" data-slot="review-cards" aria-label={t("review.ai.cardsLabel")}>
                <BriefingCard review={review} ai={ai} />
            </section>
            <AnswersSection model={review} />
            <CommentsPanel model={review} />
            <div className="mt-auto text-11 text-muted" title={worktree.worktree?.worktree ?? worktree.error}>
                {worktree.state === "ready"
                    ? worktree.worktree.kind === "agent"
                        ? t("review.ai.worktreeAgent")
                        : t("review.ai.worktreeReview")
                    : worktree.state === "failed"
                      ? t("review.ai.worktreeFailed")
                      : t("review.ai.worktreePreparing")}
            </div>
        </div>
    );
}

function useNow(): number {
    const [now, setNow] = useState(() => Date.now());
    const panelId = usePanelBlockId();
    useEffect(
        () => everyInPanel(panelId, whileShown(ClockMs), () => setNow(Date.now()), "review-briefing-clock"),
        [panelId]
    );
    return now;
}

// waitingForBriefing: the agent was asked and has not answered since.
function waitingForBriefing(ask: ReviewBriefAsk, briefingAt: number): boolean {
    return ask.status === "asked" && (briefingAt == null || (ask.at != null && briefingAt < ask.at));
}

function BriefingCard({ review, ai }: { review: ReviewTabModel; ai: ReviewAiState }) {
    const t = useT();
    const briefing = useAtomValue(review.briefingAtom);
    const ask = useAtomValue(review.briefAskAtom);
    const head = useAtomValue(review.headAtom);
    const now = useNow();
    const running = ai.session != null;
    const waiting = running && waitingForBriefing(ask, briefing?.at);
    const askButton = (label: string) => (
        <button
            type="button"
            className={SecondaryButton}
            disabled={ask.status === "asking" || ai.status === "starting"}
            onClick={() => fireAndForget(() => review.askBriefing())}
            title={t("review.ai.askTitle")}
            data-testid="review-briefing-ask"
        >
            <i className="fa fa-solid fa-rotate text-11" />
            {label}
        </button>
    );
    const askNote =
        ask.status === "busy" ? (
            <p className="text-warning" data-testid="review-briefing-busy">
                {t("review.ai.busy", { message: ask.message || t("review.ai.agentBusy") })}
            </p>
        ) : ask.status === "typed" ? (
            <p className="text-warning" data-testid="review-briefing-typed">
                {ask.message}
            </p>
        ) : ask.status === "failed" ? (
            <p className="text-error">{ask.message || t("review.ai.askFailed")}</p>
        ) : null;
    // Links of the briefing that point into the PR open the file in the diff at the line; web links open as usual.
    const onClickCapture = (e: React.MouseEvent) => {
        const anchor = (e.target as HTMLElement).closest?.("a");
        const link = parseFileLink(anchor?.getAttribute("href"));
        if (link == null) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        review.revealFile(link);
    };
    if (briefing == null) {
        return (
            <article className="flex flex-col gap-2 rounded-6 border border-border p-2.5" data-testid="review-briefing">
                <div className="text-13 font-semibold">{t("review.ai.briefing")}</div>
                {waiting ? (
                    <p className="text-muted" data-testid="review-briefing-waiting">
                        {t("review.ai.reading", { agent: ai.session?.agentname ?? t("review.ai.yourAgent") })}
                    </p>
                ) : running ? (
                    <>
                        <p className="text-muted">{t("review.ai.noBriefing")}</p>
                        {askButton(t("review.ai.askBriefing"))}
                    </>
                ) : (
                    <p className="text-muted">{t("review.ai.briefingLater")}</p>
                )}
                {askNote}
            </article>
        );
    }
    const note = briefingNote(briefing, head, now);
    const stale = briefing.headoid && head && briefing.headoid !== head;
    return (
        <article className="flex flex-col gap-2 rounded-6 border border-border p-2.5" data-testid="review-briefing">
            <div className="flex items-center justify-between gap-2">
                <div className="text-13 font-semibold">{t("review.ai.briefing")}</div>
                <span
                    className={cn("text-11", stale ? "text-warning" : "text-muted")}
                    data-testid="review-briefing-note"
                >
                    {note}
                </span>
            </div>
            {waiting ? (
                <p className="text-muted" data-testid="review-briefing-waiting">
                    {t("review.ai.newBriefing")}
                </p>
            ) : null}
            {askNote}
            <div
                className={cn(
                    "min-w-0",
                    // A card in a narrow pane: section headings at the body's scale, without the document rules.
                    "[&_.heading]:!mt-3 [&_.heading]:!border-b-0 [&_.heading]:!pt-0 [&_.heading]:!pb-0 [&_.heading]:!text-13 [&_.heading]:!font-semibold"
                )}
                onClickCapture={onClickCapture}
                data-testid="review-briefing-body"
            >
                <Markdown
                    text={briefing.markdown}
                    scrollable={false}
                    fontSizeOverride={12}
                    fixedFontSizeOverride={11}
                />
            </div>
            {running && !waiting ? askButton(stale ? t("review.ai.briefNewHead") : t("review.ai.askAgain")) : null}
        </article>
    );
}

function AiStatus({
    ai,
    onRetry,
    onShowTerminal,
    onStartWith,
}: {
    ai: ReviewAiState;
    onRetry: () => void;
    onShowTerminal: () => void;
    onStartWith: (agent: string) => void;
}) {
    const t = useT();
    const agentName = ai.session?.agentname ?? t("review.ai.yourAgent");
    const waiting = ai.waiting ? (
        <p className="text-muted">
            <i className="fa fa-solid fa-hourglass-half mr-1.5 text-11" />
            {t(`review.ready.waiting.${ai.waiting}`, { agent: agentName })}
        </p>
    ) : null;
    switch (ai.status) {
        case "starting":
            return (
                <div className="flex flex-col gap-1.5">
                    <p className="text-muted">{t("review.ai.starting")}</p>
                    {waiting}
                </div>
            );
        case "running":
            return (
                <div className="flex flex-col gap-1.5">
                    <p>
                        {t("review.ai.running", { agent: agentName })}
                        {ai.session?.connected ? "" : " " + t("review.ai.toolsConnect")}
                    </p>
                    {waiting}
                    {ai.message ? <p className="text-warning">{ai.message}</p> : null}
                    <button type="button" className={SecondaryButton} onClick={onShowTerminal}>
                        <i className="fa fa-solid fa-terminal text-11" />
                        {t("review.ai.showTerminal")}
                    </button>
                </div>
            );
        case "noagent":
            return (
                <div className="flex flex-col gap-1.5">
                    <p className="text-muted">{ai.message}</p>
                    {(ai.installed ?? []).map((id) => (
                        <button
                            key={id}
                            type="button"
                            className={SecondaryButton}
                            onClick={() => onStartWith(id)}
                            data-testid={`review-ai-start-with-${id}`}
                        >
                            {t("review.ai.startWith", { agent: codingAgentName(id) })}
                        </button>
                    ))}
                </div>
            );
        case "failed":
            return (
                <div className="flex flex-col gap-1.5">
                    <p className="text-error">{ai.message || t("review.ai.startFailed")}</p>
                    <button type="button" className={SecondaryButton} onClick={onRetry}>
                        {t("review.ai.tryAgain")}
                    </button>
                </div>
            );
    }
    return (
        <div className="flex flex-col gap-1.5">
            <p className="text-muted">{t("review.ai.noSession")}</p>
            <button
                type="button"
                className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                onClick={onRetry}
                data-testid="review-ai-start"
            >
                {t("review.ai.startSession")}
                <MoltenWave />
            </button>
        </div>
    );
}
