// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The "In progress" band itself (FR-MC-024, #2188): one band across the full width above the cards, with one border and
// one row per run (the local build, the release in flight, any other run). The runs' actions and logs are on their rows;
// the Now card keeps one flat line for each. running-band.tsx loads this file when something runs.

import { cn, fireAndForget } from "@/util/util";
import { useMemo } from "react";
import { useLocale, useT } from "../i18n/i18n";
import { BuildRunRow } from "../mission/build-run-row";
import { latestRun } from "../mission/mission-model";
import { ReleaseFollowRow } from "../mission/release-run-row";
import { RunRow } from "../mission/run-row";
import { releaseBandRow, RowTone, workBandRow } from "../mission/run-row-model";
import { ProjectCardProps } from "./project-context";
import { bandWork, buildInBand } from "./running-band-model";
import { useNow } from "./use-now";

// The band's border and title take the heat of its hottest row: a failure first, then what waits for the developer.
const BandEdge: Record<RowTone, string> = {
    working: "border-[color-mix(in_srgb,var(--mt-state-running)_32%,var(--mt-line-1))]",
    waiting: "border-[color-mix(in_srgb,var(--mt-state-waiting)_36%,var(--mt-line-1))]",
    failed: "border-[color-mix(in_srgb,var(--mt-state-blocked)_40%,var(--mt-line-1))]",
};

const BandTitle: Record<RowTone, string> = {
    working: "text-[var(--mt-state-running)]",
    waiting: "text-[var(--mt-state-waiting)]",
    failed: "text-danger",
};

export function RunningBandView({
    pipeline,
    runs,
    ci,
    release,
    startBuild,
    snapshot,
    releaseFollow,
}: ProjectCardProps) {
    const t = useT();
    useLocale();
    const trunk = snapshot?.git?.trunk ?? "";
    const lastBuild = latestRun(runs, "build");
    const buildShown = buildInBand(lastBuild);
    const buildDef = (pipeline?.builds ?? []).find((b) => b.id === lastBuild?.stepid);
    const work = useMemo(
        () => bandWork(ci, runs, release, { pipelined: pipeline != null, trunk }),
        [ci, runs, release, pipeline, trunk]
    );
    const followed = releaseFollow?.run ?? null;
    const count = (buildShown ? 1 : 0) + (followed ? 1 : 0) + work.length;
    const now = useNow(count > 0);
    if (count === 0) {
        return null;
    }
    const tones: RowTone[] = [
        ...(buildShown ? [lastBuild.state === "running" ? "working" : "failed"] : []),
        ...(followed ? [releaseBandRow(followed, releaseFollow.jobs, releaseFollow.startedat).tone] : []),
        ...work.map(() => "working"),
    ] as RowTone[];
    const tone: RowTone = tones.includes("failed") ? "failed" : tones.includes("waiting") ? "waiting" : "working";
    return (
        <section
            aria-label={t("project.band.title")}
            className={cn("overflow-hidden rounded-6 border bg-panel", BandEdge[tone])}
            data-testid="project-band"
            data-tone={tone}
        >
            <header className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
                <h2 className={cn("text-11 font-semibold tracking-[0.14em] uppercase", BandTitle[tone])}>
                    {t("project.band.title")}
                </h2>
                <span className="text-13 text-muted tabular-nums" data-testid="project-band-count">
                    {count}
                </span>
                <span className="flex-1" />
                <span className="hidden text-12 text-muted @min-[42rem]:inline">{t("project.band.hint")}</span>
            </header>
            <div className="divide-y divide-border">
                {buildShown ? (
                    <BuildRunRow
                        key={lastBuild.id}
                        run={lastBuild}
                        phases={buildDef?.phases ?? []}
                        manifest={null}
                        runs={runs}
                        trunk={trunk}
                        now={now}
                        onRetry={() => fireAndForget(() => startBuild(lastBuild.stepid))}
                    />
                ) : null}
                {followed ? (
                    <div>
                        <ReleaseFollowRow follow={releaseFollow} now={now} />
                    </div>
                ) : null}
                {work.map((item) => (
                    <RunRow
                        key={item.id}
                        row={workBandRow(item)}
                        now={now}
                        phasesLabel=""
                        testId="project-work"
                        actions={null}
                    />
                ))}
            </div>
        </section>
    );
}
