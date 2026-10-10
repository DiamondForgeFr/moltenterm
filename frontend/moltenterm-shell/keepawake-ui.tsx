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
import {
    coffeeCondition,
    coffeeSupported,
    computerName,
    describeAttempt,
    formatCountdown,
    keepAwakeCount,
    KeepAwakeSession,
    keepAwakeSessions,
    KeepAwakeState,
    SleepPolicy,
    sleepPolicyChoices,
    sleepPolicySentence,
} from "./keepawake-model";
import { KeepAwakeModel } from "./keepawake-store";
import { SegmentedControl } from "./segmented-control";

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
        const timer = setInterval(() => setNow(Date.now()), TickMs);
        return () => clearInterval(timer);
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
    const model = KeepAwakeModel.getInstance();
    const value = session.override?.policy ?? "";
    return (
        <li className="flex flex-col gap-0.5 rounded-6 px-2 py-1.5 hover:bg-hover">
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-primary">{session.label}</span>
                <select
                    aria-label={`Sleep policy of ${session.label}`}
                    className="cursor-pointer rounded-6 border border-border bg-transparent px-1 text-11 text-secondary"
                    value={value}
                    onChange={(e) =>
                        fireAndForget(() => model.setOverride(session.blockid, e.target.value as "allow" | "letsleep"))
                    }
                >
                    <option value="">Follows the policy</option>
                    <option value="allow">Allow for this session</option>
                    <option value="letsleep">Let it sleep for this session</option>
                </select>
            </div>
            {session.attempts.map((attempt) => (
                <div key={attempt.id} className="flex items-center gap-2 text-11 text-muted">
                    <span className="min-w-0 flex-1 truncate font-mono" title={describeAttempt(attempt)}>
                        {describeAttempt(attempt)}
                        {attempt.parentname ? ` · from ${attempt.parentname}` : ""}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatSince(attempt.since, now)}</span>
                    <span
                        className={cn(
                            "shrink-0",
                            attempt.outcome === "allowed" ? "text-[var(--color-awake)]" : "text-secondary"
                        )}
                    >
                        {attempt.outcome === "allowed" ? "Allowed" : "Stopped"}
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
        return "now";
    }
    if (minutes < 60) {
        return `${minutes} min`;
    }
    return formatClock(since);
}

function KeepAwakePanel({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
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
            aria-label="Keep awake"
            data-testid="keepawake-panel"
            className="fixed z-[9600] flex max-h-[70vh] w-[320px] flex-col overflow-y-auto rounded-10 border border-border bg-surface-3 p-3 text-12 text-secondary shadow-e2"
            style={{ bottom: window.innerHeight - rect.top + 6, right: Math.max(8, window.innerWidth - rect.right) }}
        >
            <SleepPolicyControl
                platform={platform}
                policy={policySetting ?? ""}
                holding={holdingLine(state, platform, now)}
                onSelect={(policy) => fireAndForget(() => model.setPolicy(policy))}
            />
            {state.coffees.length > 0 ? (
                <ul aria-label="Kept awake by you" className="-mx-1 mt-2 flex flex-col border-t border-border pt-2">
                    {state.coffees.map((coffee) => (
                        <li
                            key={coffee.workspaceid}
                            className="flex items-center gap-2 rounded-6 px-1 py-1 hover:bg-hover"
                        >
                            <i className="fa fa-solid fa-mug-hot text-11 text-[var(--color-awake)]" aria-hidden />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-primary">{coffee.workspacename || "Workspace"}</span>
                                <span className="truncate text-11 text-muted">
                                    since {formatClock(coffee.since)} · {coffeeCondition(coffee, now)}
                                </span>
                            </span>
                            <button
                                type="button"
                                className="shrink-0 cursor-pointer rounded-6 border border-border px-1.5 text-11 text-secondary hover:bg-hover hover:text-primary"
                                aria-label={`Stop keeping ${computerName(platform)} awake for ${coffee.workspacename || "this workspace"}`}
                                onClick={() => fireAndForget(() => model.setCoffee(coffee.workspaceid, false))}
                            >
                                Stop
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
            {sessions.length > 0 ? (
                <ul aria-label="Terminals that asked" className="-mx-1 mt-2 flex flex-col border-t border-border pt-2">
                    {sessions.map((session) => (
                        <SessionRow key={session.blockid} session={session} now={now} />
                    ))}
                </ul>
            ) : null}
        </div>,
        document.body
    );
}

// What the policy holds right now, in a few words; "" while it holds nothing.
function holdingLine(state: KeepAwakeState, platform: string, now: number): string {
    if (!state.policyholding) {
        return "";
    }
    if (state.policyworking || !state.policyendsat) {
        return `Holding ${computerName(platform)} awake while work runs`;
    }
    return `Holding ${computerName(platform)} awake, ending in ${formatCountdown(state.policyendsat, now)}`;
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
            ? `${count} keeping ${computerName(platform)} awake${state.hold ? " (MoltenTerm included)" : ""}`
            : `Sleep: nothing keeps ${computerName(platform)} awake`;
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
