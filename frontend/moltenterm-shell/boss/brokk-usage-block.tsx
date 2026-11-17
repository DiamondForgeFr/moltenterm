// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The usage block under Brokk's square (FR-BOSS-009, AC17, AC20, AC48 to AC51 and AC93 to AC98, #2100, #2341): the week grid
// of the providers that share a reading, the most used first, and under it the quiet line of the providers not used lately.
// It reads the readings, the use of each agent over 7 days and the developer's choices itself, so the group only draws it.
//
// It loads on demand: the group asks for it once the window is up (preloadUsageBlock in brokk-group.tsx), outside the
// JavaScript every view loads up front (NFR-PERF-003, bundle.initialJsMB).

import { ContextMenuModel } from "@/app/store/contextmenu";
import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { agentName } from "../companion/companion-task-model";
import { useT } from "../i18n/i18n";
import { UsageWeekGrid, UsageWeekRow } from "../usage-week/usage-week";
import { UsageReadingsAtom, UsageUnreadableAtom, UsageUseAtom } from "./boss-usage";
import { choiceOf, choicesOf, UsageChoice, UsageChoices } from "./brokk-usage-choice";
import { chooseUsage, usageChoiceMenu } from "./brokk-usage-choices";
import { UsageHidden } from "./brokk-usage-hidden";
import { usageGrid, WeeklyUsage } from "./brokk-usage-model";

// A provider's row in the shared week grid, named with its agent's display name. Its context menu is the developer's
// choice of showing it always, hiding it, or leaving it to the rules (AC97, #2341).
export function weekRow(u: WeeklyUsage, choices: UsageChoices): UsageWeekRow {
    const { provider, readAt, old, stale, unreadable, ...line } = u;
    const name = agentName(provider);
    return {
        key: provider,
        agent: provider,
        name,
        line: unreadable ? undefined : line,
        unreadable,
        readAt,
        old,
        stale,
        onContextMenu: (e) => {
            e.preventDefault();
            e.stopPropagation();
            ContextMenuModel.getInstance().showContextMenu(
                usageChoiceMenu(provider, name, choiceOf(choices, provider)),
                e
            );
        },
    };
}

export function UsageBlock({ now }: { now: number }) {
    const t = useT();
    const readings = useAtomValue(UsageReadingsAtom, { store: globalStore });
    const unreadable = useAtomValue(UsageUnreadableAtom, { store: globalStore });
    const use = useAtomValue(UsageUseAtom, { store: globalStore });
    const usageShow = useAtomValue(getSettingsKeyAtom("boss:usageshow"), { store: globalStore });
    const usageHide = useAtomValue(getSettingsKeyAtom("boss:usagehide"), { store: globalStore });
    const choices = useMemo(() => choicesOf(usageShow, usageHide), [usageShow, usageHide]);
    const grid = useMemo(
        () => usageGrid(readings, now, unreadable, { use, choices }),
        [readings, now, unreadable, use, choices]
    );
    const weekRows = useMemo(() => grid.rows.map((u) => weekRow(u, choices)), [grid, choices]);
    const choose = useCallback(
        (provider: string, choice: UsageChoice) => fireAndForget(() => chooseUsage(provider, choice)),
        []
    );
    return (
        <>
            {grid.rows.length === 0 ? (
                <span className="mt-brokk-usage-empty" data-testid="brokk-usage-empty">
                    {t("boss.panel.usage.empty")}
                </span>
            ) : (
                <UsageWeekGrid rows={weekRows} now={now} />
            )}
            <UsageHidden items={grid.hidden} now={now} onChoose={choose} />
        </>
    );
}
