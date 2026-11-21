// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The changed files' filter and the companion's remembered choices (#555). Pure, so they are tested without a window.

import { CompanionLayout, readStoredLayout } from "./companion-layout";
import { CompanionFile, displayPath } from "./companion-model";

// The client's meta key holding the companion's choices, the same for every companion of the user.
export const CompanionPrefsMetaKey = "molten:companion:prefs";

export type CompanionPrefs = {
    // The changed files list is expanded (collapsed by default).
    filesopen?: boolean;
    // The plan usage shows its details (compact by default).
    usagedetails?: boolean;
    // The offer to explain each ticket in one sentence was answered, yes or no (#2392): it is never shown again.
    summariesasked?: boolean;
    // The developer's own arrangement of the sections (#2395); absent means the default layout.
    layout?: CompanionLayout;
    // The Taken by others group of the Tasks block is open or folded, as the developer left it (#2418); absent while he
    // never chose, when the block's width decides.
    takenopen?: boolean;
    // The "In progress, nobody on it" group is open, as the developer left it (#2454); absent while he never chose: folded.
    idleopen?: boolean;
    // The milestone tab the developer chose in the Tasks block, per project folder (#2416): the number of the milestone,
    // kept while it is open. The oldest ones leave beyond MaxChosenTabs.
    milestonetabs?: Record<string, number>;
};

export const MaxChosenTabs = 32;

function readMilestoneTabs(value: unknown): Record<string, number> {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(
        ([dir, n]) => dir !== "" && typeof n === "number" && Number.isInteger(n) && n > 0
    ) as [string, number][];
    return entries.length > 0 ? Object.fromEntries(entries.slice(-MaxChosenTabs)) : undefined;
}

// The choices with this one added as the most recent, the oldest left out beyond MaxChosenTabs.
export function withChosenTab(tabs: Record<string, number>, dir: string, milestone: number): Record<string, number> {
    const kept = Object.entries(tabs ?? {}).filter(([d]) => d !== dir);
    return Object.fromEntries([...kept, [dir, milestone]].slice(-MaxChosenTabs));
}

export function readCompanionPrefs(value: unknown): CompanionPrefs {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const prefs = value as Record<string, unknown>;
    return {
        filesopen: prefs.filesopen === true,
        usagedetails: prefs.usagedetails === true,
        summariesasked: prefs.summariesasked === true,
        layout: readStoredLayout(prefs.layout) ?? undefined,
        takenopen: typeof prefs.takenopen === "boolean" ? prefs.takenopen : undefined,
        idleopen: prefs.idleopen === true ? true : undefined,
        milestonetabs: readMilestoneTabs(prefs.milestonetabs),
    };
}

// How well a path matches what was typed: -1 when the letters do not all appear in order. A match in the file's
// name ranks before one in its folders, a contiguous one before letters spread out.
export function fuzzyScore(path: string, query: string): number {
    const q = query.trim().toLowerCase();
    if (!q) {
        return 0;
    }
    const p = path.toLowerCase();
    const name = p.slice(p.lastIndexOf("/") + 1);
    if (name.includes(q)) {
        return 3000 - name.length;
    }
    if (p.includes(q)) {
        return 2000 - p.length;
    }
    let from = 0;
    let gaps = 0;
    for (const ch of q) {
        if (ch === " ") {
            continue;
        }
        const at = p.indexOf(ch, from);
        if (at < 0) {
            return -1;
        }
        gaps += at - from;
        from = at + 1;
    }
    return Math.max(1, 1000 - gaps);
}

// A changed file as the dashboard lists it (#2441): its path relative to the project, split into folder and name; a
// file outside the project shows from ~ when it is under the home folder, else in full.
export type ShownFile = { file: CompanionFile; dir: string; name: string; outside: boolean };

function homePath(path: string, home: string): string {
    const h = (home ?? "").replace(/\/+$/, "");
    if (!h) {
        return path;
    }
    if (path === h) {
        return "~";
    }
    return path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

export function shownFile(file: CompanionFile, folder: string, home: string): ShownFile {
    const relative = displayPath(file.path, folder);
    const outside = !!folder && relative === file.path && file.path.startsWith("/");
    const shown = outside ? homePath(file.path, home) : relative;
    const cut = shown.lastIndexOf("/");
    return {
        file,
        dir: cut >= 0 ? shown.slice(0, cut + 1) : "",
        name: cut >= 0 ? shown.slice(cut + 1) : shown,
        outside,
    };
}

// The project's files first, in their order, then the files outside it, grouped last.
export function fileGroups(
    files: CompanionFile[],
    folder: string,
    home: string
): { inside: ShownFile[]; outside: ShownFile[] } {
    const shown = (files ?? []).map((f) => shownFile(f, folder, home));
    return { inside: shown.filter((f) => !f.outside), outside: shown.filter((f) => f.outside) };
}

// The files that match, best first; without a query, all of them in their order (newest change first).
export function filterFiles(files: CompanionFile[], query: string, folder: string): CompanionFile[] {
    const list = files ?? [];
    if (!query.trim()) {
        return list;
    }
    return list
        .map((file, index) => ({ file, index, score: fuzzyScore(displayPath(file.path, folder), query) }))
        .filter((m) => m.score >= 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((m) => m.file);
}
