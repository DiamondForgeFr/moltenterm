// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Settings > Mods (FR-PERF-014): the mods this tab view runs, their state, commands and errors, and what each costs
// against its budget (molten-budget.ts). A mod over budget carries a badge and the measured numbers. Mods are enabled
// and disabled with molten, so the section only reads.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect } from "react";
import {
    budgetReasonText,
    MoltenBudgetCpuPct,
    MoltenBudgetMemoryMB,
    MoltenBudgetWindowMs,
    MoltenModUsage,
} from "../../molten/molten-budget";
import { MoltenHost, MoltenModStatus } from "../../molten/molten-host";
import { EmptyState } from "../empty-state";
import { formatNumber, getLocale, TFunction, t as translateNow, useLocale, useT } from "../i18n/i18n";
import { translateCount } from "../i18n/i18n-core";
import { suiteIcon } from "../suite/suite-icons";
import { PageCard } from "./settings-page";

// The states with a label of their own, under settings.mods.state.
const KnownStates = new Set(["active", "pending", "loading", "disabled", "untrusted", "safemode", "failed", "refused"]);

export function formatModUsage(
    usage: MoltenModUsage,
    t: TFunction = translateNow,
    locale: string = getLocale()
): string {
    if (usage == null) {
        return "";
    }
    const parts = [t("settings.mods.usage.cpu", { pct: formatNumber(usage.cpupct, 1, locale) })];
    parts.push(translateCount(locale, "settings.mods.usage.timers", usage.timers));
    parts.push(t("settings.mods.usage.activation", { ms: formatNumber(Math.round(usage.activatems), 0, locale) }));
    if (usage.heapmb != null) {
        parts.push(t("settings.mods.usage.heap", { mb: formatNumber(usage.heapmb, 1, locale) }));
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
    const t = useT();
    const locale = useLocale();
    const failed = mod.state === "failed" || mod.state === "refused";
    const over = mod.usage?.over;
    return (
        <div className="flex flex-col gap-1 px-5 py-2.5" data-mod={mod.id}>
            <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-12 font-medium text-primary">{mod.name ?? mod.id}</span>
                <span className="truncate font-mono text-11 text-muted">{mod.id}</span>
                {mod.builtin ? <Pill className="bg-surface-2 text-secondary">{t("settings.mods.builtin")}</Pill> : null}
                {mod.background ? (
                    <Pill className="bg-surface-2 text-secondary" title={t("settings.mods.backgroundTitle")}>
                        {t("settings.mods.background")}
                    </Pill>
                ) : null}
                {over ? (
                    <Pill className="bg-warning/10 text-warning" title={budgetReasonText(mod.usage, t, locale)}>
                        {t("settings.mods.overBudget")}
                    </Pill>
                ) : null}
                <span className={cn("ml-auto shrink-0 text-11", failed ? "text-danger" : "text-muted")}>
                    {KnownStates.has(mod.state) ? t(`settings.mods.state.${mod.state}`) : mod.state}
                </span>
            </div>
            {mod.commands.length > 0 ? (
                <div className="truncate font-mono text-11 text-secondary">
                    {mod.commands.map((c) => `molten ${c}`).join(", ")}
                </div>
            ) : null}
            {mod.error ? <div className="text-12 text-danger">{mod.error}</div> : null}
            {mod.usage != null ? (
                <div className={cn("text-11", over ? "text-warning" : "text-muted")} data-mod-usage>
                    {formatModUsage(mod.usage, t, locale)}
                </div>
            ) : null}
            {over ? <div className="text-11 text-warning">{budgetReasonText(mod.usage, t, locale)}</div> : null}
        </div>
    );
});

ModRow.displayName = "ModRow";

export function ModsSection() {
    const t = useT();
    const host = MoltenHost.getInstance();
    const mods = useAtomValue(host.modsAtom);
    useEffect(() => {
        host.checkBudgets();
    }, [host]);
    const intro = (
        <>
            {t("settings.mods.intro", {
                seconds: MoltenBudgetWindowMs / 1000,
                cpu: MoltenBudgetCpuPct,
                mb: MoltenBudgetMemoryMB,
            })}{" "}
            {t("settings.mods.disableHint")} <span className="font-mono">molten mod disable &lt;id&gt;</span>.
        </>
    );
    return (
        <PageCard
            title={t("settings.mods.label")}
            label={t("settings.mods.label")}
            hint={intro}
            icon={suiteIcon("mods")}
            scope="app"
        >
            {mods.length === 0 ? (
                <EmptyState
                    compact
                    className="py-6"
                    icon="puzzle-piece"
                    title={t("settings.mods.none")}
                    hint={t("settings.mods.noneHint")}
                />
            ) : (
                mods.map((mod) => <ModRow key={mod.id} mod={mod} />)
            )}
        </PageCard>
    );
}
