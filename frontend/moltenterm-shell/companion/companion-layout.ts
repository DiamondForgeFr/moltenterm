// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's sections and how they are arranged (FR-SHELL-018, #2392, #2395, #2441): one registry of stable ids,
// one layout that says in what order the sections come, which are shown and whether each one flows in a column or
// spans the companion, and the defaults, here and nowhere else. The flow places them (companion-flow-model.ts). The
// developer's own layout (#2395) is the same list, kept in the client's settings; the arranging mode edits it
// (companion-arrange-model.ts). Pure, so it is tested without a window.

// The registry: an id never changes once shipped, since a developer's own layout will name it.
export const CompanionSectionIds = [
    "usage",
    "tasks",
    "agents",
    "permission",
    "topics",
    "answer",
    "task",
    "files",
] as const;

export type CompanionSectionId = (typeof CompanionSectionIds)[number];

// "flow": the block takes one column of the flow; "full": it spans every column.
export type CompanionSpan = "flow" | "full";

export type SectionPlacement = { id: CompanionSectionId; span: CompanionSpan; hidden?: boolean };

export type CompanionLayout = readonly SectionPlacement[];

// The defaults (#2441): what the developer acts on first (the permission request across the companion, right under
// the hero; the milestone and the agents at work, a pair), then the usage, and the history and reference.
export const DefaultCompanionLayout: CompanionLayout = [
    { id: "permission", span: "full" },
    { id: "tasks", span: "flow" },
    { id: "agents", span: "flow" },
    { id: "usage", span: "flow" },
    { id: "topics", span: "flow" },
    { id: "answer", span: "flow" },
    { id: "task", span: "flow" },
    { id: "files", span: "flow" },
];

// The companion's one horizontal inset in px: --mt-companion-inset (tokens.css), which companion-inset.test.ts keeps
// equal to this.
export const CompanionInsetPx = 12;

const Spans = new Set<string>(["flow", "full"]);

export function defaultSpan(id: CompanionSectionId): CompanionSpan {
    return DefaultCompanionLayout.find((p) => p.id === id)?.span ?? "flow";
}

// A stored placement: the current form, or the one #2395 stored, whose column (full, left or right) said where a
// section stood in a band. A band of two columns is now the flow itself, so an old placement takes its section's
// default span; its order and its hidden flag are kept.
type StoredPlacement = { id?: unknown; span?: unknown; column?: unknown; hidden?: unknown };

// A layout as it can be used: every registered section once, in the given order; an unknown id is dropped, an unknown
// span takes the default, a section the layout forgets takes its default place at the end.
export function normalizeLayout(layout: readonly StoredPlacement[]): CompanionLayout {
    const known = new Set<string>(CompanionSectionIds);
    const seen = new Set<string>();
    const rtn: SectionPlacement[] = [];
    for (const p of layout ?? []) {
        if (p == null || typeof p.id !== "string" || !known.has(p.id) || seen.has(p.id)) {
            continue;
        }
        const id = p.id as CompanionSectionId;
        seen.add(id);
        const span = typeof p.span === "string" && Spans.has(p.span) ? (p.span as CompanionSpan) : defaultSpan(id);
        rtn.push({ id, span, ...(p.hidden === true ? { hidden: true } : {}) });
    }
    for (const p of DefaultCompanionLayout) {
        if (!seen.has(p.id)) {
            rtn.push(p);
        }
    }
    return rtn;
}

// The layout the developer stored, as it can be used; null when none was stored (or it holds nothing), which means the
// defaults.
export function readStoredLayout(value: unknown): CompanionLayout {
    if (!Array.isArray(value) || value.length === 0) {
        return null;
    }
    return normalizeLayout(value as StoredPlacement[]);
}

export function sameLayout(a: CompanionLayout, b: CompanionLayout): boolean {
    const x = normalizeLayout(a);
    const y = normalizeLayout(b);
    return (
        x.length === y.length &&
        x.every((p, i) => p.id === y[i].id && p.span === y[i].span && !p.hidden === !y[i].hidden)
    );
}

export function isDefaultLayout(layout: CompanionLayout): boolean {
    return sameLayout(layout, DefaultCompanionLayout);
}
