// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The plan usage section of the companion (FR-SHELL-027, DS-SHELL-030): opt-in per agent and marked experimental, it
// shows each limit window of the agent's plan with its bar and reset. wavesrv reads the source and publishes the
// gauges when they change; the section never polls the source. A failure is one muted line.

import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { MoltenWave } from "../molten-button";
import {
    CompanionUsageInfo,
    GaugeLevel,
    GaugeRow,
    gaugesView,
    GaugesView,
    usageFor,
    UsageSetup,
    usageStale,
} from "./companion-gauges-model";
import {
    CompanionRoute,
    CompanionUsageCommand,
    CompanionUsageEvent,
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
    "shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-secondary hover:bg-hover hover:text-primary focus-visible:bg-hover focus-visible:text-primary";

function usageCall(command: string, data: any): Promise<CompanionUsageInfo> {
    return TabRpcClient.wshRpcCall(command, data, { route: CompanionRoute, timeout: RpcTimeoutMs });
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
                const first = await usageCall(CompanionUsageCommand, { blockid: target });
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
        const timer = setInterval(() => call(CompanionUsageCommand, {}), SetupRecheckMs);
        return () => clearInterval(timer);
    }, [settingUp, target]);
    const stale = usageStale(info, now);
    useEffect(() => {
        if (stale) {
            call(CompanionUsageCommand, {});
        }
    }, [stale, now, target]);
    const refresh = () => {
        setRefreshing(true);
        fireAndForget(async () => {
            try {
                accept(await usageCall(CompanionUsageCommand, { blockid: target, refresh: true }));
            } catch {
                setFailed(true);
            } finally {
                setRefreshing(false);
            }
        });
    };
    return {
        info,
        failed,
        refreshing,
        show: () => call(CompanionUsageGaugesCommand, { on: true }),
        hide: () => call(CompanionUsageGaugesCommand, { on: false }),
        refresh,
    };
}

export function PlanUsageSection({ target, agent }: { target: string; agent: string }) {
    const now = useNow(ClockTickMs);
    const { info, failed, refreshing, show, hide, refresh } = usePlanUsage(target, agent, now);
    return (
        <PlanUsageBody
            view={gaugesView(info, now)}
            failed={failed}
            refreshing={refreshing}
            onShow={show}
            onHide={hide}
            onRefresh={refresh}
        />
    );
}

export type PlanUsageActions = {
    onShow: () => void;
    onHide: () => void;
    onRefresh: () => void;
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
    failed,
    refreshing,
    onShow,
    onHide,
    onRefresh,
}: { view: GaugesView; failed?: boolean; refreshing?: boolean } & PlanUsageActions) {
    if (view.kind === "hidden") {
        return null;
    }
    if (view.kind === "off") {
        return (
            <div
                className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11px] text-muted"
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
                className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11px] text-muted"
                data-testid="companion-plan-usage"
                data-state="unavailable"
            >
                <i className="fa fa-solid fa-gauge" aria-hidden="true" />
                <span title={view.reason}>
                    Plan usage unavailable
                    <span className="sr-only">: {view.reason}</span>
                </span>
                <button type="button" className={cn(GhostButton, "ml-auto")} onClick={onHide}>
                    Hide plan usage
                </button>
            </div>
        );
    }
    if (view.kind === "setup") {
        return <StatusLineSetupCard setup={view.setup} failed={failed} onHide={onHide} />;
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
            {view.credits ? <div className="mt-1.5 text-[11px] text-secondary">{view.credits}</div> : null}
        </section>
    );
}

function ExperimentalBadge() {
    return (
        <span
            className="rounded border border-warning/50 px-1 text-[9.5px] font-medium tracking-wide text-warning uppercase"
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
            <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Plan usage</span>
            <ExperimentalBadge />
            <div className="ml-auto flex items-center gap-1">
                {age ? <span className="text-[11px] text-muted">{age}</span> : null}
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
            {source ? <div className="w-full text-[10.5px] text-muted">From the {source}</div> : null}
        </div>
    );
}

function GaugeRowView({ row }: { row: GaugeRow }) {
    return (
        <li className="flex flex-col gap-1" data-testid="companion-gauge" data-window={row.id}>
            <div className="flex items-baseline gap-2 text-xs">
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
            {row.resets ? <div className="text-[11px] text-muted">{row.resets}</div> : null}
        </li>
    );
}

function StatusLineSetupCard({ setup, failed, onHide }: { setup: UsageSetup; failed?: boolean; onHide: () => void }) {
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
            className="shrink-0 border-b border-border px-3 pt-2 pb-3 text-xs"
            aria-label="Plan usage setup"
            data-testid="companion-plan-usage"
            data-state="setup"
        >
            <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Plan usage</span>
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
                className="mt-1 max-h-48 overflow-auto rounded border border-border bg-black/30 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed break-all whitespace-pre-wrap text-secondary select-text"
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
                <button type="button" className="molten-btn cursor-pointer rounded px-3 py-1.5 text-xs" onClick={copy}>
                    <i className={cn("fa fa-solid mr-1.5", copied ? "fa-check" : "fa-copy")} aria-hidden="true" />
                    {copied ? "Copied" : "Copy"}
                    <MoltenWave />
                </button>
                <button type="button" className={GhostButton} onClick={onHide}>
                    Hide plan usage
                </button>
            </div>
        </section>
    );
}
