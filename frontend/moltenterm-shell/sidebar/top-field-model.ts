// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar's top field (FR-SHELL-083, #1187): what it shows for the focused panel, what typing finds, and what
// Enter, ⌥Enter and ⌘Enter do with an address. Pure rules, tested without the app; top-field.tsx gathers the sources
// and runs the chosen row.

import { toBrowserUrl } from "../browser/browser-model";
import { t } from "../i18n/i18n";
import type { PaletteRun } from "../palette/palette-model";
import { fold } from "./top-field-context";

export { fieldContext, fold, type FieldContext, type FocusFacts } from "./top-field-context";

// Where an address opens: the focused page panel, a panel beside the focused one, a new temporary view.
export type AddressMode = "here" | "beside" | "newview";

export type FieldRun =
    | { kind: "address"; url: string; mode: AddressMode }
    | { kind: "view"; tabId: string; workspaceId: string }
    | { kind: "agent"; blockId: string }
    | { kind: "workspace"; workspaceId: string }
    | { kind: "pr"; dir: string; number: number }
    | { kind: "palette"; run: PaletteRun }
    | { kind: "togglesidebar" }
    | { kind: "clearterm"; blockId: string };

export type FieldGroup = "address" | "view" | "agent" | "workspace" | "pr" | "panel" | "action";

// A workspace's letter as its dot draws it.
export type FieldLetter = { text: string; paint: string; ink: string };

export type FieldRow = {
    id: string;
    group: FieldGroup;
    // Bold words before the label ("Go to", "Add").
    strong?: string;
    label: string;
    // Quieter text after the label (an agent's state, a workspace's projects).
    note?: string;
    // Where the row leads, on the right ("agent · Notulia", "temporary").
    where?: string;
    // The key shown at the end (↵, ⌥↵, ⌘↵).
    key?: string;
    icon?: string;
    color?: string;
    letter?: FieldLetter;
    // A workspace row: its name, for the prefix rank.
    workspaceName?: string;
    // A view of the workspace on screen; the current one is listed when searched but not offered while empty.
    here?: boolean;
    current?: boolean;
    keywords?: string[];
    run: FieldRun;
};

// Text that is an address rather than words to search: a scheme, localhost, an IP, or a host with a dot and no space.
export function looksLikeAddress(text: string): boolean {
    const s = (text ?? "").trim();
    if (s === "" || /\s/.test(s)) {
        return false;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|file|data):/i.test(s)) {
        return true;
    }
    if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) {
        return true;
    }
    return /^[^/\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s);
}

export function addressUrl(text: string): string {
    const s = (text ?? "").trim();
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) {
        return "http://" + s;
    }
    return toBrowserUrl(s);
}

export function hostOfUrl(url: string): string {
    try {
        return new URL(url).host.replace(/^www\./, "") || url;
    } catch {
        return url;
    }
}

export type FieldFocus = {
    // A page panel has the focus: Enter goes there.
    onPage: boolean;
    // The focused page's host, and the view's name, for the address rows.
    pageHost?: string;
    viewName?: string;
};

// The address rows, in the order Enter, ⌥Enter, ⌘Enter take them.
export function addressRows(text: string, focus: FieldFocus): FieldRow[] {
    const url = addressUrl(text);
    if (url == null) {
        return [];
    }
    const host = hostOfUrl(url);
    if (focus.onPage) {
        return [
            {
                id: "address:here",
                group: "address",
                strong: t("topField.address.goTo"),
                label: url,
                where: t("topField.address.inPanel", { host: focus.pageHost || "" }),
                key: "↵",
                icon: "globe",
                run: { kind: "address", url, mode: "here" },
            },
            {
                id: "address:beside",
                group: "address",
                strong: t("topField.address.beside"),
                label: host,
                where: t("topField.address.inThisView"),
                key: "⌥↵",
                icon: "table-columns",
                run: { kind: "address", url, mode: "beside" },
            },
            {
                id: "address:newview",
                group: "address",
                strong: t("topField.address.newView"),
                label: host,
                where: t("topField.address.temporary"),
                key: "⌘↵",
                icon: "square-plus",
                run: { kind: "address", url, mode: "newview" },
            },
        ];
    }
    return [
        {
            id: "address:newview",
            group: "address",
            strong: t("topField.address.newView"),
            label: url,
            where: t("topField.address.temporary"),
            key: "↵",
            icon: "square-plus",
            run: { kind: "address", url, mode: "newview" },
        },
        {
            id: "address:beside",
            group: "address",
            strong: t("topField.address.addToView"),
            label: host,
            where: focus.viewName || t("topField.address.inThisView"),
            key: "⌥↵",
            icon: "plus",
            run: { kind: "address", url, mode: "beside" },
        },
    ];
}

// The hint line under the results: what Enter, ⌥Enter and ⌘Enter do with an address in the current focus.
export function fieldHint(onPage: boolean): { keys: string; text: string }[] {
    if (onPage) {
        return [
            { keys: "↵", text: t("topField.hint.thisPanel") },
            { keys: "⌥↵", text: t("topField.hint.beside") },
            { keys: "⌘↵", text: t("topField.hint.newView") },
        ];
    }
    return [
        { keys: "↵", text: t("topField.hint.newView") },
        { keys: "⌥↵", text: t("topField.hint.inThisView") },
    ];
}

export type FieldKeys = { alt?: boolean; meta?: boolean };

// What Enter runs on a row: on an address row the modifiers choose (⌘ a new view, ⌥ beside), plain Enter the row's own
// way; any other row runs as it is.
export function enterRun(row: FieldRow, keys: FieldKeys): FieldRun {
    if (row == null) {
        return null;
    }
    if (row.run.kind !== "address") {
        return row.run;
    }
    if (keys?.meta) {
        return { ...row.run, mode: "newview" };
    }
    if (keys?.alt) {
        return { ...row.run, mode: "beside" };
    }
    return row.run;
}

function haystack(row: FieldRow): string {
    return fold([row.strong, row.label, row.note, row.where, ...(row.keywords ?? [])].filter((s) => s).join(" "));
}

// Every word typed must appear in the row's texts. 3: the label starts with the text, 2: a word of the label does,
// 1: the label holds it, 0: only the row's other texts do; null: no match.
export function matchScore(query: string, row: FieldRow): number {
    const q = fold(query).trim();
    if (q === "") {
        return 0;
    }
    const words = q.split(/\s+/);
    const all = haystack(row);
    if (!words.every((w) => all.includes(w))) {
        return null;
    }
    const label = fold([row.strong, row.label].filter((s) => s).join(" "));
    const plain = fold(row.label);
    if (plain.startsWith(q) || label.startsWith(q)) {
        return 3;
    }
    if (label.split(/[\s\-_./:#·]+/).some((part) => part.startsWith(words[0]))) {
        return 2;
    }
    return label.includes(q) ? 1 : 0;
}

// A workspace whose name starts with the text comes first ("Notu" then Enter goes to Notulia), then the other
// workspaces, then the rest.
function rankOf(query: string, row: FieldRow): number {
    if (row.group !== "workspace") {
        return 2;
    }
    return fold(row.workspaceName ?? row.label).startsWith(fold(query).trim()) ? 0 : 1;
}

export const MaxFieldRows = 8;
const EmptyViews = 5;
const EmptyAgents = 4;
const EmptyWorkspaces = 5;

export type FieldSection = { title: string; rows: FieldRow[] };

export type FieldResults = { sections: FieldSection[]; flat: FieldRow[] };

function results(sections: FieldSection[]): FieldResults {
    const kept = sections.filter((s) => s.rows.length > 0);
    return { sections: kept, flat: kept.flatMap((s) => s.rows) };
}

// The rows for what is typed. Empty: the workspace's other views, the agents, the other workspaces. Typed: an address
// first (its Enter, ⌥Enter and ⌘Enter rows), then the best matches; words nothing matches search the web.
export function fieldResults(query: string, rows: FieldRow[], focus: FieldFocus, workspaceName: string): FieldResults {
    const q = (query ?? "").trim();
    const list = rows ?? [];
    if (q === "") {
        return results([
            {
                title: t("topField.groups.views", { name: workspaceName }),
                rows: list.filter((r) => r.group === "view" && r.here && !r.current).slice(0, EmptyViews),
            },
            { title: t("topField.groups.agents"), rows: list.filter((r) => r.group === "agent").slice(0, EmptyAgents) },
            {
                title: t("topField.groups.workspaces"),
                rows: list.filter((r) => r.group === "workspace").slice(0, EmptyWorkspaces),
            },
        ]);
    }
    const address = looksLikeAddress(q) ? addressRows(q, focus) : [];
    const matched = list
        .map((row, order) => ({ row, order, score: matchScore(q, row) }))
        .filter((m) => m.score != null)
        .sort((a, b) => rankOf(q, a.row) - rankOf(q, b.row) || b.score - a.score || a.order - b.order)
        .slice(0, MaxFieldRows)
        .map((m) => m.row);
    const found = [...address, ...matched];
    if (found.length === 0) {
        const url = toBrowserUrl(q);
        found.push({
            id: "search:web",
            group: "address",
            strong: t("topField.searchWeb"),
            label: t("topField.searchQuery", { query: q }),
            where: t("topField.address.temporary"),
            key: "↵",
            icon: "magnifying-glass",
            run: { kind: "address", url, mode: "newview" },
        });
    }
    return results([{ title: "", rows: found }]);
}
