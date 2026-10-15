// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's Upcoming section (#712, FR-REV-022-AC1), between Drafts and Notes: the ticket branches with
// commits and no PR yet, each with its ticket, branch, commits ahead and board status, and the bar of the agent on it.
// A tile opens the agent when one works on it, else the ticket. A branch leaves as soon as its PR is listed.

import { cn, fireAndForget } from "@/util/util";
import { useMemo, useState } from "react";
import { useT } from "../i18n/i18n";
import { openWebLink } from "../open-web-link";
import { showPanel } from "../review/review-panels";
import { AgentBar, useBranchAgent } from "./reviews-agent-bar";
import type { ReviewsAnswer } from "./reviews-model";
import { useUpcomingAnswer, useUpcomingWatch } from "./reviews-upcoming-client";
import { aheadText, boardStatusText, UpcomingBranch, upcomingRows } from "./reviews-upcoming-model";

const Chip = "inline-flex items-center gap-1 rounded-3 border px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap";

function ticketUrl(branch: UpcomingBranch, repoUrl: string): string {
    if (branch.url) {
        return branch.url;
    }
    return repoUrl && branch.ticket > 0 ? `${repoUrl.replace(/\/$/, "")}/issues/${branch.ticket}` : "";
}

export function UpcomingSection({ dir, reviews }: { dir: string; reviews: ReviewsAnswer }) {
    const t = useT();
    useUpcomingWatch(dir, reviews);
    const upcoming = useUpcomingAnswer(dir);
    const [open, setOpen] = useState(true);
    const rows = useMemo(() => upcomingRows(upcoming, reviews), [upcoming, reviews]);
    return (
        <section className="flex flex-col gap-2" aria-label={t("reviewsAgents.upcoming.title")}>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="flex w-fit cursor-pointer items-center gap-1.5 rounded-4 text-13 leading-5 font-semibold hover:text-primary"
                data-testid="reviews-upcoming-toggle"
            >
                <i
                    className={cn(
                        "fa fa-solid fa-chevron-right text-11 text-muted transition-transform duration-120 ease-mt",
                        open && "rotate-90"
                    )}
                    aria-hidden
                />
                {t("reviewsAgents.upcoming.title")}
                <span className="ml-0.5 text-12 font-normal text-muted">{upcoming == null ? "" : rows.length}</span>
            </button>
            {!open ? null : upcoming == null ? null : rows.length === 0 ? (
                <p
                    className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted"
                    data-testid="reviews-upcoming-empty"
                    title={upcoming.error || undefined}
                >
                    {t("reviewsAgents.upcoming.none")}
                </p>
            ) : (
                <div
                    className="overflow-hidden rounded-4 border border-border"
                    role="list"
                    data-testid="reviews-upcoming"
                >
                    {rows.map((branch) => (
                        <UpcomingRow key={branch.branch} dir={dir} branch={branch} repoUrl={reviews?.url} />
                    ))}
                </div>
            )}
            {open && upcoming?.ticketserror ? (
                <div className="text-11 text-muted" title={upcoming.ticketserror}>
                    {t("reviewsAgents.upcoming.ticketsError")}
                </div>
            ) : null}
        </section>
    );
}

function UpcomingRow({ dir, branch, repoUrl }: { dir: string; branch: UpcomingBranch; repoUrl: string }) {
    const t = useT();
    const agent = useBranchAgent(dir, branch.branch);
    const url = ticketUrl(branch, repoUrl);
    const goesToAgent = agent?.kind === "panel" && !!agent.blockId;
    const open = () => {
        if (goesToAgent) {
            fireAndForget(() => showPanel(agent.blockId));
            return;
        }
        if (url) {
            fireAndForget(() => openWebLink(url));
        }
    };
    return (
        <div
            role="listitem"
            tabIndex={0}
            data-branch={branch.branch}
            onClick={open}
            onKeyDown={(e) => {
                if (e.key !== "Enter") {
                    return;
                }
                e.preventDefault();
                open();
            }}
            className="flex cursor-pointer flex-col gap-1.5 border-b border-border px-3 py-2.5 outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover"
            title={goesToAgent ? t("reviewsAgents.upcoming.openAgent") : t("reviewsAgents.upcoming.openTicket")}
            data-testid="reviews-upcoming-row"
        >
            <div className="min-w-0">
                <div className="truncate text-13 leading-5 font-medium">
                    <span className="mr-1.5 text-accent">#{branch.ticket}</span>
                    {branch.title || branch.branch}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-12 text-muted">
                    <code className="truncate">{branch.branch}</code>
                    <span aria-hidden>·</span>
                    <span>{aheadText(t, branch.ahead)}</span>
                    {branch.remote ? (
                        <>
                            <span aria-hidden>·</span>
                            <span>{t("reviewsAgents.upcoming.remote")}</span>
                        </>
                    ) : null}
                    {branch.status ? (
                        <span
                            className={cn(Chip, "ml-0.5 border-border bg-hover text-secondary")}
                            title={t("reviewsAgents.upcoming.statusTitle")}
                            data-testid="reviews-upcoming-status"
                        >
                            {boardStatusText(t, branch.status)}
                        </span>
                    ) : null}
                </div>
            </div>
            <AgentBar facts={agent} />
        </div>
    );
}
