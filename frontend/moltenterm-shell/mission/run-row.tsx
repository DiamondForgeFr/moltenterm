// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The look of a run in the Project overview's "In progress" band (FR-MC-024, #2188): one row, with a state mark, the
// run's name and context, a bar split into its phases with the current one named, its time and its actions. What a row
// unfolds (a log, a release's phase) sits under it without a frame of its own: the band's border is the only one.

import { cn, fireAndForget } from "@/util/util";
import { ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { StateMark } from "../state-mark";
import { DominoLoader } from "../suite/suite";
import { logTail } from "./mission-model";
import type { PhaseStatus } from "./release-run";
import { BandRow, durationText, RowPhase, RowTone, saysOf } from "./run-row-model";

const TailLines = 10;

// The heat scale's tokens, one state colour per row: running amber, waiting violet, failure ember.
const ToneText: Record<RowTone, string> = {
    working: "text-[var(--mt-state-running)]",
    waiting: "text-[var(--mt-state-waiting)]",
    failed: "text-danger",
};

const PhaseFill: Record<PhaseStatus, string> = {
    todo: "bg-transparent",
    running: "bg-[var(--mt-state-running)]",
    waiting: "bg-[var(--mt-state-waiting)]",
    done: "bg-[var(--mt-state-ready)]",
    failed: "bg-[var(--mt-state-blocked)]",
};

// The calm button of a row: Log, Cancel, See on GitHub, Show in folder, Close.
export const RowButtonClass =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

// The button of a row that is the thing to do now (Retry, the release's next step): the molten call to action.
export const RowCtaClass =
    "molten-btn inline-flex cursor-pointer items-center gap-1.5 rounded-4 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50";

// Under a row, the unfolded area starts under the run's name, after the mark.
export const RowInsetClass = "mr-4 ml-[38px]";

export function RowMark({ tone }: { tone: RowTone }) {
    if (tone === "working") {
        return <DominoLoader className="mt-dominos-icon text-[var(--mt-state-running)]" />;
    }
    return <StateMark kind={tone === "waiting" ? "waiting" : "blocked"} />;
}

function PhaseSegment({ phase }: { phase: RowPhase }) {
    return (
        <span
            className="relative block h-1.5 overflow-hidden rounded-full bg-hover"
            data-status={phase.status}
            aria-hidden
        >
            <span
                className={cn("absolute inset-y-0 left-0 rounded-full", PhaseFill[phase.status])}
                style={{ width: `${Math.round(phase.fill * 100)}%` }}
            />
        </span>
    );
}

function PhaseLabel({ phase, tone }: { phase: RowPhase; tone: RowTone }) {
    return (
        <span
            className={cn(
                "block min-w-0 truncate text-left text-12",
                phase.current ? cn("font-semibold", ToneText[tone]) : "text-muted"
            )}
        >
            {phase.label}
            {phase.current && phase.progress ? ` · ${phase.progress}` : ""}
        </span>
    );
}

export function RowPhases({
    phases,
    tone,
    label,
    picked,
    onPick,
    testIdPrefix,
}: {
    phases: RowPhase[];
    tone: RowTone;
    label: string;
    // The phase whose detail is shown, when the phases can be picked.
    picked?: string;
    onPick?: (id: string) => void;
    testIdPrefix?: string;
}) {
    return (
        <ol
            className="grid min-w-0 gap-x-1"
            style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}
            aria-label={label}
            data-testid="run-row-phases"
        >
            {phases.map((phase) => {
                const body = (
                    <span className="flex min-w-0 flex-col gap-1.5">
                        <PhaseSegment phase={phase} />
                        <PhaseLabel phase={phase} tone={tone} />
                    </span>
                );
                return (
                    <li key={phase.id} className="min-w-0" data-status={phase.status} data-current={phase.current}>
                        {onPick ? (
                            <button
                                type="button"
                                onClick={() => onPick(phase.id)}
                                aria-current={phase.current ? "step" : undefined}
                                aria-pressed={picked === phase.id}
                                aria-label={`${phase.label}: ${phase.says}`}
                                title={`${phase.label}: ${phase.says}`}
                                data-status={phase.status}
                                data-testid={testIdPrefix ? `${testIdPrefix}${phase.id}` : undefined}
                                className="block w-full min-w-0 cursor-pointer rounded-4 text-left hover:bg-hover"
                            >
                                {body}
                            </button>
                        ) : (
                            <span title={`${phase.label}: ${phase.says}`}>
                                <span className="sr-only">{`${phase.label}: ${phase.says}`}</span>
                                {body}
                            </span>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

export function RowTime({ row, now }: { row: BandRow; now: number }) {
    const t = useT();
    if (!(row.startedat > 0)) {
        return null;
    }
    return (
        <span className="text-13 whitespace-nowrap text-primary tabular-nums" data-testid="run-row-time">
            {durationText((row.endedat > 0 ? row.endedat : now) - row.startedat)}
            {row.estimateMs > 0 ? (
                <span className="text-muted">
                    {" "}
                    {t("project.band.ofEstimate", { estimate: durationText(row.estimateMs) })}
                </span>
            ) : null}
        </span>
    );
}

// What the current phase does, said under the bar, or why the run stopped.
function RowNote({ text, tone, testId }: { text: string; tone: RowTone; testId?: string }) {
    if (!text) {
        return null;
    }
    return (
        <p
            className={cn("mt-1.5 min-w-0 truncate text-12", tone === "failed" ? "text-danger" : "text-muted")}
            title={text}
            data-testid={testId ?? "run-row-note"}
        >
            {text}
        </p>
    );
}

export function RunRow({
    row,
    now,
    phasesLabel,
    actions,
    children,
    picked,
    onPick,
    phaseTestIdPrefix,
    testId,
    extra,
}: {
    row: BandRow;
    now: number;
    phasesLabel: string;
    actions: ReactNode;
    // What the row unfolds under itself: a log, a release phase's detail.
    children?: ReactNode;
    picked?: string;
    onPick?: (id: string) => void;
    phaseTestIdPrefix?: string;
    testId?: string;
    // Under the actions' line, an error of an action.
    extra?: ReactNode;
}) {
    const t = useT();
    const hasBar = row.phases.length > 0 || !!row.note || !!row.verification;
    return (
        <div className="flex flex-col py-3" data-testid={testId ?? "run-row"} data-kind={row.kind} data-tone={row.tone}>
            {/* One column on a narrow pane (name, bar, time, actions), then the actions beside the name and the time
                beside the bar, then four columns like the mockup. */}
            <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 px-4 @min-[34rem]:grid-cols-[minmax(0,1fr)_auto] @min-[34rem]:items-center @min-[56rem]:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,10rem)_auto]">
                <div className="flex min-w-0 items-center gap-2.5">
                    <span
                        className="flex w-3 shrink-0 items-center justify-center"
                        title={saysOf(toneStatus(row.tone))}
                    >
                        <RowMark tone={row.tone} />
                    </span>
                    <div className="flex min-w-0 flex-col">
                        <span className="truncate text-15 font-semibold text-primary" data-testid="run-row-name">
                            {row.name}
                        </span>
                        {row.context ? (
                            <span className="truncate text-12 text-muted" title={row.context}>
                                {row.context}
                            </span>
                        ) : null}
                    </div>
                </div>
                <div
                    className={cn(
                        "min-w-0 @min-[34rem]:col-start-1 @min-[34rem]:row-start-2 @min-[56rem]:col-start-auto @min-[56rem]:row-start-auto",
                        !hasBar && "hidden @min-[56rem]:block"
                    )}
                >
                    {row.phases.length > 0 ? (
                        <RowPhases
                            phases={row.phases}
                            tone={row.tone}
                            label={phasesLabel}
                            picked={picked}
                            onPick={onPick}
                            testIdPrefix={phaseTestIdPrefix}
                        />
                    ) : null}
                    <RowNote text={row.note} tone={row.tone} />
                    <RowNote text={row.verification} tone="working" testId="run-row-verification" />
                </div>
                <div
                    className={cn(
                        "@min-[34rem]:col-start-2 @min-[34rem]:self-start @min-[56rem]:col-start-auto @min-[56rem]:row-start-auto @min-[56rem]:self-center @min-[56rem]:text-right",
                        hasBar ? "@min-[34rem]:row-start-2" : "@min-[34rem]:row-start-1"
                    )}
                >
                    <RowTime row={row} now={now} />
                </div>
                <div
                    className={cn(
                        "flex-wrap items-center justify-start gap-2 @min-[34rem]:col-start-2 @min-[34rem]:row-start-1 @min-[34rem]:justify-end @min-[56rem]:col-start-auto @min-[56rem]:row-start-auto",
                        actions == null ? "hidden @min-[56rem]:flex" : "flex"
                    )}
                    data-testid="run-row-actions"
                    aria-label={t("project.band.actionsOf", { name: row.name })}
                    role="group"
                >
                    {actions}
                </div>
            </div>
            {extra}
            {children}
        </div>
    );
}

function toneStatus(tone: RowTone): PhaseStatus {
    return tone === "working" ? "running" : tone === "waiting" ? "waiting" : "failed";
}

// A button-like link under an unfolded area: Whole log, Copy.
const LogLinkClass =
    "cursor-pointer text-12 text-secondary underline-offset-2 hover:text-primary hover:underline disabled:cursor-default disabled:opacity-50";

// The last lines of a run's log as they come, in a dark area without a frame under the run's row, with the whole log
// and a copy of it a click away.
export function RunLogArea({ log, testId }: { log: string; testId?: string }) {
    const t = useT();
    const [whole, setWhole] = useState(false);
    const [copied, setCopied] = useState(false);
    const area = useRef<HTMLDivElement>(null);
    const lines = logTail(log, whole ? 2000 : TailLines);
    useEffect(() => {
        const el = area.current;
        if (el != null) {
            el.scrollTop = el.scrollHeight;
        }
    }, [log, whole]);
    useEffect(() => {
        if (!copied) {
            return;
        }
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);
    const copy = () =>
        fireAndForget(async () => {
            await navigator.clipboard.writeText(logTail(log, Number.MAX_SAFE_INTEGER).join("\n"));
            setCopied(true);
        });
    return (
        <div className={cn("mt-3 flex flex-col gap-2", RowInsetClass)} data-testid={testId ?? "run-row-log"}>
            <div
                ref={area}
                className={cn(
                    "flex flex-col rounded-4 bg-[color-mix(in_srgb,var(--mt-sink)_40%,transparent)] px-3.5 py-3 font-mono text-12 leading-[1.7] break-all whitespace-pre-wrap text-secondary",
                    whole ? "max-h-[50vh] overflow-auto" : "max-h-[13.5rem] justify-end overflow-hidden"
                )}
                tabIndex={0}
                aria-label={t("project.band.logOf")}
            >
                {lines.length === 0 ? (
                    <span className="text-muted">{t("mc.run.noOutput")}</span>
                ) : (
                    lines.map((line, i) => (
                        <span key={i} className={i === lines.length - 1 ? "text-primary" : undefined}>
                            {line}
                        </span>
                    ))
                )}
            </div>
            <div className="flex items-center gap-4 text-12 text-muted">
                <span className="min-w-0 flex-1 truncate">{whole ? "" : t("project.band.logFollows")}</span>
                <button
                    type="button"
                    onClick={() => setWhole(!whole)}
                    className={LogLinkClass}
                    aria-pressed={whole}
                    data-testid="run-row-log-whole"
                >
                    {whole ? t("mc.run.less") : t("mc.run.wholeLog")}
                </button>
                <button type="button" onClick={copy} className={LogLinkClass} data-testid="run-row-log-copy">
                    {copied ? t("mc.frame.copied") : t("project.band.copyLog")}
                </button>
            </div>
        </div>
    );
}

// The Log button of a row: it opens and closes the area under the row.
export function LogToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={cn(RowButtonClass, open && "bg-hover text-primary")}
            data-testid="run-row-log-toggle"
        >
            {t("mc.run.log")}
            <i className={cn("fa fa-solid text-11", open ? "fa-chevron-up" : "fa-chevron-down")} aria-hidden />
        </button>
    );
}
