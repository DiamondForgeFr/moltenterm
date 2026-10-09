// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The plan usage section of the companion (FR-SHELL-027, DS-SHELL-030): opt-in per agent and marked experimental, it
// shows each limit window of the agent's plan with its bar and reset. wavesrv reads the source and publishes the
// gauges when they change; the section never polls the source. A failure is one muted line.

import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { ReactNode, useEffect, useRef, useState } from "react";
import { MoltenWave } from "../molten-button";
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

const RpcTimeoutMs = 12000;
// While the setup shows, the settings are looked at again this often, read-only: pasting the snippet is detected
// even before Claude Code's next status line.
const SetupRecheckMs = 3000;
// Reset times and the age are relative: they are redrawn this often.
const ClockTickMs = 30000;
const CopiedMs = 1500;

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
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
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
    const settingUp = info?.setup != null && info.gauges !== "off";
    useEffect(() => {
        if (!settingUp) {
            return;
        }
        const timer = setInterval(() => call(CompanionUsageCommand, visibleRead()), SetupRecheckMs);
        return () => clearInterval(timer);
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
        const timer = setInterval(askIfVisible, refreshMs);
        return () => clearInterval(timer);
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
        />
    );
}

export type PlanUsageActions = {
    onShow: () => void;
    onHide: () => void;
    onRefresh: () => void;
    onExperimental?: (on: boolean) => void;
    onConfirming?: (confirming: boolean) => void;
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
}: {
    view: GaugesView;
    experimental?: ExperimentalView;
    confirming?: boolean;
    failed?: boolean;
    refreshing?: boolean;
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
}: {
    source: string;
    age: string;
    refreshing?: boolean;
    onRefresh: () => void;
    onHide: () => void;
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
            </div>
            {source ? <div className="w-full text-11 text-muted">From the {source}</div> : null}
        </div>
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
