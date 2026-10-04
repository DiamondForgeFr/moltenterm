// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the releases stand, beside the tree (FR-MC-002), ported from Notulia (src/components/dev/ReleaseStatePanel.tsx):
// the next public release (a decision for the first, derived from conventional commits after that), what waits on the
// trunk for it, how far the milestone has come, the last release candidate and the last public release.

import { cn } from "@/util/util";
import { useEffect, useState } from "react";
import { Milestone, plainText } from "./github";
import { readableSubject, ReleaseState } from "./versions";

function reducedMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// A number that counts up to `to` once, when it arrives.
function useCountUp(to: number, ms = 900): number {
    const [value, setValue] = useState(reducedMotion() ? to : 0);
    useEffect(() => {
        if (reducedMotion()) {
            setValue(to);
            return;
        }
        let frame = 0;
        const start = performance.now();
        const tick = (now: number) => {
            const t = Math.min(1, (now - start) / ms);
            setValue(Math.round(to * (1 - Math.pow(1 - t, 3))));
            if (t < 1) {
                frame = requestAnimationFrame(tick);
            }
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [to, ms]);
    return value;
}

export function daysSince(iso: string, now = Date.now()): string {
    const days = Math.round((now - new Date(iso).getTime()) / 86_400_000);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function Card({
    icon,
    eyebrow,
    children,
    accent,
    testId,
}: {
    icon: string;
    eyebrow: string;
    children: React.ReactNode;
    accent?: boolean;
    testId: string;
}) {
    return (
        <section
            data-testid={testId}
            className={cn(
                "rounded border p-3",
                accent ? "border-accent/40 bg-linear-to-br from-accent/10 to-transparent" : "border-border bg-panel"
            )}
        >
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
                <i className={cn("fa fa-solid", `fa-${icon}`, accent && "text-accent")} />
                {eyebrow}
            </div>
            {children}
        </section>
    );
}

function Bar({ label, value, total, className }: { label: string; value: number; total: number; className: string }) {
    const target = (value / Math.max(total, 1)) * 100;
    const [width, setWidth] = useState(reducedMotion() ? target : 0);
    useEffect(() => {
        const id = requestAnimationFrame(() => setWidth(target));
        return () => cancelAnimationFrame(id);
    }, [target]);
    return (
        <div className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 text-muted">{label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-hover">
                <div
                    className={cn("h-full rounded transition-[width] duration-1000 ease-out", className)}
                    style={{ width: `${width}%` }}
                />
            </div>
            <span className="w-8 text-right tabular-nums">{value}</span>
        </div>
    );
}

export function ReleaseStatePanel({
    state,
    milestones,
    trunk,
    release,
    tagPrefix = "v",
}: {
    state: ReleaseState;
    milestones: Milestone[];
    trunk: string;
    release: string;
    tagPrefix?: string;
}) {
    const pending = useCountUp(state?.pending.total ?? 0);
    const milestone = milestones?.[0] ?? null;
    const done = milestone ? milestone.closed_issues / Math.max(1, milestone.closed_issues + milestone.open_issues) : 0;
    const percent = useCountUp(Math.round(done * 100));
    if (!state) {
        return (
            <div className="flex flex-col gap-3" aria-busy="true">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="h-24 w-full animate-pulse rounded bg-hover" />
                ))}
            </div>
        );
    }
    const { next, lastRc, lastPublic } = state;
    const singleBranch = trunk === release;
    return (
        <div className="flex flex-col gap-3" data-testid="release-state">
            <Card icon="rocket" eyebrow="Next public release" accent testId="release-next">
                <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-semibold tracking-tight">
                        {next.version ? `${tagPrefix}${next.version}` : "—"}
                    </span>
                    <span
                        className={cn(
                            "rounded px-2 py-0.5 text-[11px] font-medium",
                            next.how === "decision" && "bg-warning/15 text-warning",
                            next.how === "derived" && "bg-accent/15 text-accent",
                            next.how === "nothing" && "bg-hover text-muted"
                        )}
                    >
                        {next.how === "decision"
                            ? "to decide"
                            : next.how === "derived"
                              ? `derived · ${next.level}`
                              : "nothing to release"}
                    </span>
                </div>
                <p className="mt-1 text-xs text-muted">{next.reason}</p>
                {!singleBranch ? (
                    <>
                        <div className="mt-4 flex items-baseline gap-2">
                            <i className="fa fa-solid fa-code-merge self-center text-accent" />
                            <span className="text-2xl font-semibold tabular-nums" data-testid="release-pending">
                                {pending}
                            </span>
                            <span className="text-xs text-muted">
                                changes on {trunk}, not yet on {release}
                            </span>
                        </div>
                        <div className="mt-2 flex flex-col gap-1.5">
                            <Bar
                                label="features"
                                value={state.pending.feat.length}
                                total={state.pending.total}
                                className="bg-accent"
                            />
                            <Bar
                                label="fixes"
                                value={state.pending.fix.length}
                                total={state.pending.total}
                                className="bg-success"
                            />
                            <Bar
                                label="the rest"
                                value={state.pending.other}
                                total={state.pending.total}
                                className="bg-muted/60"
                            />
                        </div>
                    </>
                ) : null}
                {state.pending.feat.length > 0 ? (
                    <ul className="mt-3 flex flex-col gap-1 text-xs">
                        {state.pending.feat.slice(0, 6).map((c) => {
                            const s = readableSubject(c.subject);
                            return (
                                <li key={c.sha} className="flex gap-1.5">
                                    <span className="shrink-0 text-accent">✦</span>
                                    <span className="min-w-0 truncate" title={c.subject}>
                                        {s.ticket ? <span className="text-muted">#{s.ticket} </span> : null}
                                        {s.text}
                                    </span>
                                </li>
                            );
                        })}
                        {state.pending.feat.length > 6 ? (
                            <li className="pl-4 text-muted">and {state.pending.feat.length - 6} more…</li>
                        ) : null}
                    </ul>
                ) : null}
                {milestone ? (
                    <div className="mt-4" data-testid="release-milestone">
                        <div className="mb-1 flex items-center justify-between text-xs">
                            <span className="flex items-center gap-1.5">
                                <i className="fa fa-solid fa-bullseye text-muted" /> Milestone {milestone.title}
                            </span>
                            <span className="text-muted tabular-nums">
                                {percent} % · {milestone.open_issues} open
                            </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded bg-hover">
                            <div
                                className="h-full rounded bg-accent transition-[width] duration-1000 ease-out"
                                style={{ width: `${percent}%` }}
                            />
                        </div>
                    </div>
                ) : null}
            </Card>

            <Card icon="flag" eyebrow="Last release candidate" testId="release-rc">
                {lastRc ? (
                    <>
                        <div className="flex items-baseline gap-2">
                            <span className="text-xl font-semibold">{lastRc.name}</span>
                            <span className="text-xs text-muted">{daysSince(lastRc.date)}</span>
                        </div>
                        {(lastRc.notes ?? lastRc.notesInternal) ? (
                            <p className="mt-1.5 line-clamp-4 text-xs leading-relaxed whitespace-pre-line text-muted">
                                {plainText(lastRc.notes ?? lastRc.notesInternal ?? "")}
                            </p>
                        ) : null}
                    </>
                ) : (
                    <p className="text-sm text-muted">No release candidate yet.</p>
                )}
            </Card>

            <Card icon="box" eyebrow="Last public release" testId="release-public">
                {lastPublic ? (
                    <div className="flex items-baseline gap-2">
                        <span className="text-xl font-semibold">{lastPublic.name}</span>
                        <span className="text-xs text-muted">{daysSince(lastPublic.date)}</span>
                    </div>
                ) : (
                    <p className="text-sm">
                        None yet.{" "}
                        <span className="text-muted">
                            {next.version ? `${tagPrefix}${next.version} will be the first.` : ""}
                        </span>
                    </p>
                )}
            </Card>
        </div>
    );
}
