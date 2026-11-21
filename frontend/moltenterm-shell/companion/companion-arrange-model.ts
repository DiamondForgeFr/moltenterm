// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the arranging mode does to a layout (FR-SHELL-018, #2395, #2441, #2450): move a section, show or hide it, set it full
// width or fluid, give the usage its minimal form or attach it to the main agent, go back to the defaults. Each edit takes a layout and gives a new, usable one (companion-layout.ts keeps the
// registry and what a stored layout may hold); none of them runs on its own. Loaded with the arranging mode, out of the
// startup bundle. Pure, so it is tested without a window.

import {
    CompanionLayout,
    CompanionSectionId,
    CompanionSpan,
    DefaultCompanionLayout,
    normalizeLayout,
    sameLayout,
    SectionPlacement,
} from "./companion-layout";

// The name of each section as the arranging mode lists it: the key of the title the section carries in the companion.
export const SectionNameKeys: Record<CompanionSectionId, string> = {
    usage: "companion.gauges.title",
    tasks: "companion.tasks",
    agents: "companion.agents.title",
    permission: "companion.permissionRequest",
    topics: "companion.topics.title",
    answer: "companion.answer.title",
    task: "companion.task.title",
    files: "companion.files.title",
};

export function resetLayout(): CompanionLayout {
    return DefaultCompanionLayout;
}

// The usage's summary line while arranging says its form (#2450), since its two choices change what it draws and
// where; attached says it all, whatever its size.
export function usageSummaryKey(placement: Pick<SectionPlacement, "minimal" | "attached">): string {
    if (placement.attached === true) {
        return "companion.dash.sum.usageAttached";
    }
    return placement.minimal === true ? "companion.dash.sum.usageMinimal" : "companion.dash.sum.usage";
}

// What leaving the mode saves: the drafted layout, once, when it differs from the one the mode opened with (or the last
// one saved). Leaving without a change, or twice in a row, writes nothing.
export function makeLayoutCommit(
    opened: CompanionLayout,
    save: (layout: CompanionLayout) => void
): (draft: CompanionLayout) => boolean {
    let saved = opened;
    return (draft) => {
        if (sameLayout(draft, saved)) {
            return false;
        }
        saved = draft;
        save(draft);
        return true;
    };
}

// The section at index `from` goes to index `to` (the drag's drop and the keyboard's step); out of range is the list's end.
export function moveSection(layout: CompanionLayout, from: number, to: number): CompanionLayout {
    const list = [...normalizeLayout(layout)];
    if (!Number.isInteger(from) || from < 0 || from >= list.length) {
        return list;
    }
    const target = Math.min(Math.max(Number.isInteger(to) ? to : from, 0), list.length - 1);
    const [moved] = list.splice(from, 1);
    list.splice(target, 0, moved);
    return list;
}

export function moveSectionBy(layout: CompanionLayout, id: CompanionSectionId, step: -1 | 1): CompanionLayout {
    const list = normalizeLayout(layout);
    const from = list.findIndex((p) => p.id === id);
    return moveSection(list, from, from + step);
}

function editSection(
    layout: CompanionLayout,
    id: CompanionSectionId,
    edit: (p: SectionPlacement) => SectionPlacement
): CompanionLayout {
    return normalizeLayout(normalizeLayout(layout).map((p) => (p.id === id ? edit(p) : p)));
}

// Full width spans every column of the flow; fluid takes one column (#2441).
export function setSectionSpan(layout: CompanionLayout, id: CompanionSectionId, span: CompanionSpan): CompanionLayout {
    return editSection(layout, id, (p) => ({ ...p, span }));
}

export function setSectionHidden(layout: CompanionLayout, id: CompanionSectionId, hidden: boolean): CompanionLayout {
    return editSection(layout, id, (p) => ({ ...p, hidden }));
}

// The usage block's two choices (#2450). Its rank, span and hidden state stay where they are whichever it takes: an
// attached block keeps its place in the list, so detaching returns it there, in the size it was left.
export function setUsageMinimal(layout: CompanionLayout, minimal: boolean): CompanionLayout {
    return editSection(layout, "usage", (p) => ({ ...p, minimal }));
}

export function setUsageAttached(layout: CompanionLayout, attached: boolean): CompanionLayout {
    return editSection(layout, "usage", (p) => ({ ...p, attached }));
}

// Where a section stands in the list, for the screen reader's "2 of 8".
export function positionOf(layout: CompanionLayout, id: CompanionSectionId): { position: number; total: number } {
    const list = normalizeLayout(layout);
    return { position: list.findIndex((p) => p.id === id) + 1, total: list.length };
}

// A handle takes the up and down arrows, with or without Alt (the drag's keyboard twin everywhere else in the shell),
// and Home and End for the ends of the list. The index the section moves to; null when the key is none of them.
export function handleTarget(key: string, index: number, total: number): number {
    switch (key) {
        case "ArrowUp":
            return Math.max(index - 1, 0);
        case "ArrowDown":
            return Math.min(index + 1, total - 1);
        case "Home":
            return 0;
        case "End":
            return total - 1;
        default:
            return null;
    }
}
