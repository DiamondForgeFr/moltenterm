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
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import {
    CompanionUsageInfo,
    experimentalExplanation,
    experimentalLabel,
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
    const panelId = usePanelBlockId();
    useEffect(() => {
        return everyInPanel(panelId, whileShown(intervalMs), () => setNow(Date.now()), "clock");
    }, [intervalMs, panelId]);
    return now;
}

// Reads the terminal's plan usage when the companion shows its agent, then takes wavesrv's events.
function usePlanUsage(target: string, agent: string, now: number) {
    const [info, setInfo] = useState<CompanionUsageInfo>(null);
    const [failed, setFailed] = useState(false);
    const panelId = usePanelBlockId();
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
        return everyInPanel(
            panelId,
            whileShown(SetupRecheckMs),
            () => call(CompanionUsageCommand, visibleRead()),
            "companion-usage-setup"
        );
    }, [settingUp, target, panelId]);
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
        return everyInPanel(panelId, whileShown(refreshMs), askIfVisible, "companion-usage");
    }, [refreshMs, target, panelId]);
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
    // The views are built by the model with t(): reading the language re-renders the section when it changes.
    useT();
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
    error: "text-danger",
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
    const t = useT();
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
                <span>{t("companion.gauges.title")}</span>
                <button
                    type="button"
                    className={cn(GhostButton, "ml-auto")}
                    aria-label={t("companion.gauges.show")}
                    onClick={onShow}
                >
                    {t("companion.gauges.showShort")}
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
                        {t("companion.gauges.unavailable")}
                        <span className="sr-only">: {view.reason}</span>
                    </span>
                    <button
                        type="button"
                        className={cn(GhostButton, "ml-auto")}
                        aria-label={t("companion.gauges.hide")}
                        onClick={onHide}
                    >
                        {t("companion.gauges.hideShort")}
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
            aria-label={t("companion.gauges.title")}
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
    const t = useT();
    return (
        <span
            className="rounded-4 border border-warning/50 px-1 text-11 font-medium tracking-wide text-warning"
            title={t("companion.gauges.experimentalSourceTitle")}
        >
            {experimentalLabel()}
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
    const t = useT();
    const setConfirming = onConfirming;
    if (view == null || view.kind === "none" || onSet == null) {
        return null;
    }
    const frame = "mt-2 border-t border-border/60 pt-1.5 text-11";
    if (view.kind === "on") {
        return (
            <div className={frame} data-testid="companion-plan-usage-experimental" data-state="on">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-secondary">{t("companion.gauges.modelLimits")}</span>
                    <ExperimentalSourceBadge />
                    <button type="button" className={cn(GhostButton, "ml-auto")} onClick={() => onSet(false)}>
                        {t("companion.gauges.turnOff")}
                    </button>
                </div>
                {view.reason ? (
                    <div className="mt-0.5 text-muted" title={view.reason}>
                        {t("companion.gauges.modelLimitsUnavailable")}
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
                aria-label={t("companion.gauges.turnOnLabel")}
                data-testid="companion-plan-usage-experimental"
                data-state="confirm"
            >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-secondary">{t("companion.gauges.modelLimits")}</span>
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
                        {t("companion.gauges.turnOn")}
                        <MoltenWave />
                    </button>
                    <button type="button" className={GhostButton} onClick={() => setConfirming(false)}>
                        {t("common.cancel")}
                    </button>
                </div>
            </div>
        );
    }
    return (
        <div className={frame} data-testid="companion-plan-usage-experimental" data-state="off">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-secondary">{t("companion.gauges.modelLimits")}</span>
                <ExperimentalSourceBadge />
                <button type="button" className={cn(GhostButton, "ml-auto")} onClick={() => setConfirming(true)}>
                    {t("companion.gauges.turnOnEllipsis")}
                </button>
            </div>
            <p className="mt-0.5 text-muted">{experimentalExplanation()}</p>
        </div>
    );
}

function ExperimentalBadge() {
    const t = useT();
    return (
        <span
            className="rounded-4 border border-warning/50 px-1 text-11 font-medium tracking-wide text-warning uppercase"
            title={t("companion.gauges.experimentalTitle")}
        >
            {t("companion.gauges.experimental")}
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
    const t = useT();
    return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-11 font-semibold tracking-wide text-muted uppercase">
                {t("companion.gauges.title")}
            </span>
            <ExperimentalBadge />
            <div className="ml-auto flex items-center gap-1">
                {age ? <span className="text-11 text-muted">{age}</span> : null}
                <button
                    type="button"
                    className={GhostButton}
                    onClick={onRefresh}
                    title={t("companion.gauges.refresh")}
                    aria-label={t("companion.gauges.refresh")}
                    aria-busy={refreshing || undefined}
                >
                    <i className={cn("fa fa-solid fa-rotate-right", refreshing && "fa-spin")} aria-hidden="true" />
                </button>
                <button type="button" className={GhostButton} onClick={onHide}>
                    {t("companion.gauges.hideShort")}
                </button>
                {onLess != null ? (
                    <button
                        type="button"
                        className={GhostButton}
                        onClick={onLess}
                        title={t("companion.gauges.compact")}
                        aria-label={t("companion.gauges.compact")}
                        data-testid="companion-plan-usage-less"
                    >
                        <i className="fa fa-solid fa-chevron-up" aria-hidden="true" />
                    </button>
                ) : null}
            </div>
            {source ? <div className="w-full text-11 text-muted">{t("companion.gauges.from", { source })}</div> : null}
        </div>
    );
}

// One line per limit: its name, a thin bar, the percent and the reset; the source and age in the tooltip, the rest
// in the details.
function CompactGauges({ view, onDetails }: { view: Extract<GaugesView, { kind: "enabled" }>; onDetails: () => void }) {
    const t = useT();
    const rows = view.rows.slice(0, CompactRows);
    const more = view.rows.length - rows.length + (view.credits ? 1 : 0);
    const about = [view.source ? t("companion.gauges.from", { source: view.source }) : "", view.age]
        .filter((s) => !!s)
        .join(" · ");
    return (
        <section
            className="shrink-0 px-3 py-1"
            aria-label={t("companion.gauges.title")}
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
                    title={
                        more > 0 ? t("companion.gauges.detailsMore", { count: more }) : t("companion.gauges.details")
                    }
                    aria-label={t("companion.gauges.details")}
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
    const percent = row.percentShort;
    const resets = row.resetsShort;
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
    const t = useT();
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
            aria-label={t("companion.gauges.setupLabel")}
            data-testid="companion-plan-usage"
            data-state="setup"
        >
            <div className="flex items-center gap-2">
                <span className="text-11 font-semibold tracking-wide text-muted uppercase">
                    {t("companion.gauges.title")}
                </span>
                <ExperimentalBadge />
            </div>
            <p className="mt-1.5 text-secondary">{t("companion.gauges.setupIntro")}</p>
            <p className="mt-1.5 text-secondary">
                {setup.current ? t("companion.gauges.setupReplace") : t("companion.gauges.setupAdd")}{" "}
                <code className="font-mono text-primary">{setup.file}</code>
                {setup.current ? t("companion.gauges.setupWith") : t("companion.gauges.setupColon")}
            </p>
            <pre
                className="mt-1 max-h-48 overflow-auto rounded-4 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 leading-relaxed break-all whitespace-pre-wrap text-secondary select-text"
                data-language={setup.language}
                data-testid="companion-plan-usage-snippet"
            >
                {setup.snippet}
            </pre>
            <p className="mt-1.5 text-muted">{t("companion.gauges.setupNote")}</p>
            {failed ? <p className="mt-1 text-muted">{t("companion.gauges.setupFailed")}</p> : null}
            <div className="mt-2 flex items-center gap-2">
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                    onClick={copy}
                >
                    <i className={cn("fa fa-solid mr-1.5", copied ? "fa-check" : "fa-copy")} aria-hidden="true" />
                    {copied ? t("companion.gauges.copied") : t("companion.gauges.copy")}
                    <MoltenWave />
                </button>
                <button type="button" className={GhostButton} onClick={onHide}>
                    {t("companion.gauges.hide")}
                </button>
            </div>
            {extra}
        </section>
    );
}
