// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage's rows the developer chose to show (FR-SHELL-018, #2462). A provider reports several windows (Session,
// Week, Week (from the month), Month, Week (Fable)) and the developer may care for one: the choice is kept per provider
// and per window key with the companion layout (companion-layout.ts, `hiddenrows`), and applies to every form of the
// usage (full, minimal, attached). A window that is not hidden shows, so one the provider starts to report later shows
// until the developer hides it, and at least one row always stays. The choice only filters what is drawn: the rows are
// built from every window first (gaugesView), so a week deduced from the month is still computed with the month row
// hidden. The session is one of those windows: it draws a ring on today's letter rather than a row (#2473), so hiding it
// hides the ring, and it counts for the row that always stays. Pure, so it is tested without a window.

import { t } from "../i18n/i18n";
import { SessionWindowId } from "../usage-week/usage-week-model";
import type { GaugeRow, GaugesView, UsageWindowChoice } from "./companion-gauges-model";
import { CompanionLayout, normalizeLayout } from "./companion-layout";

// What the usage's frames are given to draw the choice and to change it: the window keys hidden for the provider, the
// way to set one (absent where nothing is offered: the arranging mode's own copy of the usage, the other panels), and the
// way to hear which windows the provider reports (the arranging mode's settings list them).
export type UsageRowsProps = {
    hidden: readonly string[];
    onSet?: (id: string, hide: boolean, reported: readonly string[]) => void;
    onListed?: (windows: UsageWindowChoice[]) => void;
};

// The window keys hidden for a provider; none for a layout that never said.
export function hiddenRowsOf(layout: CompanionLayout, provider: string): readonly string[] {
    const usage = normalizeLayout(layout).find((p) => p.id === "usage");
    return usage?.hiddenrows?.[provider] ?? [];
}

// Every window with whether its row shows. A saved choice that would hide every one of them (the provider renamed its
// keys, or the only window left is one the developer once hid) shows them all: a usage block without a row says nothing.
export function windowChoices(
    windows: readonly { id: string; label: string }[],
    hidden: readonly string[]
): UsageWindowChoice[] {
    const off = new Set(hidden);
    const everyOff = windows.every((w) => off.has(w.id));
    return windows.map((w) => ({ id: w.id, label: w.label, shown: everyOff || !off.has(w.id) }));
}

export function hiddenCount(choices: readonly UsageWindowChoice[]): number {
    return choices.filter((c) => !c.shown).length;
}

// The switch of this window cannot turn off: it is the only row that shows.
export function onlyShown(choices: readonly UsageWindowChoice[], id: string): boolean {
    const shown = choices.filter((c) => c.shown);
    return shown.length === 1 && shown[0].id === id;
}

// A window's name in the choice: the row's label, and for the session, which draws no row but a ring on today's letter
// (#2473), the words that say so.
function choiceLabel(row: GaugeRow): string {
    return row.id === SessionWindowId ? t("companion.gauges.rows.sessionRing") : row.shortLabel;
}

// The usage as it draws: the rows the developer chose, and the windows there were. Applied to the view gaugesView gives,
// whose rows are all of them.
export function withRowChoice(view: GaugesView, hidden: readonly string[]): GaugesView {
    if (view.kind !== "enabled") {
        return view;
    }
    const listed = windowChoices(
        view.rows.map((row) => ({ id: row.id, label: choiceLabel(row) })),
        hidden
    );
    const shown = new Set(listed.filter((c) => c.shown).map((c) => c.id));
    return { ...view, listed, rows: view.rows.filter((row) => shown.has(row.id)) };
}

// The layout with a window's row hidden or shown for a provider. `reported` is the keys of the windows the provider reports
// now: the last row that shows is never hidden (the layout comes back as it was), and the keys of windows not reported now
// stay as they are, so that a window that comes back is still hidden.
export function setUsageRowHidden(
    layout: CompanionLayout,
    provider: string,
    id: string,
    hide: boolean,
    reported: readonly string[]
): CompanionLayout {
    const list = normalizeLayout(layout);
    const usage = list.find((p) => p.id === "usage");
    if (usage == null || !provider || !id) {
        return list;
    }
    const current = usage.hiddenrows?.[provider] ?? [];
    const choices = windowChoices(
        reported.map((key) => ({ id: key, label: key })),
        current
    );
    if (hide && onlyShown(choices, id)) {
        return list;
    }
    const now = new Set(reported);
    const unreported = current.filter((key) => !now.has(key));
    const off = choices.filter((c) => !c.shown).map((c) => c.id);
    const next = hide ? [...off, id] : off.filter((key) => key !== id);
    const hiddenrows = { ...(usage.hiddenrows ?? {}), [provider]: [...new Set([...unreported, ...next])] };
    return normalizeLayout(list.map((p) => (p.id === "usage" ? { ...p, hiddenrows } : p)));
}

// What the usage's frames take: the rows hidden for the provider and the way to change them, saving the layout.
export function usageRowsProps(
    layout: CompanionLayout,
    provider: string,
    save: (layout: CompanionLayout) => void
): UsageRowsProps {
    return {
        hidden: hiddenRowsOf(layout, provider),
        onSet: (id, hide, reported) => save(setUsageRowHidden(layout, provider, id, hide, reported)),
    };
}
