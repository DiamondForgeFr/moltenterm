// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// "Quand Brokk vient me chercher" (When he comes to fetch me): the table of Preferences › Brokk (FR-BOSS-009, AC4,
// #2003). One line per event, set to Vient, Badge or Rien; the threshold after which a waiting agent counts as blocked;
// the quiet hours; the master switch; and the line that says severity sets his face and the delays of Plus tard, never
// the words. Each control writes the key of the visit model (brokk-visit-events.ts VisitSettingKeys) and the model reads
// it at once. The panel's menu opens this card.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { writeSettings } from "../command-panel/bindings";
import { useT } from "../i18n/i18n";
import type { SettingEntry } from "../settings/settings-catalog";
import { parseClock } from "./brokk-mood";
import {
    BlockedThresholdsMin,
    Coming,
    ComingValues,
    DefaultBlockedMin,
    DefaultComing,
    DefaultVisitSettings,
    SettingIds,
    VisitSettingKeys,
    visitSettingsOf,
} from "./brokk-visit-events";

// The group of settingsmeta.go that this card draws; must match BrokkTableGroup there.
export const BrokkTableGroup = "When he comes to fetch me";
// The first key of the group, which the screen looks for to draw the card in place of the group's rows.
export const BrokkTableKey = VisitSettingKeys.coming.security;

const ComingColumns: Coming[] = ComingValues;

export function clockText(minutes: number): string {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// What each control writes, as the key and value of settings.json; null writes nothing (an invalid or unchanged value).
export function comingChange(key: string, choice: Coming): Record<string, unknown> {
    return ComingValues.includes(choice) ? { [key]: choice } : null;
}

export function thresholdChange(key: string, minutes: number): Record<string, unknown> {
    return BlockedThresholdsMin.includes(minutes) ? { [key]: minutes } : null;
}

export function switchChange(key: string, on: boolean): Record<string, unknown> {
    return { [key]: on };
}

export function clockChange(key: string, text: string, current: number): Record<string, unknown> {
    const minutes = parseClock(text);
    return minutes == null || minutes === current ? null : { [key]: clockText(minutes) };
}

function write(values: Record<string, unknown>): void {
    if (values != null) {
        fireAndForget(() => writeSettings(values));
    }
}

function ComingRow({ entry, value }: { entry: SettingEntry; value: Coming }) {
    const t = useT();
    return (
        <div
            role="radiogroup"
            aria-label={entry.label}
            className="grid grid-cols-[1fr_repeat(3,5.5rem)] items-center gap-x-2 border-b border-line-strong py-1.5"
            data-testid="brokk-coming-row"
            data-setting={entry.key}
        >
            <div className="min-w-0">
                <div className="text-12 text-primary">{entry.label}</div>
                <div className="text-11 text-muted">{entry.description}</div>
            </div>
            {ComingColumns.map((choice) => {
                const label = entry.options?.find((o) => o.value === choice)?.label ?? t(`boss.coming.${choice}`);
                return (
                    <label
                        key={choice}
                        className={cn(
                            "flex cursor-pointer items-center justify-center gap-1.5 rounded-4 py-1 text-11 hover:bg-hover",
                            value === choice ? "text-primary" : "text-muted"
                        )}
                    >
                        <input
                            type="radio"
                            name={entry.key}
                            checked={value === choice}
                            aria-label={`${entry.label}: ${label}`}
                            data-testid="brokk-coming-choice"
                            data-value={choice}
                            className="cursor-pointer accent-[var(--mt-action)]"
                            onChange={() => write(comingChange(entry.key, choice))}
                        />
                        <span aria-hidden>{t(`boss.coming.${choice}`)}</span>
                    </label>
                );
            })}
        </div>
    );
}

function ClockField({ entry, value }: { entry: SettingEntry; value: number }) {
    const [draft, setDraft] = useState<string>(null);
    const text = draft ?? clockText(value);
    const commit = () => {
        const typed = draft;
        setDraft(null);
        if (typed != null) {
            write(clockChange(entry.key, typed, value));
        }
    };
    return (
        <input
            type="text"
            inputMode="numeric"
            value={text}
            maxLength={5}
            aria-label={entry.label}
            data-testid="brokk-coming-clock"
            data-setting={entry.key}
            className="h-row w-16 rounded-4 border border-line-strong bg-transparent px-2 text-center text-12 text-primary outline-none focus:border-accent"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    commit();
                }
            }}
        />
    );
}

function SwitchRow({ entry, on }: { entry: SettingEntry; on: boolean }) {
    return (
        <div className="flex items-center gap-3 border-b border-line-strong py-1.5" data-setting={entry.key}>
            <div className="min-w-0 flex-1">
                <div className="text-12 text-primary">{entry.label}</div>
                <div className="text-11 text-muted">{entry.description}</div>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={entry.label}
                data-testid="brokk-coming-switch"
                data-setting={entry.key}
                onClick={() => write(switchChange(entry.key, !on))}
                className="inline-flex h-row shrink-0 cursor-pointer items-center rounded-4 px-1"
            >
                <span className={cn("molten-cmdpanel-switch", on && "is-on")} aria-hidden />
            </button>
        </div>
    );
}

export function BrokkComingCard({ entries, settings }: { entries: SettingEntry[]; settings: Record<string, unknown> }) {
    const t = useT();
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    const current = visitSettingsOf((key) => settings?.[key]);
    const threshold = byKey.get(VisitSettingKeys.blockedMin);
    const quiet = byKey.get(VisitSettingKeys.quiet);
    const quietFrom = byKey.get(VisitSettingKeys.quietFrom);
    const quietTo = byKey.get(VisitSettingKeys.quietTo);
    const never = byKey.get(VisitSettingKeys.never);
    return (
        <div className="px-5 py-3" data-testid="brokk-coming-card">
            <p className="pb-2 text-11 text-muted">{t("boss.coming.intro")}</p>
            <div className="grid grid-cols-[1fr_repeat(3,5.5rem)] gap-x-2 border-b border-line-strong pb-1 text-11 text-muted uppercase">
                <span>{t("boss.coming.event")}</span>
                {ComingColumns.map((choice) => (
                    <span key={choice} className="text-center">
                        {t(`boss.coming.${choice}`)}
                    </span>
                ))}
            </div>
            {SettingIds.map((id) => {
                const entry = byKey.get(VisitSettingKeys.coming[id]);
                return entry == null ? null : (
                    <ComingRow key={id} entry={entry} value={current.coming[id] ?? DefaultComing[id]} />
                );
            })}
            {threshold != null ? (
                <div
                    className="flex items-center gap-3 border-b border-line-strong py-1.5"
                    data-setting={threshold.key}
                >
                    <div className="min-w-0 flex-1">
                        <div className="text-12 text-primary">{threshold.label}</div>
                        <div className="text-11 text-muted">{threshold.description}</div>
                    </div>
                    <select
                        aria-label={threshold.label}
                        value={String(current.blockedMin ?? DefaultBlockedMin)}
                        data-testid="brokk-coming-threshold"
                        onChange={(e) => write(thresholdChange(threshold.key, Number(e.target.value)))}
                        className="h-row max-w-56 min-w-0 cursor-pointer rounded-4 border border-line-strong bg-surface-2 px-2 text-12 text-primary outline-none focus:border-accent"
                    >
                        {BlockedThresholdsMin.map((minutes) => (
                            <option key={minutes} value={String(minutes)}>
                                {threshold.options?.find((o) => o.value === String(minutes))?.label ?? `${minutes}`}
                            </option>
                        ))}
                    </select>
                </div>
            ) : null}
            {quiet != null ? <SwitchRow entry={quiet} on={current.quiet.on} /> : null}
            {quietFrom != null && quietTo != null ? (
                <div className="flex items-center gap-2 border-b border-line-strong py-1.5">
                    <span className="flex-1 text-12 text-primary">{t("boss.coming.quietBetween")}</span>
                    <ClockField entry={quietFrom} value={current.quiet.from ?? DefaultVisitSettings.quiet.from} />
                    <span className="text-12 text-muted" aria-hidden>
                        →
                    </span>
                    <ClockField entry={quietTo} value={current.quiet.to ?? DefaultVisitSettings.quiet.to} />
                </div>
            ) : null}
            {never != null ? <SwitchRow entry={never} on={current.never} /> : null}
            <p className="pt-2 text-11 text-muted" data-testid="brokk-coming-severity">
                {t("boss.coming.severity")}
            </p>
        </div>
    );
}
