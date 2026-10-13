// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The plan usage section of the companion (FR-SHELL-027, DS-SHELL-030): opt-in per agent and marked experimental, it
// shows each limit window of the agent's plan with its bar and reset. wavesrv reads the source and publishes the
// gauges when they change; the section never polls the source. A failure is one muted line.

import { getSettingsKeyAtom } from "@/app/store/global";
import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ReactNode, useEffect, useRef, useState } from "react";
import { MoltenWave } from "../molten-button";
import { TabActivity, whileShown } from "../tab-activity";
import {
    CompanionUsageInfo,
    ExperimentalExplanation,
    ExperimentalLabel,
    experimentalView,
    ExperimentalView,
    GaugeLevel,
    GaugeRow,
    gaugesView,
    GaugesView,
    usageFor,
    usageReadFor,
    UsageSetup,
    usageStale,
} from "./companion-gauges-model";
import {
    CompanionRoute,
    CompanionUsageCommand,
    CompanionUsageEvent,
    CompanionUsageExperimentalCommand,
    CompanionUsageGaugesCommand,
} from "./companion-model";
import { useCompanionPref } from "./companion-prefs";

const RpcTimeoutMs = 12000;
// While the setup shows, the settings are looked at again this often, read-only: pasting the snippet is detected
// even before Claude Code's next status line.
const SetupRecheckMs = 3000;
// Reset times and the age are relative: they are redrawn this often.
const ClockTickMs = 30000;
const CopiedMs = 1500;
// The compact form shows this many limits, one line each (#555); the others are in the details.
const CompactRows = 2;

const GhostButton =
    "shrink-0 cursor-pointer rounded-6 px-1.5 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary focus-visible:bg-hover focus-visible:text-primary";

function usageCall(command: string, data: any): Promise<CompanionUsageInfo> {
    return TabRpcClient.wshRpcCall(command, data, { route: CompanionRoute, timeout: RpcTimeoutMs });
}

// A network source may be called only for a companion the user can see (NFR-SHELL-013).
function visibleRead(): { fetch: boolean } {
    return usageReadFor(document.visibilityState);
}

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        return TabActivity.getInstance().every(whileShown(intervalMs), () => setNow(Date.now()), "clock");
    }, [intervalMs]);
    return now;
}

// Reads the terminal's plan usage when the companion shows its agent, then takes wavesrv's events.
function usePlanUsage(target: string, agent: string, now: number) {
    const [info, setInfo] = useState<CompanionUsageInfo>(null);
    const [failed, setFailed] = useState(false);
    // A Refresh may run the agent's own tool (Codex's app-server, a few seconds): the icon turns meanwhile.
    const [refreshing, setRefreshing] = useState(false);
    const accept = (next: CompanionUsageInfo) => {
        if (usageFor(next, target, agent)) {
            setInfo(next);
            setFailed(false);
        }
    };
    const call = (command: string, data: any) =>
        fireAndForget(async () => {
            try {
                accept(await usageCall(command, { blockid: target, ...data }));
            } catch {
                setFailed(true);
            }
        });
    useEffect(() => {
        setInfo(null);
        setFailed(false);
        if (!target || !agent) {
            return;
        }
        let cancelled = false;
        let unsubscribe = () => {};
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: CompanionUsageEvent as WaveEventName,
                scope: makeORef("block", target),
                handler: (event) => {
                    if (!cancelled) {
                        accept(event.data as CompanionUsageInfo);
                    }
                },
            });
        } catch (e) {
            console.log("companion usage: no event bus", e);
        }
        fireAndForget(async () => {
            try {
                const first = await usageCall(CompanionUsageCommand, { blockid: target, ...visibleRead() });
                if (!cancelled) {
                    accept(first);
                }
            } catch {
                // No usage page or no agent: the section stays hidden.
            }
        });
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [target, agent]);
    // wavesrv publishes a change of the gauges to the agent's other companions only: one made elsewhere (the command
    // panel, the settings file) reaches this one through the settings, and the section reads again.
    const gaugesSetting = JSON.stringify(useAtomValue(getSettingsKeyAtom("companion:usagegauges")) ?? []);
    const sourceSetting = useAtomValue(getSettingsKeyAtom("companion:usageclaudeoauth")) === true;
    const settingsSeen = useRef(`${gaugesSetting}:${sourceSetting}`);
    useEffect(() => {
        const key = `${gaugesSetting}:${sourceSetting}`;
        if (key === settingsSeen.current || !target || !agent) {
            return;
        }
        settingsSeen.current = key;
        call(CompanionUsageCommand, visibleRead());
    }, [gaugesSetting, sourceSetting, target, agent]);
    const settingUp = info?.setup != null && info.gauges !== "off";
    useEffect(() => {
        if (!settingUp) {
            return;
        }
        return TabActivity.getInstance().every(
            whileShown(SetupRecheckMs),
            () => call(CompanionUsageCommand, visibleRead()),
            "companion-usage-setup"
        );
    }, [settingUp, target]);
    // A source wavesrv does not push (the experimental endpoint) is asked again only while the window shows
    // (NFR-SHELL-013); wavesrv keeps the call limits, this only asks. That also covers stale values.
    const refreshMs = info != null && info.gauges !== "off" ? (info.refreshms ?? 0) : 0;
    const stale = !(refreshMs > 0) && usageStale(info, now);
    useEffect(() => {
        if (stale) {
            call(CompanionUsageCommand, visibleRead());
        }
    }, [stale, now, target]);
    const refresh = () => {
        setRefreshing(true);
        fireAndForget(async () => {
            try {
                accept(await usageCall(CompanionUsageCommand, { blockid: target, refresh: true, fetch: true }));
            } catch {
                setFailed(true);
            } finally {
                setRefreshing(false);
            }
        });
    };
    useEffect(() => {
        if (!(refreshMs > 0)) {
            return;
        }
        const askIfVisible = () => {
            if (document.visibilityState === "visible") {
                call(CompanionUsageCommand, { fetch: true });
            }
        };
        return TabActivity.getInstance().every(whileShown(refreshMs), askIfVisible, "companion-usage");
    }, [refreshMs, target]);
    // wavesrv reads automatically only for a window that shows: it is told when this one hides or shows, and asks
    // once on show (its own call limits keep that from being a burst).
    useEffect(() => {
        if (!target || !agent) {
            return;
        }
        const reportVisibility = () => call(CompanionUsageCommand, visibleRead());
        document.addEventListener("visibilitychange", reportVisibility);
        return () => document.removeEventListener("visibilitychange", reportVisibility);
    }, [target, agent]);
    return {
        info,
        failed,
        refreshing,
        show: () => call(CompanionUsageGaugesCommand, { on: true }),
        hide: () => call(CompanionUsageGaugesCommand, { on: false }),
        refresh,
        setExperimental: (on: boolean) => call(CompanionUsageExperimentalCommand, { on }),
    };
}

export function PlanUsageSection({ target, agent }: { target: string; agent: string }) {
    const now = useNow(ClockTickMs);
    const { info, failed, refreshing, show, hide, refresh, setExperimental } = usePlanUsage(target, agent, now);
    const [details, setDetails] = useCompanionPref("usagedetails");
    // Held here, so an update that changes the section's layout keeps an open confirmation.
    const [confirming, setConfirming] = useState(false);
    const experimental = experimentalView(info);
    const offered = experimental.kind === "off";
    useEffect(() => {
        if (!offered) {
            setConfirming(false);
        }
    }, [offered]);
    return (
        <PlanUsageBody
            view={gaugesView(info, now)}
            experimental={experimental}
            confirming={confirming}
            onConfirming={setConfirming}
            failed={failed}
            refreshing={refreshing}
            onShow={show}
            onHide={hide}
            onRefresh={refresh}
            onExperimental={setExperimental}
            compact={!details}
            onDetails={setDetails}
        />
    );
}

export type PlanUsageActions = {
    onShow: () => void;
    onHide: () => void;
    onRefresh: () => void;
    onExperimental?: (on: boolean) => void;
    onConfirming?: (confirming: boolean) => void;
    // The compact form's details toggle (#555); without it the full section shows.
    onDetails?: (details: boolean) => void;
};

const BarColours: Record<GaugeLevel, string> = {
    normal: "bg-accent",
    warning: "bg-warning",
    error: "bg-error",
};

const PercentColours: Record<GaugeLevel, string> = {
    normal: "text-secondary",
    warning: "text-warning",
    error: "text-error",
};

export function PlanUsageBody({
    view,
    experimental,
    confirming,
    failed,
    refreshing,
    onShow,
    onHide,
    onRefresh,
    onExperimental,
    onConfirming,
    compact,
    onDetails,
}: {
    view: GaugesView;
    experimental?: ExperimentalView;
    confirming?: boolean;
    failed?: boolean;
    refreshing?: boolean;
    compact?: boolean;
} & PlanUsageActions) {
    const extra = (
        <ExperimentalRow
            view={experimental}
            onSet={onExperimental}
            confirming={confirming ?? false}
            onConfirming={onConfirming ?? (() => {})}
        />
    );
    if (view.kind === "hidden") {
        return null;
    }
    if (view.kind === "off") {
        return (
            <div
                className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-11 text-muted"
                data-testid="companion-plan-usage"
                data-state="off"
            >
                <i className="fa fa-solid fa-gauge" aria-hidden="true" />
                <span>Plan usage</span>
                <button type="button" className={cn(GhostButton, "ml-auto")} onClick={onShow}>
                    Show plan usage
                </button>
            </div>
        );
    }
    if (view.kind === "unavailable") {
        return (
            <div
                className="shrink-0 border-b border-border px-3 py-1 text-11 text-muted"
                data-testid="companion-plan-usage"
                data-state="unavailable"
            >
                <div className="flex items-center gap-2">
                    <i className="fa fa-solid fa-gauge" aria-hidden="true" />
                    <span title={view.reason}>
                        Plan usage unavailable
                        <span className="sr-only">: {view.reason}</span>
                    </span>
                    <button type="button" className={cn(GhostButton, "ml-auto")} onClick={onHide}>
                        Hide plan usage
                    </button>
                </div>
                {extra}
            </div>
        );
    }
    if (view.kind === "setup") {
        return <StatusLineSetupCard setup={view.setup} failed={failed} onHide={onHide} extra={extra} />;
    }
    if (compact && onDetails != null) {
        return <CompactGauges view={view} onDetails={() => onDetails(true)} />;
    }
    return (
        <section
            className="shrink-0 border-b border-border px-3 pt-2 pb-2.5"
            aria-label="Plan usage"
            data-testid="companion-plan-usage"
            data-state="enabled"
        >
            <GaugesHeader
                source={view.source}
                age={view.age}
                refreshing={refreshing}
                onRefresh={onRefresh}
                onHide={onHide}
                onLess={onDetails != null ? () => onDetails(false) : null}
            />
            <ul className="mt-1.5 flex flex-col gap-2">
                {view.rows.map((row) => (
                    <GaugeRowView key={row.id} row={row} />
                ))}
            </ul>
            {view.credits ? (
                <div className="mt-1.5 text-11 text-secondary" data-testid="companion-plan-usage-credits">
                    {view.credits}
                </div>
            ) : null}
            {extra}
        </section>
    );
}

function ExperimentalSourceBadge() {
    return (
        <span
            className="rounded-4 border border-warning/50 px-1 text-11 font-medium tracking-wide text-warning"
            title="Read from an endpoint Anthropic does not document: it may change or stop working"
        >
            {ExperimentalLabel}
        </span>
    );
}

// Claude Code's experimental source (FR-SHELL-028): off by default, turned on only through the confirmation that
// says what is read; turning it off is one click.
export function ExperimentalRow({
    view,
    onSet,
    confirming,
    onConfirming,
}: {
    view: ExperimentalView;
    onSet: (on: boolean) => void;
    confirming: boolean;
    onConfirming: (confirming: boolean) => void;
}) {
    const setConfirming = onConfirming;
    if (view == null || view.kind === "none" || onSet == null) {
        return null;
    }
    const frame = "mt-2 border-t border-border/60 pt-1.5 text-11";
    if (view.kind === "on") {
        return (
            <div className={frame} data-testid="companion-plan-usage-experimental" data-state="on">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-secondary">Model limits and credits</span>
                    <ExperimentalSourceBadge />
                    <button type="button" className={cn(GhostButton, "ml-auto")} onClick={() => onSet(false)}>
                        Turn off
                    </button>
                </div>
                {view.reason ? (
                    <div className="mt-0.5 text-muted" title={view.reason}>
                        Model limits unavailable
                        <span className="sr-only">: {view.reason}</span>
                    </div>
                ) : null}
            </div>
        );
    }
    if (confirming) {
        return (
            <div
                className={frame}
                role="group"
                aria-label="Turn on model limits and credits"
                data-testid="companion-plan-usage-experimental"
                data-state="confirm"
            >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-secondary">Model limits and credits</span>
                    <ExperimentalSourceBadge />
                </div>
                <p className="mt-1 text-12 text-primary">{view.statement}</p>
                <div className="mt-2 flex items-center gap-2">
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                        onClick={() => {
                            setConfirming(false);
                            onSet(true);
                        }}
                    >
                        Turn on
                        <MoltenWave />
                    </button>
                    <button type="button" className={GhostButton} onClick={() => setConfirming(false)}>
                        Cancel
                    </button>
                </div>
            </div>
        );
    }
    return (
        <div className={frame} data-testid="companion-plan-usage-experimental" data-state="off">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-secondary">Model limits and credits</span>
                <ExperimentalSourceBadge />
                <button type="button" className={cn(GhostButton, "ml-auto")} onClick={() => setConfirming(true)}>
                    Turn on…
                </button>
            </div>
            <p className="mt-0.5 text-muted">{ExperimentalExplanation}</p>
        </div>
    );
}

function ExperimentalBadge() {
    return (
        <span
            className="rounded-4 border border-warning/50 px-1 text-11 font-medium tracking-wide text-warning uppercase"
            title="Plan usage reads what the agent's own tools give; it may change with them"
        >
            Experimental
        </span>
    );
}

function GaugesHeader({
    source,
    age,
    refreshing,
    onRefresh,
    onHide,
    onLess,
}: {
    source: string;
    age: string;
    refreshing?: boolean;
    onRefresh: () => void;
    onHide: () => void;
    onLess?: () => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-11 font-semibold tracking-wide text-muted uppercase">Plan usage</span>
            <ExperimentalBadge />
            <div className="ml-auto flex items-center gap-1">
                {age ? <span className="text-11 text-muted">{age}</span> : null}
                <button
                    type="button"
                    className={GhostButton}
                    onClick={onRefresh}
                    title="Refresh plan usage"
                    aria-label="Refresh plan usage"
                    aria-busy={refreshing || undefined}
                >
                    <i className={cn("fa fa-solid fa-rotate-right", refreshing && "fa-spin")} aria-hidden="true" />
                </button>
                <button type="button" className={GhostButton} onClick={onHide}>
                    Hide
                </button>
                {onLess != null ? (
                    <button
                        type="button"
                        className={GhostButton}
                        onClick={onLess}
                        title="Compact plan usage"
                        aria-label="Compact plan usage"
                        data-testid="companion-plan-usage-less"
                    >
                        <i className="fa fa-solid fa-chevron-up" aria-hidden="true" />
                    </button>
                ) : null}
            </div>
            {source ? <div className="w-full text-11 text-muted">From the {source}</div> : null}
        </div>
    );
}

// One line per limit: its name, a thin bar, the percent and the reset; the source and age in the tooltip, the rest
// in the details.
function CompactGauges({ view, onDetails }: { view: Extract<GaugesView, { kind: "enabled" }>; onDetails: () => void }) {
    const rows = view.rows.slice(0, CompactRows);
    const more = view.rows.length - rows.length + (view.credits ? 1 : 0);
    const about = [view.source ? `From the ${view.source}` : "", view.age].filter((s) => !!s).join(" · ");
    return (
        <section
            className="shrink-0 px-3 py-1"
            aria-label="Plan usage"
            data-testid="companion-plan-usage"
            data-state="enabled"
            data-compact="true"
        >
            <div className="flex items-start gap-2">
                <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {rows.length === 0 && view.credits ? (
                        <li className="truncate text-11 text-secondary">{view.credits}</li>
                    ) : null}
                    {rows.map((row) => (
                        <CompactGaugeRow key={row.id} row={row} about={about} />
                    ))}
                </ul>
                <button
                    type="button"
                    className={cn(GhostButton, "-my-0.5")}
                    onClick={onDetails}
                    title={more > 0 ? `Plan usage details (${more} more)` : "Plan usage details"}
                    aria-label="Plan usage details"
                    data-testid="companion-plan-usage-details"
                >
                    {more > 0 ? <span className="mr-1 tabular-nums">+{more}</span> : null}
                    <i className="fa fa-solid fa-chevron-down" aria-hidden="true" />
                </button>
            </div>
        </section>
    );
}

function CompactGaugeRow({ row, about }: { row: GaugeRow; about: string }) {
    const percent = row.percent.replace(/ used$/, "");
    const resets = row.resets.replace(/^Resets /, "");
    return (
        <li
            className="flex items-center gap-2 text-11"
            title={[`${row.label}: ${row.percent}`, row.resets, about].filter((s) => !!s).join("\n")}
            data-testid="companion-gauge"
            data-window={row.id}
        >
            <span className="w-24 shrink-0 truncate text-secondary">{row.label}</span>
            <div
                className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-hover"
                role="meter"
                aria-label={row.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(row.bar)}
                aria-valuetext={row.percent}
            >
                <div className={cn("h-full rounded-full", BarColours[row.level])} style={{ width: `${row.bar}%` }} />
            </div>
            <span className={cn("w-11 shrink-0 text-right tabular-nums", PercentColours[row.level])}>{percent}</span>
            {/* A fixed width keeps the bars of the rows aligned. */}
            <span className="w-[5.5rem] shrink-0 truncate text-muted tabular-nums">{resets}</span>
        </li>
    );
}

function GaugeRowView({ row }: { row: GaugeRow }) {
    return (
        <li className="flex flex-col gap-1" data-testid="companion-gauge" data-window={row.id}>
            <div className="flex items-baseline gap-2 text-12">
                <span className="text-primary">{row.label}</span>
                <span className={cn("ml-auto tabular-nums", PercentColours[row.level])}>{row.percent}</span>
            </div>
            <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-hover"
                role="meter"
                aria-label={row.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(row.bar)}
                aria-valuetext={row.percent}
            >
                <div className={cn("h-full rounded-full", BarColours[row.level])} style={{ width: `${row.bar}%` }} />
            </div>
            {row.resets ? <div className="text-11 text-muted">{row.resets}</div> : null}
        </li>
    );
}

function StatusLineSetupCard({
    setup,
    failed,
    onHide,
    extra,
}: {
    setup: UsageSetup;
    failed?: boolean;
    onHide: () => void;
    extra?: ReactNode;
}) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    const copy = () =>
        fireAndForget(async () => {
            await navigator.clipboard.writeText(setup.snippet);
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), CopiedMs);
        });
    return (
        <section
            className="shrink-0 border-b border-border px-3 pt-2 pb-3 text-12"
            aria-label="Plan usage setup"
            data-testid="companion-plan-usage"
            data-state="setup"
        >
            <div className="flex items-center gap-2">
                <span className="text-11 font-semibold tracking-wide text-muted uppercase">Plan usage</span>
                <ExperimentalBadge />
            </div>
            <p className="mt-1.5 text-secondary">
                Claude Code gives your plan's limits to its status line. Wrap your status line in MoltenTerm's relay and
                the gauges show here.
            </p>
            <p className="mt-1.5 text-secondary">
                {setup.current ? "Replace the statusLine entry in " : "Add this to "}
                <code className="font-mono text-primary">{setup.file}</code>
                {setup.current ? " with:" : ":"}
            </p>
            <pre
                className="mt-1 max-h-48 overflow-auto rounded-4 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 leading-relaxed break-all whitespace-pre-wrap text-secondary select-text"
                data-language={setup.language}
                data-testid="companion-plan-usage-snippet"
            >
                {setup.snippet}
            </pre>
            <p className="mt-1.5 text-muted">
                Your status line stays exactly as it is, in MoltenTerm and in any other terminal. MoltenTerm never edits
                this file. The gauges show after Claude Code's next response.
            </p>
            {failed ? <p className="mt-1 text-muted">MoltenTerm could not check the setup; it tries again.</p> : null}
            <div className="mt-2 flex items-center gap-2">
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                    onClick={copy}
                >
                    <i className={cn("fa fa-solid mr-1.5", copied ? "fa-check" : "fa-copy")} aria-hidden="true" />
                    {copied ? "Copied" : "Copy"}
                    <MoltenWave />
                </button>
                <button type="button" className={GhostButton} onClick={onHide}>
                    Hide plan usage
                </button>
            </div>
            {extra}
        </section>
    );
}
