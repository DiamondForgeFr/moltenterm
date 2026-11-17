// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The providers the usage grid leaves out (FR-BOSS-009, AC95 and AC97, #2341): one quiet line under the grid, "Not used
// lately (N)", opens the list of those providers, each with its plan, its last use and its choices: always show it, and,
// for one the developer hid, give it back to the rules. They are buttons, so the keyboard reaches them as the pointer
// does. The list is the same under the grid and in the usage detail.

import { cn } from "@/util/util";
import { useState } from "react";
import { relativeTime } from "../companion/companion-model";
import { agentName } from "../companion/companion-task-model";
import { useT } from "../i18n/i18n";
import type { HiddenUsage, UsageChoice } from "./brokk-usage-model";

const ChoiceButtonClasses =
    "shrink-0 cursor-pointer rounded-4 px-1.5 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary";

function lastUseText(t: ReturnType<typeof useT>, item: HiddenUsage, now: number): string {
    if (item.lastUse > 0) {
        return t("usageWeek.hidden.lastUse", { ago: relativeTime(item.lastUse, now) });
    }
    return t("usageWeek.hidden.noUse");
}

export function UsageHiddenList({
    items,
    now,
    onChoose,
}: {
    items: HiddenUsage[];
    now: number;
    onChoose: (provider: string, choice: UsageChoice) => void;
}) {
    const t = useT();
    return (
        <ul
            className="mt-1 flex flex-col gap-1"
            aria-label={t("usageWeek.hidden.label")}
            data-testid="brokk-usage-hidden"
        >
            {items.map((item) => {
                const name = agentName(item.provider);
                return (
                    <li
                        key={item.provider}
                        className="flex items-baseline gap-2 text-11"
                        data-testid="brokk-usage-hidden-item"
                        data-provider={item.provider}
                        data-reason={item.reason}
                    >
                        <span className="min-w-0 truncate text-secondary">{name}</span>
                        {item.plan ? <span className="shrink-0 text-muted">{item.plan}</span> : null}
                        {item.reason === "chosen" ? (
                            <span className="shrink-0 text-muted" data-testid="brokk-usage-hidden-chosen">
                                {t("usageWeek.hidden.chosen")}
                            </span>
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-muted" data-testid="brokk-usage-hidden-last">
                            {lastUseText(t, item, now)}
                        </span>
                        <button
                            type="button"
                            className={ChoiceButtonClasses}
                            aria-label={t("usageWeek.hidden.for", { action: t("usageWeek.hidden.alwaysShow"), name })}
                            data-testid="brokk-usage-hidden-show"
                            onClick={() => onChoose(item.provider, "show")}
                        >
                            {t("usageWeek.hidden.alwaysShow")}
                        </button>
                        {item.reason === "chosen" ? (
                            <button
                                type="button"
                                className={ChoiceButtonClasses}
                                aria-label={t("usageWeek.hidden.for", { action: t("usageWeek.hidden.auto"), name })}
                                data-testid="brokk-usage-hidden-auto"
                                onClick={() => onChoose(item.provider, "auto")}
                            >
                                {t("usageWeek.hidden.auto")}
                            </button>
                        ) : null}
                    </li>
                );
            })}
        </ul>
    );
}

// Under the grid: nothing while no provider is left out.
export function UsageHidden({
    items,
    now,
    onChoose,
}: {
    items: HiddenUsage[];
    now: number;
    onChoose: (provider: string, choice: UsageChoice) => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    if (items.length === 0) {
        return null;
    }
    return (
        <div className="mt-1" data-testid="brokk-usage-hidden-block">
            <button
                type="button"
                className={cn(
                    "cursor-pointer rounded-4 py-0.5 text-11 text-muted hover:text-primary",
                    open && "text-secondary"
                )}
                aria-expanded={open}
                data-testid="brokk-usage-hidden-toggle"
                onClick={() => setOpen(!open)}
            >
                {t("usageWeek.hidden.toggle", { count: items.length })}
            </button>
            {open ? <UsageHiddenList items={items} now={now} onChoose={onChoose} /> : null}
        </div>
    );
}
