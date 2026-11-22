// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the arranging mode does to a layout (FR-SHELL-018, #2395, #2441, #2450, #2459, #2467): move a section, drop a
// carried one (in the list, or on the main agent's block), show or hide it, set it full width or fluid, give the usage its
// minimal form or attach it to the main agent, go back to the defaults. Each edit takes a layout and gives a new, usable
// one (companion-layout.ts keeps the registry and what a stored layout may hold); none of them runs on its own. It also
// says what the flow lays out in both modes, since arranging keeps the dashboard's own layout (#2467). Loaded with the
// arranging mode, out of the startup bundle. Pure, so it is tested without a window.

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

// The sections that draw nothing in the dashboard until they have something to show: the permission request, the
// milestone of a project without an open one, the plan usage the agent gives no reading of, the workspace task. While
// arranging each is a compact ghost at its rank that says when it shows (#2467).
export const ConditionalWhenKeys: Partial<Record<CompanionSectionId, string>> = {
    permission: "companion.arrange.when.permission",
    tasks: "companion.arrange.when.tasks",
    usage: "companion.arrange.when.usage",
    task: "companion.arrange.when.task",
};

// A block of the flow, in the order the flow lays them out (#2467). The blocks that show, at their rank, are the same
// in both modes, which is what keeps the arranging mode from moving any of them; the hidden blocks only come while
// arranging, as ghosts after the others (`tail`): they hold no place of their own, so the flow's columns never depend on
// them. A usage attached to the main agent is in the main agent's block, not in the flow.
export type FlowEntry = { id: CompanionSectionId; full: boolean; tail?: boolean };

export function flowEntries(layout: CompanionLayout, arranging: boolean): FlowEntry[] {
    const list = normalizeLayout(layout);
    const shown: FlowEntry[] = list
        .filter((p) => !p.hidden && !(p.id === "usage" && p.attached === true))
        .map((p) => ({ id: p.id, full: p.span === "full" }));
    if (!arranging) {
        return shown;
    }
    const hidden: FlowEntry[] = list
        .filter((p) => p.hidden === true)
        .map((p) => ({ id: p.id, full: false, tail: true }));
    return [...shown, ...hidden];
}

// The sections that hold a rank in the flow, in rank order: what a drag, the keyboard and the screen reader count.
export function rankedIds(layout: CompanionLayout): CompanionSectionId[] {
    return flowEntries(layout, false).map((e) => e.id);
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

// The section takes the rank `rank` among the sections that hold one (the drag's and the keyboard's own count, which a
// hidden block or an attached usage is not part of, #2467): it goes before the section that holds that rank now, or after
// the last one. The hidden blocks keep their place in the list, for the day they are shown again.
export function moveRanked(layout: CompanionLayout, id: CompanionSectionId, rank: number): CompanionLayout {
    const list = normalizeLayout(layout);
    const ranked = rankedIds(list);
    const others = ranked.filter((other) => other !== id);
    if (!ranked.includes(id) || others.length === 0 || !Number.isInteger(rank)) {
        return list;
    }
    const without = list.filter((p) => p.id !== id);
    const target = Math.min(Math.max(rank, 0), others.length);
    if (ranked.indexOf(id) === target) {
        return list;
    }
    const at =
        target < others.length
            ? without.findIndex((p) => p.id === others[target])
            : without.findIndex((p) => p.id === others[others.length - 1]) + 1;
    return normalizeLayout([...without.slice(0, at), list.find((p) => p.id === id), ...without.slice(at)]);
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

// Where a dragged section is dropped (#2459): in the list, at an index, or on the main agent's block, which only the usage
// block can be attached to.
export type SectionDrop = { to: "list"; index: number } | { to: "attach" };

// What a drop does to the layout. In the list the section takes the rank it is dropped at, and an attached usage block
// that leaves the main agent's block is detached by it; on the main agent's block the usage block is attached and keeps
// its rank for the day it is detached (#2450), and any other section is left where it was.
export function dropSection(layout: CompanionLayout, id: CompanionSectionId, drop: SectionDrop): CompanionLayout {
    const list = normalizeLayout(layout);
    if (drop.to === "attach") {
        return id === "usage" ? setUsageAttached(list, true) : list;
    }
    const moved = moveSection(
        list,
        list.findIndex((p) => p.id === id),
        drop.index
    );
    return id === "usage" && list.find((p) => p.id === "usage")?.attached === true
        ? setUsageAttached(moved, false)
        : moved;
}

// Where a section stands among the sections that hold a rank, for the screen reader's "2 of 8"; a hidden section stands
// where the list keeps it.
export function positionOf(layout: CompanionLayout, id: CompanionSectionId): { position: number; total: number } {
    const ranked = rankedIds(layout);
    if (ranked.includes(id)) {
        return { position: ranked.indexOf(id) + 1, total: ranked.length };
    }
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
