// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the windows show of the keep-awake (FR-SHELL-023, DS-SHELL-062; FR-SHELL-103): the coffee droplet on a rail item
// and on a collapsed product, the cup that appears in the window row only while something keeps the computer awake and
// links to Preferences › Energy, and that card's details: the workspace's coffee, what holds the computer awake now
// and the terminals that asked, with the per-session override. The OS-level detection and the marks on panes, tabs and
// the Sessions view are FR-SHELL-022's.

import { atoms, useSettingsKeyAtom } from "@/app/store/global";
import { PLATFORM } from "@/util/platformutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { t as translate, useT } from "./i18n/i18n";
import {
    approvalLogText,
    approvalReasonText,
    approvalSummary,
    coffeeApprovals,
    coffeeCondition,
    coffeeReason,
    coffeeSessions,
    coffeeSupported,
    describeApproval,
    describeAttempt,
    KeepAwakeApproval,
    KeepAwakeCoffee,
    keepAwakeActive,
    keepAwakeCount,
    keepAwakeIndicatorLabel,
    keepAwakeIndicatorTitle,
    KeepAwakeSession,
    keepAwakeSessions,
    KeepAwakeState,
    policyHoldingLine,
    sessionWhere,
    SleepPolicySetting,
    sleepPolicyDetail,
} from "./keepawake-model";
import { KeepAwakeModel } from "./keepawake-store";
import { openSettingsKey } from "./settings/settings-open";
import { TabActivity, whileShown } from "./tab-activity";
import { workspaceShownName } from "./workspace-default-name";

const TickMs = 1000;

// The platform wave.ts set once at start: reading it costs nothing on every render (getApi().getPlatform() is a
// synchronous IPC call).
export function usePlatform(): string {
    return PLATFORM;
}

// The clock the countdowns read: it ticks only while asked to.
export function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) {
            return;
        }
        setNow(Date.now());
        return TabActivity.getInstance().every(whileShown(TickMs), () => setNow(Date.now()), "clock");
    }, [active]);
    return now;
}

// The crema dot a folded rail item keeps while its coffee is on (DS-SHELL-062, DS-SHELL-081); its tray shows the mug.
export function RailCoffeeDrop({ workspaceId }: { workspaceId: string }) {
    const coffee = useAtomValue(KeepAwakeModel.getInstance().coffeeAtom(workspaceId));
    if (coffee == null) {
        return null;
    }
    return <span className="molten-rail-coffee-drop" aria-hidden />;
}

// A collapsed product shows the dot when one of its workspaces has its coffee on.
export function ProductCoffeeDrop({ workspaceIds }: { workspaceIds: string[] }) {
    const on = useAtomValue(KeepAwakeModel.getInstance().anyCoffeeAtom(workspaceIds));
    if (!on) {
        return null;
    }
    return <span className="molten-rail-coffee-drop" aria-hidden />;
}

function SessionRow({ session, now }: { session: KeepAwakeSession; now: number }) {
    const t = useT();
    const model = KeepAwakeModel.getInstance();
    const value = session.override?.policy ?? "";
    return (
        <li className="flex flex-col gap-0.5 rounded-6 px-2 py-1.5 hover:bg-hover">
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-primary">{session.label}</span>
                <select
                    aria-label={t("keepawake.sessionPolicy", { name: session.label })}
                    className="cursor-pointer rounded-6 border border-border bg-transparent px-1 text-11 text-secondary"
                    value={value}
                    onChange={(e) =>
                        fireAndForget(() => model.setOverride(session.blockid, e.target.value as "allow" | "letsleep"))
                    }
                >
                    <option value="">{t("keepawake.override.follow")}</option>
                    <option value="allow">{t("keepawake.override.allow")}</option>
                    <option value="letsleep">{t("keepawake.override.letSleep")}</option>
                </select>
            </div>
            {session.attempts.map((attempt) => (
                <div key={attempt.id} className="flex items-center gap-2 text-11 text-muted">
                    <span className="min-w-0 flex-1 truncate font-mono" title={describeAttempt(attempt)}>
                        {describeAttempt(attempt)}
                        {attempt.parentname ? ` · ${t("keepawake.from", { name: attempt.parentname })}` : ""}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatSince(attempt.since, now)}</span>
                    <span
                        className={cn(
                            "shrink-0",
                            attempt.outcome === "allowed" ? "text-[var(--color-awake)]" : "text-secondary"
                        )}
                    >
                        {attempt.outcome === "allowed" ? t("keepawake.allowed") : t("keepawake.stopped")}
                    </span>
                </div>
            ))}
        </li>
    );
}

function formatClock(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatSince(since: number, now: number): string {
    const minutes = Math.floor(Math.max(0, now - since) / 60000);
    if (minutes < 1) {
        return translate("keepawake.sinceNow");
    }
    if (minutes < 60) {
        return `${minutes} min`;
    }
    return formatClock(since);
}

// The coffee of the workspace the window shows, as a switch: the sidebar's workspace menu no longer carries it, and it
// is the one way to start a coffee there (FR-SHELL-103).
function WorkspaceCoffeeRow({ workspaceId, name }: { workspaceId: string; name: string }) {
    const t = useT();
    const coffee = useAtomValue(KeepAwakeModel.getInstance().coffeeAtom(workspaceId));
    const on = coffee != null;
    const label = t("keepawake.coffeeFor", { name });
    return (
        <div className="molten-settings-row flex items-center gap-4 px-5 py-3" data-testid="keepawake-coffee-row">
            <div className="min-w-0 flex-1">
                <div className="truncate text-12 font-medium text-primary">{label}</div>
                <div className="text-12 text-muted">{t("keepawake.coffeeHint")}</div>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={label}
                onClick={() =>
                    fireAndForget(async () => {
                        try {
                            await KeepAwakeModel.getInstance().setCoffee(workspaceId, !on);
                        } catch (err) {
                            console.log("keep-awake coffee:", err);
                        }
                    })
                }
                className="inline-flex h-row shrink-0 cursor-pointer items-center rounded-4 px-1"
            >
                <span className={cn("molten-cmdpanel-switch", on && "is-on")} aria-hidden />
            </button>
        </div>
    );
}

// Under the Energy card's setting (FR-SHELL-103): what the chosen option does, this workspace's coffee, what holds the
// computer awake now (the coffees, each with Stop) and the terminals that asked, with their own override.
export function KeepAwakeDetails() {
    const t = useT();
    const model = KeepAwakeModel.getInstance();
    const state = useAtomValue(model.stateAtom);
    const workspace = useAtomValue(atoms.workspace);
    const policySetting = useSettingsKeyAtom(SleepPolicySetting);
    const platform = usePlatform();
    const sessions = keepAwakeSessions(state);
    const now = useNow(keepAwakeActive(state) || sessions.length > 0);
    const holding = policyHoldingLine(state, platform, now);
    return (
        <>
            <div className="molten-settings-row flex flex-col gap-1 px-5 py-3 text-12 text-muted">
                <span>{sleepPolicyDetail(policySetting ?? "")}</span>
                {holding ? <span className="text-[var(--color-awake)]">{holding}</span> : null}
            </div>
            {coffeeSupported(platform) && workspace?.oid ? (
                <WorkspaceCoffeeRow
                    workspaceId={workspace.oid}
                    name={workspaceShownName(workspace.name, t) || t("keepawake.thisWorkspace")}
                />
            ) : null}
            {state.coffees.length > 0 ? (
                <ul
                    aria-label={t("keepawake.keptByYou")}
                    className="molten-settings-row flex flex-col px-4 py-2 text-12 text-secondary"
                >
                    {state.coffees.map((coffee) => (
                        <li
                            key={coffee.workspaceid}
                            className="flex items-center gap-2 rounded-6 px-1 py-1 hover:bg-hover"
                        >
                            <i className="fa fa-solid fa-mug-hot text-11 text-[var(--color-awake)]" aria-hidden />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-primary">
                                    {workspaceShownName(coffee.workspacename, t) || t("keepawake.workspace")}
                                </span>
                                <span className="truncate text-11 text-muted">
                                    {t("keepawake.since", { time: formatClock(coffee.since) })} ·{" "}
                                    {coffeeCondition(coffee, now)}
                                </span>
                                {coffeeReason(coffee) ? (
                                    <span className="truncate text-11 text-secondary" title={coffeeReason(coffee)}>
                                        {coffeeReason(coffee)}
                                    </span>
                                ) : null}
                            </span>
                            <button
                                type="button"
                                className="shrink-0 cursor-pointer rounded-6 border border-border px-1.5 text-11 text-secondary hover:bg-hover hover:text-primary"
                                aria-label={t("keepawake.railStop", {
                                    name: workspaceShownName(coffee.workspacename, t) || t("keepawake.thisWorkspace"),
                                })}
                                onClick={() => fireAndForget(() => model.setCoffee(coffee.workspaceid, false))}
                            >
                                {t("keepawake.stop")}
                            </button>
                        </li>
                    ))}
                    {state.coffees.map((coffee) => (
                        <CoffeeApprovals key={`approvals-${coffee.workspaceid}`} state={state} coffee={coffee} />
                    ))}
                </ul>
            ) : null}
            {sessions.length > 0 ? (
                <ul
                    aria-label={t("keepawake.terminalsAsked")}
                    className="molten-settings-row flex flex-col px-4 py-2 text-12 text-secondary"
                >
                    <li className="px-2 pb-1 text-11 text-muted">{t("keepawake.terminalsAsked")}</li>
                    {sessions.map((session) => (
                        <SessionRow key={session.blockid} session={session} now={now} />
                    ))}
                </ul>
            ) : null}
        </>
    );
}

const MaxListedApprovals = 8;

function approvalTitle(a: KeepAwakeApproval): string {
    const what = describeApproval(a);
    return a.outcome === "asked" && a.reason
        ? `${what}\n${translate("keepawake.leftToYou", { reason: approvalReasonText(a) })}`
        : what;
}

// Under the coffees (FR-SHELL-063, DS-SHELL-112): the agent sessions a coffee answers for or not, and its latest
// decisions; the log file keeps them all.
export function CoffeeApprovals({ state, coffee }: { state: KeepAwakeState; coffee: KeepAwakeCoffee }) {
    const t = useT();
    const sessions = coffeeSessions(state, coffee.workspaceid);
    const approvals = coffeeApprovals(state, coffee.workspaceid);
    if (sessions.length === 0 && approvals.length === 0) {
        return null;
    }
    const name = workspaceShownName(coffee.workspacename, t) || t("keepawake.workspace");
    const summary = approvalSummary(approvals);
    return (
        <li aria-label={t("keepawake.requestsIn", { name })} className="flex flex-col gap-1 px-1 pt-1 pb-1.5">
            <span className="text-11 text-muted">{t("keepawake.requestsIn", { name })}</span>
            {sessions.map((s) => (
                <span key={s.blockid} className="flex items-start gap-1.5 text-11">
                    <i
                        className={cn(
                            "fa fa-solid mt-[2px] text-11",
                            s.approved ? "fa-check text-[var(--color-awake)]" : "fa-hand text-muted"
                        )}
                        aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                        <span className="text-primary">{sessionWhere(s)}</span>
                        <span className="text-muted">
                            {" · "}
                            {s.approved
                                ? t("keepawake.approvedAuto")
                                : s.reason
                                  ? t("keepawake.stillAsksYouWhy", { reason: approvalReasonText(s) })
                                  : t("keepawake.stillAsksYou")}
                        </span>
                    </span>
                </span>
            ))}
            {summary ? <span className="text-11 text-secondary">{summary}</span> : null}
            {approvals.slice(0, MaxListedApprovals).map((a) => (
                <span key={a.id} className="flex min-w-0 flex-col text-11" title={approvalTitle(a)}>
                    <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="shrink-0 text-muted">{formatClock(a.at)}</span>
                        <span className={cn("shrink-0", a.outcome === "approved" ? "text-secondary" : "text-primary")}>
                            {a.outcome === "approved" ? t("keepawake.approved") : t("keepawake.askedYou")}
                        </span>
                        <span className="min-w-0 truncate font-mono text-11 text-secondary">{describeApproval(a)}</span>
                    </span>
                    {a.outcome === "asked" && a.reason ? (
                        <span className="truncate pl-10 text-11 text-muted">{approvalReasonText(a)}</span>
                    ) : null}
                </span>
            ))}
            {approvals.length > 0 ? (
                <span className="text-11 text-muted">{t("keepawake.everyDecision", { log: approvalLogText() })}</span>
            ) : null}
        </li>
    );
}

// The sleep indicator (FR-SHELL-103): a cup that exists only while MoltenTerm keeps the computer awake or a terminal's
// block went through. Its name says what holds it and the current option; a click opens Preferences › Energy, where the
// four options live. It opens nothing of its own, so there is no pressed state to leave behind. The workspace sidebar
// (#1183) draws it as a 28 px icon button, with a count when more than one thing holds.
export function KeepAwakeStatusItem({ variant = "status" }: { variant?: "status" | "sidebar" }) {
    const platform = usePlatform();
    const state = useAtomValue(KeepAwakeModel.getInstance().stateAtom);
    const policy = useSettingsKeyAtom(SleepPolicySetting);
    if (!coffeeSupported(platform) || !keepAwakeActive(state)) {
        return null;
    }
    const count = keepAwakeCount(state);
    const sidebar = variant === "sidebar";
    return (
        <button
            type="button"
            aria-label={keepAwakeIndicatorLabel(state)}
            title={keepAwakeIndicatorTitle(state, policy ?? "")}
            data-testid="keepawake-item"
            onClick={() => fireAndForget(() => openSettingsKey("general", SleepPolicySetting))}
            style={sidebar ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
            className={cn(
                "flex cursor-pointer items-center gap-1 rounded-6 text-[var(--color-awake)] hover:bg-hover hover:text-primary",
                sidebar ? "relative h-7 w-7 shrink-0 justify-center transition-colors duration-120 ease-mt" : "px-1"
            )}
        >
            <i className={cn("fa fa-solid fa-mug-hot", sidebar ? "text-icon-14" : "text-11")} aria-hidden />
            {count > 1 && !sidebar ? <span>{count}</span> : null}
            {count > 1 && sidebar ? (
                <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-primary/85 px-[3px] text-11 leading-none font-semibold text-[var(--mt-text-inverse)] tabular-nums">
                    {count}
                </span>
            ) : null}
        </button>
    );
}
