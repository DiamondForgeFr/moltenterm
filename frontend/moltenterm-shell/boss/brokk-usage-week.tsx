// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The usage block under Brokk's square as a week grid (FR-BOSS-009, AC48 to AC51, #2100): the initials of the calendar
// week once on top, Monday to Sunday, today's emphasised, then one row per provider with its logo, seven day blocks and
// its percent. The reset day's block is the start (0 %): the fill runs from it forward round the week, and it carries an
// accent ring and a slow sheen. Today's column stands out on every row. The fill and the percent take the colour of the
// pace, from on pace (success) to running out before the reset (error). No detail on hover: a click opens the Usage panel (the button around it,
// brokk-group.tsx).

import ClaudeColorSvg from "@/app/asset/claude-color.svg";
import { cn, makeIconClass } from "@/util/util";
import { CSSProperties } from "react";
import { AiIcon } from "../ai-icon";
import { usageReasonText } from "../companion/companion-gauges-model";
import { relativeTime } from "../companion/companion-model";
import { agentName } from "../companion/companion-task-model";
import { useLocale, useT } from "../i18n/i18n";
import {
    dayFills,
    paceColour,
    PaceRedAt,
    resetDay,
    startIndex,
    weekdayIndex,
    WeekDayKeys,
    WeeklyUsage,
} from "./brokk-usage-model";

// The agents whose own logo MoltenTerm already ships; the others show the AI icon the launcher gives every agent.
function AgentLogo({ provider }: { provider: string }) {
    if (provider === "claude") {
        return (
            <span className="mt-brokk-uw-logo" data-testid="brokk-usage-logo" data-logo="claude" aria-hidden>
                <ClaudeColorSvg />
            </span>
        );
    }
    return (
        <span className="mt-brokk-uw-logo" data-testid="brokk-usage-logo" data-logo="ai" aria-hidden>
            <i className={makeIconClass(AiIcon, true)} />
        </span>
    );
}

export function BrokkUsageWeek({ rows, now, id }: { rows: WeeklyUsage[]; now: number; id?: string }) {
    const t = useT();
    const locale = useLocale();
    const today = weekdayIndex(now);
    return (
        <span className="mt-brokk-uw" id={id} data-testid="brokk-usage-week">
            <span aria-hidden />
            {WeekDayKeys.map((key, i) => (
                <span
                    key={key}
                    className="mt-brokk-uw-day"
                    aria-hidden
                    data-testid="brokk-usage-day"
                    data-today={i === today ? "true" : undefined}
                >
                    {t(`boss.group.usage.day.${key}`)}
                </span>
            ))}
            <span aria-hidden />
            {rows.map((u) => {
                const name = agentName(u.provider);
                if (u.unreadable) {
                    const label = t("boss.group.usage.rowUnreadable", {
                        name,
                        reason: usageReasonText(u.unreadable, u.provider),
                    });
                    return (
                        <span
                            key={u.provider}
                            className="mt-brokk-uw-row"
                            role="img"
                            aria-label={label}
                            data-testid="brokk-usage-cell"
                            data-provider={u.provider}
                            data-unreadable="true"
                        >
                            <AgentLogo provider={u.provider} />
                            <span className="mt-brokk-uw-note" data-testid="brokk-usage-unreadable">
                                {t("boss.group.usage.unreadable")}
                            </span>
                        </span>
                    );
                }
                const reset = startIndex(u.resetsAt, u.windowMins);
                const day = resetDay(u.resetsAt, locale);
                const age = u.old ? relativeTime(u.readAt, now) : "";
                const parts = [
                    day
                        ? t("boss.group.usage.rowReset", { name, percent: u.percent, day })
                        : t("boss.group.usage.row", { name, percent: u.percent }),
                ];
                if (age) {
                    parts.push(t("boss.group.usage.rowAsOf", { ago: age }));
                }
                return (
                    <span
                        key={u.provider}
                        className="mt-brokk-uw-row"
                        role="img"
                        aria-label={parts.join(", ")}
                        style={{ "--mt-brokk-pace": paceColour(u.pace) } as CSSProperties}
                        data-pace={u.pace > 1 ? (u.pace > PaceRedAt ? "red" : "above") : "ok"}
                        data-old={u.old ? "true" : undefined}
                        data-testid="brokk-usage-cell"
                        data-provider={u.provider}
                    >
                        <AgentLogo provider={u.provider} />
                        {dayFills(u.percent, reset).map((fill, i) => (
                            <span
                                key={i}
                                className={cn("mt-brokk-uw-cell", i === today && "is-today", i === reset && "is-reset")}
                                data-testid="brokk-usage-block"
                                data-today={i === today ? "true" : undefined}
                                data-reset={i === reset ? "true" : undefined}
                            >
                                <i style={{ width: `${Math.round(fill * 1000) / 10}%` }} />
                            </span>
                        ))}
                        <b className="mt-brokk-uw-pct" data-testid="brokk-usage-percent">
                            {t("boss.group.usage.percent", { percent: u.percent })}
                        </b>
                    </span>
                );
            })}
        </span>
    );
}
