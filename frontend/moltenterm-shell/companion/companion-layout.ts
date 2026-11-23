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

// The usage windows the developer hid (#2462): per provider (the agent whose plan it is, "claude", "kimi"), the keys of
// the windows ("session", "week", "model:fable"), never their labels, so that a translated label keeps the choice. A
// window that is not listed is shown, which is also what a window the provider starts to report later does.
export type HiddenUsageRows = Record<string, string[]>;

// minimal, attached and hiddenrows belong to the usage block alone (#2450, #2462): its window rows only, its place in the
// main agent's block in place of the flow, and the rows it leaves out. A section that has none keeps none; each is
// stored only when set, so the default (the full block, standing on its own, every row) is the absence of all three.
// unfolded belongs to every block (#2477): a block taller than the cap shows its end only once it is unfolded; stored
// only when set, so a layout saved before it, like the default, has every block capped.
export type SectionPlacement = {
    id: CompanionSectionId;
    span: CompanionSpan;
    hidden?: boolean;
    minimal?: boolean;
    attached?: boolean;
    hiddenrows?: HiddenUsageRows;
    unfolded?: boolean;
};

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
type StoredPlacement = {
    id?: unknown;
    span?: unknown;
    column?: unknown;
    hidden?: unknown;
    minimal?: unknown;
    attached?: unknown;
    hiddenrows?: unknown;
    unfolded?: unknown;
};

const MaxHiddenProviders = 16;
const MaxHiddenPerProvider = 32;
const MaxHiddenKeyLength = 64;

function hiddenKey(value: unknown): value is string {
    return typeof value === "string" && value !== "" && value.length <= MaxHiddenKeyLength;
}

// The rows a stored placement hides, in one canonical form (providers and keys in order, every key once, nothing empty), so
// that two layouts that hide the same rows are the same layout; undefined when it hides none. What is not a provider's
// list of keys is dropped, and so is what exceeds a sane count: a stored layout is data the app did not write itself.
export function readHiddenRows(value: unknown): HiddenUsageRows {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const rtn: HiddenUsageRows = {};
    for (const provider of Object.keys(value).sort()) {
        if (!hiddenKey(provider) || Object.keys(rtn).length >= MaxHiddenProviders) {
            continue;
        }
        const keys = (value as Record<string, unknown>)[provider];
        if (!Array.isArray(keys)) {
            continue;
        }
        const own = [...new Set(keys.filter(hiddenKey))].sort().slice(0, MaxHiddenPerProvider);
        if (own.length > 0) {
            rtn[provider] = own;
        }
    }
    return Object.keys(rtn).length > 0 ? rtn : undefined;
}

// A layout as it can be used: every registered section once, in the given order; an unknown id is dropped, an unknown
// span takes the default, a section the layout forgets takes its default place at the end. A layout stored before #2450
// has neither usage flag: its usage block reads as full and standing on its own. One stored before #2462 hides no row,
// and one stored before #2477 has every block capped.
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
        const usage = id === "usage";
        const hiddenrows = usage ? readHiddenRows(p.hiddenrows) : undefined;
        rtn.push({
            id,
            span,
            ...(p.hidden === true ? { hidden: true } : {}),
            ...(usage && p.minimal === true ? { minimal: true } : {}),
            ...(usage && p.attached === true ? { attached: true } : {}),
            ...(hiddenrows != null ? { hiddenrows } : {}),
            ...(p.unfolded === true ? { unfolded: true } : {}),
        });
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
        x.every(
            (p, i) =>
                p.id === y[i].id &&
                p.span === y[i].span &&
                !p.hidden === !y[i].hidden &&
                !p.minimal === !y[i].minimal &&
                !p.attached === !y[i].attached &&
                !p.unfolded === !y[i].unfolded &&
                JSON.stringify(p.hiddenrows ?? null) === JSON.stringify(y[i].hiddenrows ?? null)
        )
    );
}

// What a layout says of the usage block (#2450). It stands in the main agent's block only while it is attached and not
// hidden: a hidden usage shows nowhere, attached or not.
export function usageOf(layout: CompanionLayout): { shown: boolean; minimal: boolean; attached: boolean } {
    const p = normalizeLayout(layout).find((placement) => placement.id === "usage");
    const shown = p != null && !p.hidden;
    return { shown, minimal: p?.minimal === true, attached: shown && p?.attached === true };
}

// Whether the developer unfolded a block that is taller than the cap (#2477): capped until they did.
export function isUnfolded(layout: CompanionLayout, id: CompanionSectionId): boolean {
    return normalizeLayout(layout).find((p) => p.id === id)?.unfolded === true;
}

export function isDefaultLayout(layout: CompanionLayout): boolean {
    return sameLayout(layout, DefaultCompanionLayout);
}
