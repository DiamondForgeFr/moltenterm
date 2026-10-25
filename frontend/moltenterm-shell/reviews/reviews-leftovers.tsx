// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's "Leftovers to clean up" group (#1088, FR-REV-022 AC14), right after Upcoming: a merged PR whose
// branch holds nothing new is no upcoming work, it is what the merge left (a worktree, an agent session, the branches).
// One quiet card per PR names each of them, the agent session with its state, and one Clean up removes them through
// the cleanup after a merge (FR-REV-013). What would lose something is confirmed first, by name.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { getApi } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { AgentStates } from "../agent-state-store";
import { DialogFrame } from "../dialog-frame";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { showPanel } from "../review/review-panels";
import { keptButtonLabel, lossLines, panelLines } from "../review/review-stepper";
import { CalmButton, MoltenButton, MoreButton, RailColours, SentenceClasses } from "./reviews-card";
import { LeftoverConfirm, LeftoversModel, LeftoverState } from "./reviews-leftovers-client";
import { agentText, leftoverKey, leftoverParts, leftoverRows } from "./reviews-leftovers-model";
import type { ReviewsAnswer } from "./reviews-model";
import { ReviewsFolds, sectionOpen } from "./reviews-order-store";
import { SectionHeading } from "./reviews-section-heading";
import { AgentBarFacts, branchAgents, UpcomingAnswer, UpcomingLeftover } from "./reviews-upcoming-model";

const DestructiveButton =
    "molten-btn molten-btn-destructive flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-6 px-2.5 text-12 disabled:cursor-default disabled:opacity-50";

const PartIcons: Record<string, string> = {
    worktree: "fa-folder",
    agent: "fa-terminal",
    local: "fa-code-branch",
    remote: "fa-cloud",
};

type Target = { dir: string; repo: string; leftover: UpcomingLeftover; agents: AgentBarFacts[] };

function prUrl(leftover: UpcomingLeftover, repoUrl: string): string {
    if (leftover.url) {
        return leftover.url;
    }
    return repoUrl ? `${repoUrl.replace(/\/$/, "")}/pull/${leftover.pr}` : "";
}

export function LeftoversSection({
    dir,
    reviews,
    upcoming,
    defaultOpen = true,
}: {
    dir: string;
    reviews: ReviewsAnswer;
    upcoming: UpcomingAnswer;
    defaultOpen?: boolean;
}) {
    const t = useT();
    const model = LeftoversModel.getInstance();
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const cleanup = useAtomValue(model.statesAtom);
    const all = useAtomValue(model.allAtom);
    const folds = useAtomValue(ReviewsFolds.getInstance().foldsAtom);
    const targets: Target[] = useMemo(() => {
        const at = upcoming?.at ?? 0;
        return leftoverRows(upcoming, reviews)
            .filter((leftover) => {
                // Cleaned up since wavesrv's answer: gone until it answers again.
                const cleanedAt = cleanup[leftoverKey(dir, leftover.pr)]?.cleanedAt ?? 0;
                return !(cleanedAt > 0 && at <= cleanedAt);
            })
            .map((leftover) => ({
                dir,
                repo: reviews?.repo,
                leftover,
                agents: branchAgents(upcoming, states, leftover.branch),
            }));
    }, [upcoming, reviews, states, cleanup, dir]);
    if (targets.length === 0 || !reviews?.repo) {
        return null;
    }
    const open = sectionOpen(folds, dir, "leftovers", defaultOpen);
    const confirming = targets.find((x) => cleanup[leftoverKey(dir, x.leftover.pr)]?.confirm != null);
    const anyBusy = targets.some((x) => cleanup[leftoverKey(dir, x.leftover.pr)]?.busy);
    return (
        <section className="flex flex-col gap-2" aria-label={t("reviewsAgents.leftovers.title")}>
            <SectionHeading
                title={t("reviewsAgents.leftovers.title")}
                count={targets.length}
                hint={t("reviewsAgents.leftovers.hint")}
                open={open}
                onToggle={() => ReviewsFolds.getInstance().set(dir, "leftovers", !open)}
                testId="reviews-leftovers-toggle"
            >
                {targets.length > 1 ? (
                    <button
                        type="button"
                        className={CalmButton}
                        disabled={anyBusy}
                        onClick={() => model.askAll(targets)}
                        data-testid="reviews-leftovers-all"
                    >
                        {t("reviewsAgents.leftovers.cleanAll")}
                    </button>
                ) : null}
            </SectionHeading>
            {open ? (
                <div
                    className="overflow-clip rounded-4 border border-border [overflow-clip-margin:1px]"
                    role="list"
                    data-testid="reviews-leftovers"
                >
                    {targets.map((target) => (
                        <LeftoverCard
                            key={target.leftover.branch}
                            target={target}
                            state={cleanup[leftoverKey(dir, target.leftover.pr)] ?? {}}
                            repoUrl={reviews?.url}
                        />
                    ))}
                </div>
            ) : null}
            {confirming != null ? (
                <ConfirmDialog
                    target={confirming}
                    confirm={cleanup[leftoverKey(dir, confirming.leftover.pr)].confirm}
                />
            ) : all != null ? (
                <AllDialog targets={all} />
            ) : null}
        </section>
    );
}

function LeftoverCard({ target, state, repoUrl }: { target: Target; state: LeftoverState; repoUrl: string }) {
    const t = useT();
    const { leftover, agents } = target;
    const model = LeftoversModel.getInstance();
    const parts = leftoverParts(t, leftover, agents);
    const url = prUrl(leftover, repoUrl);
    const panel = agents.find((a) => a.kind === "panel" && a.blockId);
    const openMenu = (e: React.MouseEvent) => {
        e.stopPropagation();
        const items: ContextMenuItem[] = [];
        if (url) {
            items.push({
                label: t("reviewsAgents.leftovers.openPr"),
                click: () => fireAndForget(() => openWebLink(url)),
            });
        }
        if (panel != null) {
            items.push({
                label: t("reviewsAgents.leftovers.showSession", { name: panel.name || t("reviews.card.anAgent") }),
                click: () => fireAndForget(() => showPanel(panel.blockId)),
            });
        }
        if (leftover.worktree) {
            items.push({
                label: t("review.validate.showFolder"),
                click: () => getApi().openNativePath(leftover.worktree),
            });
        }
        if (items.length === 0) {
            return;
        }
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };
    return (
        <div
            role="listitem"
            data-branch={leftover.branch}
            data-tone="wait"
            className="relative flex flex-col gap-1 border-b border-border py-2.5 pr-3 pl-[15px] last:border-b-0"
            data-testid="reviews-leftover"
        >
            <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: RailColours.wait }} aria-hidden />
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-1.5 text-13 leading-5 font-medium">
                        <span className="shrink-0 text-accent">#{leftover.pr}</span>
                        <span className="min-w-0 truncate" title={leftover.branch}>
                            {leftover.title || leftover.branch}
                        </span>
                    </div>
                    <div
                        className={cn("text-12 leading-4 font-medium", SentenceClasses.wait)}
                        data-testid="reviews-leftover-state"
                    >
                        {t("reviewsAgents.leftovers.state", { number: leftover.pr })}
                    </div>
                    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-11 leading-4 text-muted">
                        {parts.map((part, i) => (
                            <li
                                key={`${part.kind}-${i}`}
                                className="flex min-w-0 items-center gap-1"
                                title={part.title}
                                data-testid={`reviews-leftover-part-${part.kind}`}
                            >
                                <i className={cn("fa fa-solid text-10", PartIcons[part.kind])} aria-hidden />
                                <span className="min-w-0 truncate">{part.text}</span>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        className={cn(MoltenButton, "disabled:cursor-default disabled:opacity-60")}
                        disabled={state.busy}
                        onClick={() => fireAndForget(() => model.cleanUp(target))}
                        data-testid="reviews-leftover-clean"
                    >
                        {state.busy ? t("reviewsAgents.leftovers.cleaning") : t("reviewsAgents.leftovers.clean")}
                        <MoltenWave />
                    </button>
                    <button
                        type="button"
                        onClick={openMenu}
                        aria-haspopup="menu"
                        aria-label={t("reviewsAgents.leftovers.moreTitle", { number: leftover.pr })}
                        title={t("reviews.card.more")}
                        className={MoreButton}
                        data-testid="reviews-leftover-more"
                    >
                        <i className="fa fa-solid fa-ellipsis text-12" aria-hidden />
                    </button>
                </div>
            </div>
            {state.error ? (
                <div className="text-11 text-danger" data-testid="reviews-leftover-error">
                    {t("reviewsAgents.leftovers.failed", { error: state.error })}
                </div>
            ) : null}
            {(state.notes ?? []).map((note, i) => (
                <div key={i} className="text-11 text-secondary" data-testid="reviews-leftover-note">
                    {note}
                </div>
            ))}
        </div>
    );
}

// ConfirmDialog names what Clean up would lose before anything goes: the agents still at work, or what wavesrv kept
// the worktree for (uncommitted files, commits not in the PR, panels open in it).
function ConfirmDialog({ target, confirm }: { target: Target; confirm: LeftoverConfirm }) {
    const t = useT();
    const model = LeftoversModel.getInstance();
    const { leftover } = target;
    const cancel = () => model.cancel(target.dir, leftover.pr);
    const lines =
        confirm.kind === "busy"
            ? confirm.agents.map((a) => agentText(t, a))
            : [...panelLines(t, confirm.step.panels), ...lossLines(t, confirm.step.loss)];
    const label =
        confirm.kind === "busy" ? t("reviewsAgents.leftovers.confirm.stopAndClean") : keptButtonLabel(t, confirm.step);
    return (
        <DialogFrame
            role="reviews-leftover-confirm"
            title={t("reviewsAgents.leftovers.confirm.title", { number: leftover.pr })}
            subtitle={
                confirm.kind === "busy"
                    ? t("reviewsAgents.leftovers.confirm.busy", { branch: leftover.branch })
                    : t("reviewsAgents.leftovers.confirm.kept", { path: confirm.step.path ?? leftover.worktree ?? "" })
            }
            subtitleWraps
            onEscape={cancel}
            suite
            buttons={
                <>
                    <button type="button" className={CalmButton} onClick={cancel}>
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className={DestructiveButton}
                        onClick={() => fireAndForget(() => model.confirm(target))}
                        data-testid="reviews-leftover-confirm"
                    >
                        {label}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <ul
                className="flex list-disc flex-col gap-1 pt-3 pl-5 text-12 text-secondary"
                data-testid="reviews-leftover-lose"
            >
                {lines.map((line, i) => (
                    <li key={i}>{line}</li>
                ))}
            </ul>
        </DialogFrame>
    );
}

// AllDialog: Clean up all's one confirmation, listing every leftover and what goes with it.
function AllDialog({ targets }: { targets: Target[] }) {
    const t = useT();
    const tCount = useTCount();
    const model = LeftoversModel.getInstance();
    return (
        <DialogFrame
            role="reviews-leftovers-all"
            title={t("reviewsAgents.leftovers.all.title")}
            subtitle={t("reviewsAgents.leftovers.all.subtitle")}
            subtitleWraps
            onEscape={() => model.cancelAll()}
            suite
            buttons={
                <>
                    <button type="button" className={CalmButton} onClick={() => model.cancelAll()}>
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className={DestructiveButton}
                        onClick={() => fireAndForget(() => model.confirmAll())}
                        data-testid="reviews-leftovers-all-confirm"
                    >
                        {tCount("reviewsAgents.leftovers.all.button", targets.length)}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <ul className="flex flex-col gap-2 pt-3 text-12" data-testid="reviews-leftovers-all-list">
                {targets.map((target) => (
                    <li key={target.leftover.branch} className="flex flex-col gap-0.5">
                        <span className="font-medium text-primary">
                            #{target.leftover.pr} {target.leftover.title || target.leftover.branch}
                        </span>
                        <span className="text-11 text-secondary">
                            {leftoverParts(t, target.leftover, target.agents)
                                .map((p) => p.text)
                                .join(" · ")}
                        </span>
                    </li>
                ))}
            </ul>
        </DialogFrame>
    );
}
