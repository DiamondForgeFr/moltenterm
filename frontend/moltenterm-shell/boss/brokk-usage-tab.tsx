// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Usage tab of Brokk's panel (FR-BOSS-009, AC9, FR-BOSS-006, #2003): the plan usage of every provider that shares a
// reading (the companion's gauges, FR-SHELL-027), the fullest first. It asks for nothing: a provider with no reading has
// no line, and no reading at all is one line saying so.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { agentName } from "../companion/companion-task-model";
import { useT } from "../i18n/i18n";
import { TabActivity, whileShown } from "../tab-activity";
import { UsageReadingsAtom } from "./boss-usage";
import { usageProviders } from "./brokk-panel-model";

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
    const [now, setNow] = useState(Date.now());
    useEffect(() => TabActivity.getInstance().every(whileShown(UsageTickMs), () => setNow(Date.now()), "clock"), []);
    const providers = useMemo(() => usageProviders(readings, now), [readings, now]);
    if (providers.length === 0) {
        return (
            <div className="px-3 py-3 text-12 text-secondary" data-testid="brokk-usage-empty">
                {t("boss.panel.usage.empty")}
            </div>
        );
    }
    return (
        <ul className="flex flex-col gap-3 px-3 py-2" data-testid="brokk-usage-list">
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
                                    <span className="shrink-0 text-primary tabular-nums">{row.percentShort}</span>
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
    );
}
