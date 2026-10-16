// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the windows show of the keep-awake (FR-SHELL-023, DS-SHELL-062; the indicator parts of FR-SHELL-022 it needs,
// DS-SHELL-063): the coffee droplet on a rail item and on a collapsed product, and the status bar's sleep item, whose
// list offers the policy, the coffees ("Kept awake by you", each with Stop) and the blocks the shims reported, with the
// per-session override. The OS-level detection and the marks on panes, tabs and the Sessions view are FR-SHELL-022's.

import { useSettingsKeyAtom } from "@/app/store/global";
import { PLATFORM } from "@/util/platformutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
    keepAwakeCount,
    KeepAwakeSession,
    keepAwakeSessions,
    KeepAwakeState,
    policyHoldingLine,
    sessionWhere,
    SleepPolicy,
    sleepPolicyChoices,
    sleepPolicySentence,
} from "./keepawake-model";
import { KeepAwakeModel } from "./keepawake-store";
import { SegmentedControl } from "./segmented-control";
import { TabActivity, whileShown } from "./tab-activity";

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

function KeepAwakePanel({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
    const t = useT();
    const model = KeepAwakeModel.getInstance();
    const state = useAtomValue(model.stateAtom);
    const policySetting = useSettingsKeyAtom("power:sleeppolicy");
    const platform = usePlatform();
    const now = useNow(true);
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const onPointer = (e: PointerEvent) => {
            const target = e.target as Node;
            if (panelRef.current?.contains(target) || anchor.contains(target)) {
                return;
            }
            onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
                anchor.focus();
            }
        };
        document.addEventListener("pointerdown", onPointer, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("pointerdown", onPointer, true);
            document.removeEventListener("keydown", onKey, true);
        };
    }, [anchor, onClose]);
    const rect = anchor.getBoundingClientRect();
    const sessions = keepAwakeSessions(state);
    return createPortal(
        <div
            ref={panelRef}
            role="dialog"
            aria-label={t("keepawake.panelLabel")}
            data-testid="keepawake-panel"
            className="fixed z-[9600] flex max-h-[70vh] w-[320px] flex-col overflow-y-auto rounded-10 border border-border bg-surface-3 p-3 text-12 text-secondary shadow-command"
            style={{ bottom: window.innerHeight - rect.top + 6, right: Math.max(8, window.innerWidth - rect.right) }}
        >
            <SleepPolicyControl
                platform={platform}
                policy={policySetting ?? ""}
                holding={policyHoldingLine(state, platform, now)}
                onSelect={(policy) => fireAndForget(() => model.setPolicy(policy))}
            />
            {state.coffees.length > 0 ? (
                <ul
                    aria-label={t("keepawake.keptByYou")}
                    className="-mx-1 mt-2 flex flex-col border-t border-border pt-2"
                >
                    {state.coffees.map((coffee) => (
                        <li
                            key={coffee.workspaceid}
                            className="flex items-center gap-2 rounded-6 px-1 py-1 hover:bg-hover"
                        >
                            <i className="fa fa-solid fa-mug-hot text-11 text-[var(--color-awake)]" aria-hidden />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-primary">
                                    {coffee.workspacename || t("keepawake.workspace")}
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
                                    name: coffee.workspacename || t("keepawake.thisWorkspace"),
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
                    className="-mx-1 mt-2 flex flex-col border-t border-border pt-2"
                >
                    {sessions.map((session) => (
                        <SessionRow key={session.blockid} session={session} now={now} />
                    ))}
                </ul>
            ) : null}
        </div>,
        document.body
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
    const name = coffee.workspacename || t("keepawake.workspace");
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

// The popover's head (DS-SHELL-101): one sentence and the policies as a segmented control, the current one filled;
// each segment's tooltip says what it does. Nothing is filled until the first request asks.
export function SleepPolicyControl({
    platform,
    policy,
    holding,
    onSelect,
}: {
    platform: string;
    policy: string;
    holding?: string;
    onSelect: (policy: SleepPolicy) => void;
}) {
    useT();
    const segments = sleepPolicyChoices(platform).map((c) => ({ value: c.policy, label: c.label, title: c.detail }));
    return (
        <div className="flex flex-col gap-2">
            <div className="text-12 text-primary">{sleepPolicySentence(platform)}</div>
            <SegmentedControl
                label={sleepPolicySentence(platform)}
                segments={segments}
                selected={policy as SleepPolicy}
                onSelect={onSelect}
                className="self-start"
            />
            {holding ? <div className="text-11 text-[var(--color-awake)]">{holding}</div> : null}
        </div>
    );
}

// The status bar's sleep item: lit in the awake colour while MoltenTerm keeps the computer awake, with the count of
// what blocks sleep (MoltenTerm once, plus each session whose block went through).
export function KeepAwakeStatusItem() {
    const t = useT();
    const platform = usePlatform();
    const model = KeepAwakeModel.getInstance();
    const state = useAtomValue(model.stateAtom);
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const close = useCallback(() => setOpen(false), []);
    if (!coffeeSupported(platform)) {
        return null;
    }
    const count = keepAwakeCount(state);
    const title =
        count > 0
            ? t(state.hold ? "keepawake.statusCountIncluded" : "keepawake.statusCount", { count })
            : t("keepawake.statusNone");
    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                aria-label={title}
                aria-expanded={open}
                title={title}
                onClick={() => setOpen(!open)}
                className={cn(
                    "flex cursor-pointer items-center gap-1 rounded-6 px-1 hover:bg-hover hover:text-primary",
                    state.hold && "text-[var(--color-awake)]"
                )}
            >
                <i className={cn("fa fa-solid text-11", state.hold ? "fa-mug-hot" : "fa-moon")} aria-hidden />
                {count > 0 ? <span>{count}</span> : null}
            </button>
            {open && buttonRef.current != null ? <KeepAwakePanel anchor={buttonRef.current} onClose={close} /> : null}
        </>
    );
}
