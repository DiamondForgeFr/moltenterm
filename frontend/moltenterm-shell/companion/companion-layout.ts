// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's sections and where they go (FR-SHELL-018, #2392): one registry of stable ids, one layout that says
// in what order the sections come and in which column each one stands, and the defaults, here and nowhere else. A
// layout is a list: "full" sections span the companion; consecutive "left" and "right" sections form a band of two
// columns when the companion is wide enough (TwoColumnMinWidth), and stack in the list's order when it is narrow.
// Pure, so it is tested without a window.

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

export type CompanionColumn = "full" | "left" | "right";

export type SectionPlacement = { id: CompanionSectionId; column: CompanionColumn; hidden?: boolean };

export type CompanionLayout = readonly SectionPlacement[];

// The defaults (#555, PR #557, then #2392): the plan usage; the Tasks block on the left, the agents at work on the
// right; the permission request, the topics, the answer and the workspace task; the changed files last.
export const DefaultCompanionLayout: CompanionLayout = [
    { id: "usage", column: "full" },
    { id: "tasks", column: "left" },
    { id: "agents", column: "right" },
    { id: "permission", column: "full" },
    { id: "topics", column: "full" },
    { id: "answer", column: "full" },
    { id: "task", column: "full" },
    { id: "files", column: "full" },
];

// From this width a band's two columns stand side by side: two columns of about 250 px, the lane the link lines cross
// between them and the companion's padding. Narrower, they stack.
export const TwoColumnMinWidth = 560;

export type WorkLayout = "columns" | "stacked";

export function workLayout(width: number): WorkLayout {
    return width >= TwoColumnMinWidth ? "columns" : "stacked";
}

const Columns = new Set<CompanionColumn>(["full", "left", "right"]);

// A layout as it can be used: every registered section once, in the given order; an unknown id or column is dropped,
// a section the layout forgets takes its default place at the end.
export function normalizeLayout(layout: readonly SectionPlacement[]): CompanionLayout {
    const known = new Set<string>(CompanionSectionIds);
    const seen = new Set<string>();
    const rtn: SectionPlacement[] = [];
    for (const p of layout ?? []) {
        if (p == null || !known.has(p.id) || seen.has(p.id) || !Columns.has(p.column)) {
            continue;
        }
        seen.add(p.id);
        rtn.push({ id: p.id, column: p.column, ...(p.hidden ? { hidden: true } : {}) });
    }
    for (const p of DefaultCompanionLayout) {
        if (!seen.has(p.id)) {
            rtn.push(p);
        }
    }
    return rtn;
}

export type FullBand = { kind: "full"; id: CompanionSectionId };

// Two columns: ids is the list's order (the stacked one), left and right each column's.
export type ColumnsBand = {
    kind: "columns";
    ids: CompanionSectionId[];
    left: CompanionSectionId[];
    right: CompanionSectionId[];
};

export type SectionBand = FullBand | ColumnsBand;

// The bands a layout gives, the hidden sections and those with nothing to show (present says) left out.
export function sectionBands(layout: CompanionLayout, present: (id: CompanionSectionId) => boolean): SectionBand[] {
    const bands: SectionBand[] = [];
    let columns: ColumnsBand = null;
    for (const p of normalizeLayout(layout)) {
        if (p.hidden || !present(p.id)) {
            continue;
        }
        if (p.column === "full") {
            columns = null;
            bands.push({ kind: "full", id: p.id });
            continue;
        }
        if (columns == null) {
            columns = { kind: "columns", ids: [], left: [], right: [] };
            bands.push(columns);
        }
        columns.ids.push(p.id);
        columns[p.column].push(p.id);
    }
    return bands;
}

// The band that holds the Tasks block and the agents at work, as the defaults place them.
export function defaultWorkBand(): ColumnsBand {
    const band = sectionBands(DefaultCompanionLayout, (id) => id === "tasks" || id === "agents")[0];
    return band as ColumnsBand;
}
