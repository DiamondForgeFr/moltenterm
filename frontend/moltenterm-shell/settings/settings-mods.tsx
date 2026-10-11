// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Settings > Mods (FR-PERF-014): the mods this tab view runs, their state, commands and errors, and what each costs
// against its budget (molten-budget.ts). A mod over budget carries a badge and the measured numbers. Mods are enabled
// and disabled with molten, so the section only reads.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect } from "react";
import {
    MoltenBudgetCpuPct,
    MoltenBudgetMemoryMB,
    MoltenBudgetWindowMs,
    MoltenModUsage,
} from "../../molten/molten-budget";
import { MoltenHost, MoltenModStatus } from "../../molten/molten-host";
import { EmptyState } from "../empty-state";

const StateLabels: Record<string, string> = {
    active: "Running",
    pending: "Loads when this tab shows",
    loading: "Loading",
    disabled: "Off",
    untrusted: "Not trusted",
    safemode: "Off (safe mode)",
    failed: "Stopped",
    refused: "Refused",
};

export function formatModUsage(usage: MoltenModUsage): string {
    if (usage == null) {
        return "";
    }
    const parts = [`${usage.cpupct.toFixed(1)} % CPU idle`];
    parts.push(usage.timers === 1 ? "1 timer" : `${usage.timers} timers`);
    parts.push(`activation ${Math.round(usage.activatems)} ms`);
    if (usage.heapmb != null) {
        parts.push(`${usage.heapmb.toFixed(1)} MB at activation`);
    }
    return parts.join(" · ");
}

function Pill({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
    return (
        <span
            className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-11", className)}
            title={title}
        >
            {children}
        </span>
    );
}

const ModRow = memo(({ mod }: { mod: MoltenModStatus }) => {
    const failed = mod.state === "failed" || mod.state === "refused";
    const over = mod.usage?.over;
    return (
        <div className="flex flex-col gap-1 border-b border-line px-2 py-2.5 last:border-b-0" data-mod={mod.id}>
            <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-12 font-medium text-primary">{mod.name ?? mod.id}</span>
                <span className="truncate font-mono text-11 text-muted">{mod.id}</span>
                {mod.builtin ? <Pill className="bg-surface-2 text-secondary">Built-in</Pill> : null}
                {mod.background ? (
                    <Pill className="bg-surface-2 text-secondary" title="Keeps running while its tab is hidden">
                        Background
                    </Pill>
                ) : null}
                {over ? (
                    <Pill className="bg-warning/10 text-warning" title={mod.usage.reason}>
                        Over budget
                    </Pill>
                ) : null}
                <span className={cn("ml-auto shrink-0 text-11", failed ? "text-error" : "text-muted")}>
                    {StateLabels[mod.state] ?? mod.state}
                </span>
            </div>
            {mod.commands.length > 0 ? (
                <div className="truncate font-mono text-11 text-secondary">
                    {mod.commands.map((c) => `molten ${c}`).join(", ")}
                </div>
            ) : null}
            {mod.error ? <div className="text-12 text-error">{mod.error}</div> : null}
            {mod.usage != null ? (
                <div className={cn("text-11", over ? "text-warning" : "text-muted")} data-mod-usage>
                    {formatModUsage(mod.usage)}
                </div>
            ) : null}
            {over ? <div className="text-11 text-warning">{mod.usage.reason}</div> : null}
        </div>
    );
});

ModRow.displayName = "ModRow";

export function ModsSection() {
    const host = MoltenHost.getInstance();
    const mods = useAtomValue(host.modsAtom);
    useEffect(() => {
        host.checkBudgets();
    }, [host]);
    return (
        <section aria-label="Mods" className="flex flex-col">
            <p className="px-2 pt-2 text-12 text-muted">
                Each mod's cost in this tab: idle CPU over the last {MoltenBudgetWindowMs / 1000} s and the memory its
                activation took. The budget is {MoltenBudgetCpuPct} % CPU and {MoltenBudgetMemoryMB} MB. Turn a mod off
                with <span className="font-mono">molten mod disable &lt;id&gt;</span>.
            </p>
            {mods.length === 0 ? (
                <EmptyState
                    compact
                    className="pt-6"
                    icon="puzzle-piece"
                    title="No mods"
                    hint="Ask your coding agent for one with /morph."
                />
            ) : (
                <div className="pt-3">
                    {mods.map((mod) => (
                        <ModRow key={mod.id} mod={mod} />
                    ))}
                </div>
            )}
        </section>
    );
}
