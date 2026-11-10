// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The release in flight as a row of the overview's "In progress" band (FR-MC-016, FR-MC-024, #2188): its phases as a bar,
// where it is, and the phase picked unfolding under the row without a frame, open by itself while the release waits for
// the developer or failed. The phase's detail and its actions are release-run-panel.tsx's. It loads with the band, when
// a release is in flight.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { openWebLink } from "../open-web-link";
import type { ReleaseCiAwait } from "./branch-ci";
import { ReleasePhase } from "./mission-model";
import { PendingLock, PendingLockContext, usePendingLock } from "./pending-action";
import { ReleaseGhJob, ReleaseRun } from "./release-run";
import { Detail, PendingLabel, PlainButton, ReleaseFollow, ReleasePanelActions } from "./release-run-panel";
import { RowButtonClass, RowInsetClass, RunRow } from "./run-row";
import { releaseBandRow } from "./run-row-model";

export function ReleaseRunPanel({
    run,
    jobs,
    actions,
    onAbandon,
    awaits,
    lock,
    revision,
    now,
    startedat,
}: {
    run: ReleaseRun;
    jobs: ReleaseGhJob[];
    actions: ReleasePanelActions;
    // The branch CI a running step waits on (#836), shown with a link to the CI/CD panel.
    awaits?: ReleaseCiAwait;
    // Stops following it: the release launched from the Project tab ends, a tag cut at the terminal is no longer
    // followed.
    onAbandon?: () => Promise<void>;
    // The card's one-action-at-a-time lock (#952), when its owner also locks around it (the trust prompt).
    lock?: PendingLock;
    // Changes on each read of the release: a started step's button stays pending until then.
    revision?: unknown;
    // The clock of the band, and when the release started (0 when it is not known).
    now?: number;
    startedat?: number;
}) {
    const t = useT();
    const own = usePendingLock(revision);
    const cardLock = lock ?? own;
    const [picked, setPicked] = useState<ReleasePhase>(null);
    const [open, setOpen] = useState<boolean>(null);
    const [confirming, setConfirming] = useState(false);
    const [abandonError, setAbandonError] = useState<string>(null);
    const shown = run.phases.find((p) => p.id === (picked ?? run.current)) ?? run.phases[run.phases.length - 1];
    // What waits for the developer, or failed, unfolds by itself; the developer closes it when they want.
    const unfolded = open ?? (shown.status === "waiting" || shown.status === "failed");
    const locked = cardLock.pending !== "";
    const abandoning = cardLock.pending === "abandon";
    const link = run.phases.find((p) => p.id === run.current)?.links[0];
    const row = releaseBandRow(run, jobs, startedat ?? 0);
    const abandon = () =>
        fireAndForget(async () => {
            setAbandonError(null);
            try {
                await cardLock.run("abandon", onAbandon);
                setConfirming(false);
            } catch (e) {
                setAbandonError(serverErrorText(e));
            }
        });
    return (
        <PendingLockContext.Provider value={cardLock}>
            <RunRow
                row={row}
                now={now ?? Date.now()}
                testId="release-run"
                phasesLabel={t("mc.releaseRun.phasesLabel")}
                picked={shown.id}
                onPick={(id) => {
                    setPicked(id === picked ? null : (id as ReleasePhase));
                    setOpen(true);
                }}
                phaseTestIdPrefix="release-run-phase-"
                actions={
                    <>
                        {link ? (
                            <button
                                type="button"
                                onClick={() => fireAndForget(() => openWebLink(link.url))}
                                title={link.label}
                                className={RowButtonClass}
                                data-testid="release-run-github"
                            >
                                {t("project.band.seeOnGithub")}
                                <i className="fa fa-solid fa-arrow-up-right-from-square text-11" aria-hidden />
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => setOpen(!unfolded)}
                            aria-expanded={unfolded}
                            className={cn(RowButtonClass, unfolded && "bg-hover text-primary")}
                            data-testid="release-run-details"
                        >
                            {t("project.band.details")}
                            <i
                                className={cn("fa fa-solid text-11", unfolded ? "fa-chevron-up" : "fa-chevron-down")}
                                aria-hidden
                            />
                        </button>
                        {onAbandon && !confirming ? (
                            <button
                                type="button"
                                disabled={locked}
                                className="cursor-pointer rounded-4 px-2 py-1.5 text-12 text-muted hover:text-primary disabled:cursor-default disabled:opacity-50"
                                onClick={() => setConfirming(true)}
                                data-testid="release-run-abandon"
                            >
                                {t("mc.releaseRun.abandonRelease")}
                            </button>
                        ) : null}
                    </>
                }
                extra={
                    abandonError ? (
                        <p className="mt-2 mr-4 text-right text-12 text-danger" role="alert">
                            {abandonError}
                        </p>
                    ) : null
                }
            >
                {confirming ? (
                    <div className={cn("mt-3 flex flex-wrap items-center justify-end gap-2 text-12", RowInsetClass)}>
                        <span className="mr-auto text-muted">{t("mc.releaseRun.stopFollowing", { tag: run.tag })}</span>
                        <button
                            type="button"
                            disabled={locked}
                            className={PlainButton}
                            onClick={() => setConfirming(false)}
                        >
                            {t("mc.releaseRun.no")}
                        </button>
                        <button
                            type="button"
                            disabled={locked}
                            aria-busy={abandoning}
                            className="inline-flex cursor-pointer items-center rounded-4 border border-error/50 px-2.5 py-1 text-12 text-danger hover:bg-error/10 disabled:cursor-default disabled:opacity-50"
                            onClick={abandon}
                            data-testid="release-run-abandon-yes"
                        >
                            <PendingLabel
                                busy={abandoning}
                                label={t("mc.releaseRun.pending.abandoning")}
                                idle={t("mc.releaseRun.abandon")}
                            />
                        </button>
                    </div>
                ) : null}
                {unfolded ? (
                    <div className={cn("mt-3", RowInsetClass)}>
                        <Detail run={run} phase={shown} jobs={jobs} actions={actions} awaits={awaits} />
                    </div>
                ) : null}
            </RunRow>
        </PendingLockContext.Provider>
    );
}

// The release followed, as a row of the band, with the prompt that asks to trust its commands and the error of a step
// that did not start.
export function ReleaseFollowRow({ follow, now }: { follow: ReleaseFollow; now: number }) {
    if (follow.run == null) {
        return null;
    }
    return (
        <>
            <ReleaseRunPanel
                run={follow.run}
                jobs={follow.jobs}
                actions={follow.actions}
                onAbandon={follow.abandon}
                awaits={follow.awaits}
                lock={follow.lock}
                now={now}
                startedat={follow.startedat}
            />
            {follow.error ? (
                <p className="mx-4 text-12 text-danger" role="alert">
                    {follow.error}
                </p>
            ) : null}
            {follow.prompt}
        </>
    );
}
