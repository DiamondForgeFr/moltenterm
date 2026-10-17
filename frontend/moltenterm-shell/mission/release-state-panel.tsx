// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the releases stand, first ported from Notulia (src/components/dev/ReleaseStatePanel.tsx), now two of the
// Project overview's cards (FR-MC-024): Next public release (what waits on the trunk for it, by kind, and how far its
// milestone has come) and Releases (the last release candidate with its notes, the last public release). What they
// show is computed in ../project/overview-cards-model.ts; motion is CSS only and stops under reduced motion
// (NFR-MC-004).

import { cn } from "@/util/util";
import { t, useT } from "../i18n/i18n";
import { formatWhen, NextReleaseView, ReleaseBar, ReleasesView, ReleaseView } from "../project/overview-cards-model";

const BarClasses: Record<ReleaseBar["key"], string> = {
    feat: "bg-[var(--mt-chart-features)]",
    fix: "bg-[var(--mt-chart-fixes)]",
    other: "bg-[var(--mt-chart-rest)]",
};

// The label column is as wide as the longest label in any language, so every bar starts at the same x; the 50% cap
// keeps room for the bars on a narrow card, where a longer label truncates instead of running under its bar.
export const BarGridColumns = "grid-cols-[fit-content(50%)_minmax(0,1fr)_auto]";

export function daysSince(iso: string, now = Date.now()): string {
    const days = Math.round((now - new Date(iso).getTime()) / 86_400_000);
    return days <= 0 ? t("mc.time.today") : days === 1 ? t("mc.time.yesterday") : t("mc.time.daysAgo", { days });
}

function Bar({ bar, index }: { bar: ReleaseBar; index: number }) {
    return (
        <div className="col-span-3 grid grid-cols-subgrid items-center text-13" data-testid={`release-bar-${bar.key}`}>
            <span className="min-w-0 truncate text-secondary" title={bar.label}>
                {bar.label}
            </span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
                <div
                    className={cn("molten-bar h-full rounded-full", BarClasses[bar.key])}
                    style={{ width: `${Math.round(bar.share * 100)}%`, animationDelay: `${index * 100}ms` }}
                />
            </div>
            <span className="min-w-6 text-right font-mono text-12 text-primary tabular-nums">{bar.count}</span>
        </div>
    );
}

function Waiting({ rows }: { rows: number }) {
    return (
        <div className="flex flex-col gap-2" aria-busy="true">
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="h-5 w-full mt-step-blink rounded-4 bg-hover" />
            ))}
        </div>
    );
}

export function NextPublicRelease({ view }: { view: NextReleaseView }) {
    const t = useT();
    if (view == null) {
        return <Waiting rows={3} />;
    }
    const { milestone } = view;
    return (
        <div className="flex h-full flex-col gap-3" data-testid="release-next">
            <div className="flex flex-col gap-2">
                <div className={cn("grid gap-x-2.5 gap-y-2", BarGridColumns)} data-testid="release-bars">
                    {view.bars.map((bar, i) => (
                        <Bar key={bar.key} bar={bar} index={i} />
                    ))}
                </div>
                <p className="text-11 text-muted">
                    <span className="font-mono text-secondary tabular-nums" data-testid="release-pending">
                        {view.total}
                    </span>{" "}
                    {view.total === 1 ? t("mc.release.change") : t("mc.release.changes")} {view.scope}{" "}
                </p>
            </div>
            <div className="mt-auto" data-testid="release-milestone">
                {milestone ? (
                    <div
                        className="flex items-center gap-2 text-12 text-secondary"
                        title={t("mc.release.milestoneCounts", { closed: milestone.closed, open: milestone.open })}
                    >
                        <span className="max-w-[45%] shrink-0 truncate">
                            {t("mc.release.milestone", { title: milestone.title })}
                        </span>
                        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
                            <div
                                className="molten-bar h-full rounded-full bg-success"
                                style={{ width: `${milestone.percent}%`, animationDelay: "300ms" }}
                            />
                        </div>
                        <span className="shrink-0 font-mono text-11 whitespace-nowrap tabular-nums">
                            {t("mc.release.milestonePercent", { percent: milestone.percent, open: milestone.open })}
                        </span>
                    </div>
                ) : (
                    <p className="text-11 text-muted">{view.milestoneNote}</p>
                )}
            </div>
        </div>
    );
}

function ReleaseTitle({ release }: { release: ReleaseView }) {
    return (
        <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="min-w-0 truncate text-20 leading-tight font-semibold tracking-tight text-primary">
                {release.tag}
            </span>
            {release.date ? (
                <span className="shrink-0 text-12 text-muted" title={formatWhen(release.date)}>
                    {daysSince(release.date)}
                </span>
            ) : null}
        </div>
    );
}

export function ReleaseHistory({ view }: { view: ReleasesView }) {
    const t = useT();
    if (view == null) {
        return <Waiting rows={2} />;
    }
    return (
        <div className="flex flex-col gap-3" data-testid="release-history">
            <div className="flex flex-col gap-1" data-testid="release-rc">
                <span className="text-12 text-muted">{t("mc.release.lastRc")}</span>
                {view.rc ? (
                    <>
                        <ReleaseTitle release={view.rc} />
                        {view.rc.excerpt ? (
                            <p className="line-clamp-3 text-13 leading-snug whitespace-pre-line text-secondary">
                                {view.rc.excerpt}
                            </p>
                        ) : (
                            <p className="text-12 text-muted">{t("mc.release.noNotes")}</p>
                        )}
                    </>
                ) : (
                    <p className="text-13 text-secondary">{t("mc.release.noRc")}</p>
                )}
            </div>
            <div className="h-px bg-border" />
            <div className="flex flex-col gap-1" data-testid="release-public">
                <span className="text-12 text-muted">{t("mc.release.lastPublic")}</span>
                {view.public ? (
                    <ReleaseTitle release={view.public} />
                ) : (
                    <p className="text-13">
                        <span className="font-semibold text-primary">{t("mc.release.noneYet")}</span>{" "}
                        <span className="text-secondary">{view.firstPublic}</span>
                    </p>
                )}
            </div>
        </div>
    );
}
