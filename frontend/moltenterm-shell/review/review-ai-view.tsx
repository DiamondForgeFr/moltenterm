// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's AI panel (DS-REV-012): a pane right of the review block, with the review session's terminal split
// under it, so the cards the agent posts sit above the agent's own terminal. It shows the session's state and the PR's
// briefing (FR-REV-005): what changed, why, the risks and the files to look at first (links that open the file in the
// diff at the line), what was tested and its gaps. The briefing is kept in the review store and shown again when the
// PR is reopened. Its markdown is the agent's: rendered, never executed.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { Markdown } from "@/app/element/markdown";
import * as WOS from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { EmptyState } from "../empty-state";
import { MoltenWave } from "../molten-button";
import { TabActivity, whileShown } from "../tab-activity";
import { ReviewPrInfo, ReviewPrMetaKey } from "./review-client";
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
            return pr ? `AI panel · #${pr.number}` : "AI panel";
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
    const pr = useAtomValue(model.prAtom);
    const review = useAtomValue(model.reviewAtom);
    if (pr == null) {
        return <EmptyState icon="sparkles" title="No pull request" hint="Open the AI panel from a Review tab." />;
    }
    if (review == null) {
        return (
            <EmptyState
                icon="code-pull-request"
                title={`The review of #${pr.number} is not open`}
                hint="Open the pull request's Review tab from the Reviews view: the AI panel follows it."
            />
        );
    }
    return <AiPanel review={review} />;
}

function AiPanel({ review }: { review: ReviewTabModel }) {
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
            className="flex h-full min-h-0 w-full flex-col gap-3 overflow-auto p-3 text-12"
            aria-label="AI panel"
            data-testid="review-ai"
        >
            <AiStatus ai={ai} onRetry={() => fireAndForget(() => review.openAi())} onShowTerminal={focusTerminal} />
            <section className="flex flex-col gap-2" data-slot="review-cards" aria-label="Briefing and explanations">
                <BriefingCard review={review} ai={ai} />
            </section>
            <div className="mt-auto text-11 text-muted" title={worktree.worktree?.worktree ?? worktree.error}>
                {worktree.state === "ready"
                    ? `Worktree: ${worktree.worktree.kind === "agent" ? "the agent's" : "MoltenTerm's review copy"}`
                    : worktree.state === "failed"
                      ? "The review worktree could not be prepared."
                      : "Preparing the review worktree…"}
            </div>
        </div>
    );
}

function useNow(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(
        () => TabActivity.getInstance().every(whileShown(ClockMs), () => setNow(Date.now()), "review-briefing-clock"),
        []
    );
    return now;
}

// waitingForBriefing: the agent was asked and has not answered since.
function waitingForBriefing(ask: ReviewBriefAsk, briefingAt: number): boolean {
    return ask.status === "asked" && (briefingAt == null || (ask.at != null && briefingAt < ask.at));
}

function BriefingCard({ review, ai }: { review: ReviewTabModel; ai: ReviewAiState }) {
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
            title="Ask your agent for a new briefing of the PR's head"
            data-testid="review-briefing-ask"
        >
            <i className="fa fa-solid fa-rotate text-11" />
            {label}
        </button>
    );
    const askNote =
        ask.status === "busy" ? (
            <p className="text-warning" data-testid="review-briefing-busy">
                {ask.message || "Your agent is busy."} Ask again once it is idle.
            </p>
        ) : ask.status === "typed" ? (
            <p className="text-warning" data-testid="review-briefing-typed">
                {ask.message}
            </p>
        ) : ask.status === "failed" ? (
            <p className="text-error">{ask.message || "The briefing could not be asked for."}</p>
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
                <div className="text-13 font-semibold">Briefing</div>
                {waiting ? (
                    <p className="text-muted" data-testid="review-briefing-waiting">
                        {ai.session?.agentname ?? "Your agent"} is reading the PR, its ticket, the plan and the test
                        report; the briefing shows here.
                    </p>
                ) : running ? (
                    <>
                        <p className="text-muted">No briefing yet.</p>
                        {askButton("Ask for a briefing")}
                    </>
                ) : (
                    <p className="text-muted">The briefing comes from your agent once its session runs.</p>
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
                <div className="text-13 font-semibold">Briefing</div>
                <span
                    className={cn("text-11", stale ? "text-warning" : "text-muted")}
                    data-testid="review-briefing-note"
                >
                    {note}
                </span>
            </div>
            {waiting ? (
                <p className="text-muted" data-testid="review-briefing-waiting">
                    A new briefing is on its way.
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
            {running && !waiting ? askButton(stale ? "Brief the new head" : "Ask again") : null}
        </article>
    );
}

function AiStatus({
    ai,
    onRetry,
    onShowTerminal,
}: {
    ai: ReviewAiState;
    onRetry: () => void;
    onShowTerminal: () => void;
}) {
    switch (ai.status) {
        case "starting":
            return <p className="text-muted">Starting your agent in the PR's worktree…</p>;
        case "running":
            return (
                <div className="flex flex-col gap-1.5">
                    <p>
                        {ai.session?.agentname ?? "Your agent"} reviews this PR, read-only, in the terminal under this
                        panel.
                        {ai.session?.connected ? "" : " Its review tools connect when it starts."}
                    </p>
                    {ai.message ? <p className="text-warning">{ai.message}</p> : null}
                    <button type="button" className={SecondaryButton} onClick={onShowTerminal}>
                        <i className="fa fa-solid fa-terminal text-11" />
                        Show its terminal
                    </button>
                </div>
            );
        case "noagent":
            return <p className="text-muted">{ai.message}</p>;
        case "failed":
            return (
                <div className="flex flex-col gap-1.5">
                    <p className="text-error">{ai.message || "The review session could not start."}</p>
                    <button type="button" className={SecondaryButton} onClick={onRetry}>
                        Try again
                    </button>
                </div>
            );
    }
    return (
        <div className="flex flex-col gap-1.5">
            <p className="text-muted">No review session runs for this PR.</p>
            <button
                type="button"
                className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                onClick={onRetry}
                data-testid="review-ai-start"
            >
                Start the review session
                <MoltenWave />
            </button>
        </div>
    );
}
