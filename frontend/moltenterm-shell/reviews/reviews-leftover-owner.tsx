// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The card of a leftover whose owner was asked to remove its worktree (#1143, FR-REV-022 AC16), in the PR section of
// whose turn it is: the PR card's rail, state line and primary button (reviews-card.tsx CardStateLine and
// CardPrimaryButton, reviews-card-model.ts states "agent-working" and "agent-waiting"), so "Answer {name}" here is the
// same call to action as on a PR whose agent waits for the developer, and goes to the same terminal.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { getApi } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useLocale, useT } from "../i18n/i18n";
import { useWordPhrase } from "../i18n/phrase";
import { dateLocale } from "../mission/time-format";
import { openWebLink } from "../open-web-link";
import { showPanel } from "../review/review-panels";
import { agentActionTitle, CardPrimaryButton, CardStateLine, MoreButton, RailColours } from "./reviews-card";
import { leftoverOwnerCard, LeftoverTurnRow, ownerName } from "./reviews-leftover-owner-model";
import { LeftoversModel } from "./reviews-leftovers-client";
import { leftoverKey, leftoverState } from "./reviews-leftovers-model";

function askedTime(at: number): string {
    if (!at) {
        return "";
    }
    return new Intl.DateTimeFormat(dateLocale(), { timeStyle: "short" }).format(new Date(at));
}

function folderName(path: string): string {
    const parts = (path ?? "").split(/[\\/]/).filter((p) => !!p);
    return parts[parts.length - 1] ?? path;
}

export function LeftoverOwnerCard({
    dir,
    row,
    repoUrl,
    filled,
}: {
    dir: string;
    row: LeftoverTurnRow;
    repoUrl: string;
    // Whether the panel gives this card its one filled button (#1351, filledAction); alone, the card's own state says.
    filled?: boolean;
}) {
    const t = useT();
    useLocale();
    const word = useWordPhrase();
    const cleanup = useAtomValue(LeftoversModel.getInstance().statesAtom);
    const { leftover, ask } = row;
    const card = useMemo(() => leftoverOwnerCard(ask, askedTime(ask?.askedat)), [ask]);
    if (card == null) {
        return null;
    }
    const state = cleanup[leftoverKey(dir, leftover.pr)] ?? {};
    const name = ownerName(ask.owner);
    const sentence = word(card.sentence);
    const why = word(card.why);
    const url = leftover.url || (repoUrl ? `${repoUrl.replace(/\/$/, "")}/pull/${leftover.pr}` : "");
    const openMenu = (e: React.MouseEvent) => {
        e.stopPropagation();
        const items: ContextMenuItem[] = [];
        if (url) {
            items.push({
                label: t("reviewsAgents.leftovers.openPr"),
                click: () => fireAndForget(() => openWebLink(url)),
            });
        }
        if (leftover.worktree) {
            items.push({
                label: t("review.validate.showFolder"),
                click: () => getApi().openNativePath(leftover.worktree),
            });
        }
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };
    return (
        <div
            role="listitem"
            data-branch={leftover.branch}
            data-state={card.kind}
            data-tone={card.tone}
            data-turn={card.turn}
            className="relative flex flex-col gap-1 border-b border-border py-2.5 pr-3 pl-[15px] last:border-b-0"
            data-testid="reviews-leftover-owner"
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
                        <span className="shrink-0 text-muted">#{leftover.pr}</span>
                        <span className="min-w-0 truncate" title={leftover.branch}>
                            {leftover.title || leftover.branch}
                        </span>
                    </div>
                    <CardStateLine
                        tone={card.tone}
                        sentence={sentence}
                        why={why}
                        working={card.kind === "agent-working"}
                    />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-11 leading-4 text-muted">
                        <span className="min-w-0 truncate" title={leftover.worktree}>
                            {leftoverState(t, leftover)} ·{" "}
                            {t("reviewsAgents.leftovers.part.worktree", { folder: folderName(leftover.worktree) })}
                        </span>
                    </div>
                    <div className="text-11 leading-4 text-muted" data-testid="reviews-card-history">
                        {word(card.history)}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <CardPrimaryButton
                        primary={card.primary}
                        molten={card.molten && filled !== false}
                        title={word(agentActionTitle(card.primary, name))}
                        busy={false}
                        onRun={() => fireAndForget(() => showPanel(card.primary.blockId))}
                    />
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
