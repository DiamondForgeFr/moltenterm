// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the releases stand, first ported from Notulia (src/components/dev/ReleaseStatePanel.tsx), now two of the
// Project overview's cards (FR-MC-024): Next public release (what waits on the trunk for it, by kind, and how far its
// milestone has come) and Releases (the last release candidate with its notes, the last public release). What they
// show is computed in ../project/overview-cards-model.ts; motion is CSS only and stops under reduced motion
// (NFR-MC-004).

import { cn } from "@/util/util";
import { formatWhen, NextReleaseView, ReleaseBar, ReleasesView, ReleaseView } from "../project/overview-cards-model";

const BarClasses: Record<ReleaseBar["key"], string> = {
    feat: "bg-[var(--mt-chart-features)]",
    fix: "bg-[var(--mt-chart-fixes)]",
    other: "bg-[var(--mt-chart-rest)]",
};

export function daysSince(iso: string, now = Date.now()): string {
    const days = Math.round((now - new Date(iso).getTime()) / 86_400_000);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function Bar({ bar, index }: { bar: ReleaseBar; index: number }) {
    return (
        <div className="flex items-center gap-2.5 text-[13px]" data-testid={`release-bar-${bar.key}`}>
            <span className="w-16 shrink-0 text-secondary">{bar.label}</span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
                <div
                    className={cn("molten-bar h-full rounded-full", BarClasses[bar.key])}
                    style={{ width: `${Math.round(bar.share * 100)}%`, animationDelay: `${index * 100}ms` }}
                />
            </div>
            <span className="w-6 shrink-0 text-right font-mono text-xs text-primary tabular-nums">{bar.count}</span>
        </div>
    );
}

function Waiting({ rows }: { rows: number }) {
    return (
        <div className="flex flex-col gap-2" aria-busy="true">
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="h-5 w-full animate-pulse rounded bg-hover motion-reduce:animate-none" />
            ))}
        </div>
    );
}

export function NextPublicRelease({ view }: { view: NextReleaseView }) {
    if (view == null) {
        return <Waiting rows={3} />;
    }
    const { milestone } = view;
    return (
        <div className="flex h-full flex-col gap-3" data-testid="release-next">
            <div className="flex flex-col gap-2">
                {view.bars.map((bar, i) => (
                    <Bar key={bar.key} bar={bar} index={i} />
                ))}
                <p className="text-[11px] text-muted">
                    <span className="font-mono text-secondary tabular-nums" data-testid="release-pending">
                        {view.total}
                    </span>{" "}
                    {view.total === 1 ? "change" : "changes"} {view.scope} ·{" "}
                    <span className="text-secondary" data-testid="release-next-version">
                        {view.caption}
                    </span>
                </p>
            </div>
            <div className="mt-auto" data-testid="release-milestone">
                {milestone ? (
                    <div
                        className="flex items-center gap-2 text-xs text-secondary"
                        title={`${milestone.closed} closed, ${milestone.open} open`}
                    >
                        <span className="max-w-[45%] shrink-0 truncate">Milestone {milestone.title}</span>
                        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
                            <div
                                className="molten-bar h-full rounded-full bg-success"
                                style={{ width: `${milestone.percent}%`, animationDelay: "300ms" }}
                            />
                        </div>
                        <span className="shrink-0 font-mono text-[11px] whitespace-nowrap tabular-nums">
                            {milestone.percent} % · {milestone.open} open
                        </span>
                    </div>
                ) : (
                    <p className="text-[11px] text-muted">{view.milestoneNote}</p>
                )}
            </div>
        </div>
    );
}

function ReleaseTitle({ release }: { release: ReleaseView }) {
    return (
        <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="min-w-0 truncate text-2xl leading-tight font-semibold tracking-tight text-primary">
                {release.tag}
            </span>
            {release.date ? (
                <span className="shrink-0 text-xs text-muted" title={formatWhen(release.date)}>
                    {daysSince(release.date)}
                </span>
            ) : null}
        </div>
    );
}

export function ReleaseHistory({ view }: { view: ReleasesView }) {
    if (view == null) {
        return <Waiting rows={2} />;
    }
    return (
        <div className="flex flex-col gap-3" data-testid="release-history">
            <div className="flex flex-col gap-1" data-testid="release-rc">
                <span className="text-xs text-muted">Last release candidate</span>
                {view.rc ? (
                    <>
                        <ReleaseTitle release={view.rc} />
                        {view.rc.excerpt ? (
                            <p className="line-clamp-3 text-[13px] leading-snug whitespace-pre-line text-secondary">
                                {view.rc.excerpt}
                            </p>
                        ) : (
                            <p className="text-xs text-muted">No notes found for this tag.</p>
                        )}
                    </>
                ) : (
                    <p className="text-[13px] text-secondary">No release candidate yet.</p>
                )}
            </div>
            <div className="h-px bg-border" />
            <div className="flex flex-col gap-1" data-testid="release-public">
                <span className="text-xs text-muted">Last public release</span>
                {view.public ? (
                    <ReleaseTitle release={view.public} />
                ) : (
                    <p className="text-[13px]">
                        <span className="font-semibold text-primary">None yet.</span>{" "}
                        <span className="text-secondary">{view.firstPublic}</span>
                    </p>
                )}
            </div>
        </div>
    );
}
