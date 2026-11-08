// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Settings > Mods (FR-PERF-014): the mods this tab view runs, their state, commands and errors, and what each costs
// against its budget (molten-budget.ts). A mod over budget carries a badge and the measured numbers. Mods are enabled
// and disabled with molten, so the section only reads, with one exception: a mod that runs code shows whether the
// user trusted it, and offers to take that trust back (FR-MORPH-004, #1880).

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { memo, useEffect } from "react";
import {
    budgetReasonText,
    MoltenBudgetCpuPct,
    MoltenBudgetMemoryMB,
    MoltenBudgetWindowMs,
    MoltenModUsage,
} from "../../molten/molten-budget";
import { MoltenHost, MoltenModStatus } from "../../molten/molten-host";
import { formatTrustDate } from "../../molten/molten-trust-store";
import { EmptyState } from "../empty-state";
import { formatNumber, getLocale, TFunction, t as translateNow, useLocale, useT } from "../i18n/i18n";
import { translateCount } from "../i18n/i18n-core";
import { DominoLoader } from "../suite/suite";
import { suiteIcon } from "../suite/suite-icons";
import { ModRevokeNote, ModRevokeRow, ModsRevokeModel } from "./settings-mods-model";
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

// One object for every row without a revoke in progress, so that memo keeps them from rendering again.
const IdleRevoke: ModRevokeRow = { busy: false };
const FocusRing =
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring)";
// A calm action: bordered, never the destructive red, since trust can be given again.
const RevokeButton = cn(
    "inline-flex shrink-0 cursor-pointer items-center rounded-4 border border-border px-2 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-60",
    FocusRing
);

// What a row says about the user's trust in the mod's code; empty for a mod that needs none (built-in, data only).
export function modTrustText(
    mod: MoltenModStatus,
    t: TFunction = translateNow,
    locale: string = getLocale(),
    timeZone?: string
): string {
    if (mod.trusted == null) {
        return "";
    }
    if (!mod.trusted) {
        return t("settings.mods.trust.notTrusted");
    }
    const date = mod.trustedat ? formatTrustDate(mod.trustedat, locale, timeZone) : "";
    return date ? t("settings.mods.trust.trustedOn", { date }) : t("settings.mods.trust.trusted");
}

function RevokeNote({ id, note }: { id: string; note: ModRevokeNote }) {
    const t = useT();
    const failed = note.kind === "failed";
    return (
        <div
            role={failed ? "alert" : "status"}
            className={cn(
                "flex items-start gap-2 rounded-4 border px-2.5 py-1.5 text-11",
                failed ? "border-danger/40 text-danger" : "border-border bg-surface-2 text-secondary"
            )}
            data-mod-note={note.kind}
        >
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {failed ? t("settings.mods.trust.failed", { error: note.message }) : t("settings.mods.trust.revoked")}
            </span>
            <button
                type="button"
                className={cn("shrink-0 cursor-pointer rounded-4 p-0.5 text-muted hover:text-primary", FocusRing)}
                aria-label={t("settings.mods.trust.dismiss")}
                onClick={() => ModsRevokeModel.getInstance().dismiss(id)}
            >
                <X className="h-3 w-3" aria-hidden />
            </button>
        </div>
    );
}

const ModRow = memo(({ mod, revoke }: { mod: MoltenModStatus; revoke: ModRevokeRow }) => {
    const t = useT();
    const locale = useLocale();
    const failed = mod.state === "failed" || mod.state === "refused";
    const over = mod.usage?.over;
    const trustText = modTrustText(mod, t, locale);
    // The inline confirmation stays until it is closed, unless the user trusts the mod again: then it is out of date.
    const note = mod.trusted === true && revoke.note?.kind === "done" ? null : revoke.note;
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
            {trustText ? (
                <div className="flex min-w-0 items-center gap-2" data-mod-trust={mod.trusted ? "trusted" : "untrusted"}>
                    <span className="min-w-0 truncate text-11 text-muted" title={trustText}>
                        {trustText}
                    </span>
                    {mod.trusted ? (
                        <button
                            type="button"
                            className={RevokeButton}
                            disabled={revoke.busy}
                            title={t("settings.mods.trust.revokeTitle")}
                            data-action="revoke-trust"
                            onClick={() => fireAndForget(() => ModsRevokeModel.getInstance().revoke(mod.id))}
                        >
                            {revoke.busy ? <DominoLoader className="mr-1.5" /> : null}
                            {revoke.busy ? t("settings.mods.trust.revoking") : t("settings.mods.trust.revoke")}
                        </button>
                    ) : null}
                </div>
            ) : null}
            {note != null ? <RevokeNote id={mod.id} note={note} /> : null}
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
    const revokeModel = ModsRevokeModel.getInstance();
    const revokeRows = useAtomValue(revokeModel.rowsAtom);
    useEffect(() => {
        host.checkBudgets();
    }, [host]);
    useEffect(() => {
        revokeModel.forgetOutdated(mods);
    }, [revokeModel, mods]);
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
                mods.map((mod) => <ModRow key={mod.id} mod={mod} revoke={revokeRows[mod.id] ?? IdleRevoke} />)
            )}
        </PageCard>
    );
}
