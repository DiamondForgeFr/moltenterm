// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The changed files' filter and the companion's remembered choices (#555). Pure, so they are tested without a window.

import { CompanionFile, displayPath } from "./companion-model";

// The client's meta key holding the companion's choices, the same for every companion of the user.
export const CompanionPrefsMetaKey = "molten:companion:prefs";

export type CompanionPrefs = {
    // The changed files list is expanded (collapsed by default).
    filesopen?: boolean;
    // The plan usage shows its details (compact by default).
    usagedetails?: boolean;
};

export function readCompanionPrefs(value: unknown): CompanionPrefs {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const prefs = value as Record<string, unknown>;
    return {
        filesopen: prefs.filesopen === true,
        usagedetails: prefs.usagedetails === true,
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
