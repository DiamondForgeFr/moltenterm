// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The usage detail of Brokk's group (FR-BOSS-009, AC20, FR-BOSS-006, #2003, #2032): the plan usage of every provider that
// shares a reading (the companion's gauges, FR-SHELL-027), every window with its percent, its bar and its reset time, the
// most used first, as the grid under the square orders them (AC93, #2341). The providers that were not used lately are
// listed apart, under "Not used lately", with their last use (AC97). It opens from a click on the weekly block under the
// square. It asks for nothing: a provider with no reading has no line, and no reading at all is one line saying so.

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agentName } from "../companion/companion-task-model";
import { useT } from "../i18n/i18n";
import { TabActivity, whileShown } from "../tab-activity";
import { UsageReadingsAtom, UsageUnreadableAtom, UsageUseAtom } from "./boss-usage";
import { choicesOf, chooseUsage } from "./brokk-usage-choices";
import { UsageHiddenList } from "./brokk-usage-hidden";
import { UsageChoice, usageGrid, usageProviders } from "./brokk-usage-model";

// How often the reset times are read again while the tab shows.
const UsageTickMs = 30000;

const LevelBarClasses: Record<string, string> = {
    normal: "bg-accent",
    warning: "bg-warning",
    error: "bg-error",
};

export function BrokkUsageTab() {
    const t = useT();
    const readings = useAtomValue(UsageReadingsAtom, { store: globalStore });
    const unreadable = useAtomValue(UsageUnreadableAtom, { store: globalStore });
    const use = useAtomValue(UsageUseAtom, { store: globalStore });
    const usageShow = useAtomValue(getSettingsKeyAtom("boss:usageshow"), { store: globalStore });
    const usageHide = useAtomValue(getSettingsKeyAtom("boss:usagehide"), { store: globalStore });
    const [now, setNow] = useState(Date.now());
    useEffect(() => TabActivity.getInstance().every(whileShown(UsageTickMs), () => setNow(Date.now()), "clock"), []);
    const ctx = useMemo(() => ({ use, choices: choicesOf(usageShow, usageHide) }), [use, usageShow, usageHide]);
    const providers = useMemo(() => usageProviders(readings, now, ctx), [readings, now, ctx]);
    const hidden = useMemo(() => usageGrid(readings, now, unreadable, ctx).hidden, [readings, now, unreadable, ctx]);
    const chooseProvider = useCallback(
        (provider: string, choice: UsageChoice) => fireAndForget(() => chooseUsage(provider, choice)),
        []
    );
    if (providers.length === 0 && hidden.length === 0) {
        return (
            <div className="px-3 py-3 text-12 text-secondary" data-testid="brokk-usage-empty">
                {t("boss.panel.usage.empty")}
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-3 px-3 py-2">
            {providers.length === 0 ? (
                <div className="text-12 text-secondary" data-testid="brokk-usage-empty">
                    {t("boss.panel.usage.empty")}
                </div>
            ) : (
                <ul className="flex flex-col gap-3" data-testid="brokk-usage-list">
                    {providers.map((provider) => (
                        <li key={provider.id} data-testid="brokk-usage-provider" data-provider={provider.id}>
                            <div className="flex items-baseline gap-2">
                                <span className="text-12 font-medium text-primary">{agentName(provider.id)}</span>
                                {provider.plan ? <span className="text-11 text-muted">{provider.plan}</span> : null}
                            </div>
                            <ul className="mt-1 flex flex-col gap-1.5">
                                {provider.rows.map((row) => (
                                    <li key={row.id} data-testid="brokk-usage-row" data-level={row.level}>
                                        <div className="flex items-baseline gap-2 text-11">
                                            <span className="min-w-0 flex-1 truncate text-secondary">{row.label}</span>
                                            <span className="shrink-0 text-primary tabular-nums">
                                                {row.percentShort}
                                            </span>
                                            {row.resetsShort ? (
                                                <span className="shrink-0 text-muted">{row.resetsShort}</span>
                                            ) : null}
                                        </div>
                                        <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-hover" aria-hidden>
                                            <div
                                                className={cn("h-full rounded-full", LevelBarClasses[row.level])}
                                                style={{ width: `${row.bar}%` }}
                                            />
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </li>
                    ))}
                </ul>
            )}
            {hidden.length > 0 ? (
                <section data-testid="brokk-usage-not-used">
                    <h3 className="text-11 font-medium text-muted">{t("usageWeek.hidden.title")}</h3>
                    <UsageHiddenList items={hidden} now={now} onChoose={chooseProvider} />
                </section>
            ) : null}
        </div>
    );
}
