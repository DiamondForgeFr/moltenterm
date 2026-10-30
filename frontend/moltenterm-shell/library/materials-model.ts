// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The library's Materials section (FR-MAT-002, DS-MAT-005): what agents produced outside the repository, kept per
// project by wavesrv's registry (FR-MAT-001, pkg/molten/materials). The route's names and types, and the rules the
// section shows its rows by.

import { matchesQuery } from "./library-model";

// must match pkg/molten/agentmaterials.go
export const MaterialsRoute = "molten:materials";
export const MaterialsEvent = "molten:materials";
export const MaterialsListCommand = "moltenmaterialslist";
export const MaterialRenameCommand = "moltenmaterialrename";
export const MaterialPinCommand = "moltenmaterialpin";
export const MaterialDeleteCopyCommand = "moltenmaterialdeletecopy";
export const MaterialRestoreCommand = "moltenmaterialrestore";
export const MaterialCopyCommand = "moltenmaterialcopy";
export const MaterialsNoProject = "noproject";

export const MaterialKindPage = "page";
export const MaterialKindLink = "link";
export const MaterialKindPdf = "pdf";
export const MaterialKindImage = "image";
export const MaterialKindVideo = "video";
export const MaterialKindText = "text";
export const MaterialKindDocument = "document";

export const MaterialSourcePublished = "published";
export const MaterialSourceNamed = "named";
export const MaterialSourceDeclared = "declared";
export const MaterialSourceBrought = "brought";

export const MaterialCopyKept = "kept";
export const MaterialCopyTooLarge = "toolarge";

// Undo of a deleted copy (AC11).
export const MaterialUndoMs = 10000;

export type MaterialVersion = { n: number; at: number; title?: string; size: number; files?: number };

export type Material = {
    id: string;
    project: string;
    title: string;
    autotitle?: string;
    renamed?: boolean;
    originalname?: string;
    kind: string;
    source: string;
    link?: string;
    original?: string;
    originalgone?: boolean;
    maybelost?: boolean;
    copy?: string;
    copypath?: string;
    size?: number;
    files?: number;
    versions?: MaterialVersion[];
    pinned?: boolean;
    agent?: string;
    tool?: string;
    sessionid?: string;
    subject?: string;
    ticket?: number;
    workspaceid?: string;
    blockid?: string;
    created: number;
    updated: number;
};

export type MaterialsProject = { key: string; folder?: string; name?: string };

export type MaterialsView = {
    project: MaterialsProject;
    materials: Material[];
    workfiles: number;
};

export type MaterialsChanged = { project: string; ids?: string[] };

export function materialAt(m: Material): number {
    return m?.updated || m?.created || 0;
}

// The current version's number; the first is 1.
export function materialVersion(m: Material): number {
    return (m?.versions ?? []).reduce((n, v) => Math.max(n, v?.n ?? 0), 0);
}

export function materialCopied(m: Material): boolean {
    return m?.copy === MaterialCopyKept && (m.versions?.length ?? 0) > 0;
}

export function linkHost(link: string): string {
    if (!link) {
        return "";
    }
    try {
        return new URL(link).host;
    } catch {
        return "";
    }
}

export type MaterialGroup = {
    key: string;
    // library.materials.day.<labelKey>, or a date when labelKey is null.
    labelKey: string;
    label?: string;
    // Within a day the rows say only the time.
    timeOnly: boolean;
    items: Material[];
};

function dayStart(at: number): number {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function dayLabel(at: number, now: number, locale: string): string {
    const date = new Date(at);
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    return new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: sameYear ? undefined : "numeric",
    }).format(date);
}

// Pinned first, then by day (Today, Yesterday, then dates), the newest first in each (AC2, AC5).
export function groupMaterials(materials: Material[], now: number, locale: string): MaterialGroup[] {
    const sorted = [...(materials ?? [])]
        .filter((m) => m != null)
        .sort((a, b) => materialAt(b) - materialAt(a) || a.id.localeCompare(b.id));
    const groups: MaterialGroup[] = [];
    const pinned = sorted.filter((m) => m.pinned);
    if (pinned.length > 0) {
        groups.push({ key: "pinned", labelKey: "pinned", timeOnly: false, items: pinned });
    }
    const today = dayStart(now);
    const yesterday = dayStart(today - 1);
    for (const m of sorted) {
        if (m.pinned) {
            continue;
        }
        const day = dayStart(materialAt(m));
        const key = `day:${day}`;
        let group = groups.find((g) => g.key === key);
        if (group == null) {
            const labelKey = day === today ? "today" : day === yesterday ? "yesterday" : null;
            group = {
                key,
                labelKey,
                label: labelKey == null ? dayLabel(day, now, locale) : undefined,
                timeOnly: true,
                items: [],
            };
            groups.push(group);
        }
        group.items.push(m);
    }
    return groups;
}

// Every word in the title, the original name, the agent, the session's subject, the ticket (#1318) or the host (AC6).
export function materialSearchTexts(m: Material): string[] {
    return [m.title, m.autotitle, m.originalname, m.agent, m.subject, m.ticket ? `#${m.ticket}` : "", linkHost(m.link)];
}

export function filterMaterials(materials: Material[], query: string): Material[] {
    return (materials ?? []).filter((m) => matchesQuery(materialSearchTexts(m), query));
}

// A material's form, as the row's pill says it (AC3): its key under library.materials.form, and whether it is a state
// to notice ("Not copied"), never the action colour.
export type MaterialForm = { key: string; warn: boolean };

export function materialForm(m: Material): MaterialForm {
    const copied = materialCopied(m);
    if (copied && m.link) {
        return { key: "linkCopy", warn: false };
    }
    if (copied) {
        return { key: "copy", warn: false };
    }
    if (m.link && m.kind === MaterialKindLink) {
        return { key: "link", warn: false };
    }
    if (m.link) {
        return { key: "linkNotCopied", warn: true };
    }
    return { key: "notCopied", warn: true };
}

// Where it comes from when it is not a publication: its key under library.materials.origin (AC3).
export function materialOriginKey(m: Material): string {
    switch (m?.source) {
        case MaterialSourceNamed:
            return m.agent ? "namedBy" : "named";
        case MaterialSourceDeclared:
            return m.agent ? "declaredBy" : "declared";
        case MaterialSourceBrought:
            return "brought";
    }
    return null;
}

export function materialLinkedFiles(m: Material): number {
    const current = (m?.versions ?? []).find((v) => v?.n === materialVersion(m));
    return current?.files ?? m?.files ?? 0;
}

// The file Show in folder reveals: the kept copy, or the original while it exists (AC10).
export function materialFolderPath(m: Material): string {
    if (materialCopied(m) && m.copypath) {
        return m.copypath;
    }
    if (m?.original && !m.originalgone) {
        return m.original;
    }
    return null;
}

// The file a panel shows: the kept copy, else the original while it exists.
function materialFile(m: Material): string {
    return materialFolderPath(m);
}

export type MaterialOpen =
    | { how: "browser"; url: string }
    | { how: "preview"; path: string }
    | { how: "native"; path: string }
    | { how: "folder"; path: string };

// How Open in a view opens it, by kind (AC7): a link in a browser panel, a PDF, image, video or text in the Preview
// panel, a page by its online version (the local-page address comes with FR-MAT-004, until then Show in folder), a
// document in the application of this computer. Null when there is nothing left to open.
export function materialOpenPlan(m: Material): MaterialOpen {
    if (m == null) {
        return null;
    }
    const file = materialFile(m);
    switch (m.kind) {
        case MaterialKindLink:
            return m.link ? { how: "browser", url: m.link } : null;
        case MaterialKindPage:
            if (m.link) {
                return { how: "browser", url: m.link };
            }
            return file ? { how: "folder", path: file } : null;
        case MaterialKindPdf:
        case MaterialKindImage:
        case MaterialKindVideo:
        case MaterialKindText:
            if (file) {
                return { how: "preview", path: file };
            }
            return m.link ? { how: "browser", url: m.link } : null;
        case MaterialKindDocument:
            return file ? { how: "native", path: file } : null;
    }
    if (m.link) {
        return { how: "browser", url: m.link };
    }
    return file ? { how: "native", path: file } : null;
}

// A panel open now, as the section reads it to say "Show it" (AC8).
export type OpenPanel = { blockId: string; tabId: string; view: string; file?: string; urls?: string[] };

function sameUrl(a: string, b: string): boolean {
    const clean = (u: string) => (u ?? "").replace(/#.*$/, "").replace(/\/+$/, "");
    return !!a && !!b && clean(a) === clean(b);
}

function samePath(a: string, b: string): boolean {
    return !!a && !!b && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

// The panel already showing the material, if any: its link in a browser panel, or its copy or original in a preview.
export function findOpenPanel(panels: OpenPanel[], m: Material): OpenPanel {
    if (m == null) {
        return null;
    }
    const files = [m.copypath, m.original].filter(Boolean);
    for (const panel of panels ?? []) {
        if (m.link && (panel.urls ?? []).some((u) => sameUrl(u, m.link))) {
            return panel;
        }
        if (panel.file && files.some((f) => samePath(f, panel.file))) {
            return panel;
        }
    }
    return null;
}

// The grey count on the section's entry (AC12): what arrived since the last visit; a first visit counts everything.
export function newMaterialsCount(materials: Material[], lastSeen: number): number {
    return (materials ?? []).filter((m) => (m?.created ?? 0) > (lastSeen ?? 0)).length;
}

export function materialsSeenStorageKey(project: string): string {
    return `molten:materials:seen:${project ?? ""}`;
}

// A size as the rows say it, in the interface's language ("11 MB", "11 Mo").
export function materialSizeText(bytes: number, locale: string): string {
    if (!bytes || bytes <= 0) {
        return "";
    }
    const [value, unit] =
        bytes >= 1000 * 1000 * 1000
            ? [bytes / 1e9, "gigabyte"]
            : bytes >= 1000 * 1000
              ? [bytes / 1e6, "megabyte"]
              : bytes >= 1000
                ? [bytes / 1e3, "kilobyte"]
                : [bytes, "byte"];
    return new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "short",
        maximumFractionDigits: value < 10 ? 1 : 0,
    }).format(value);
}

// A copy the developer can still ask for (AC10): "Keep a copy" on a reference whose original exists, up to the
// requested limit, and "Keep anyway" on one the secret detection held back.
export const MaterialRequestedLimit = 500 * 1000 * 1000;

export type MaterialKeepOffer = "keep" | "keepanyway";

export function materialKeepOffer(m: Material): MaterialKeepOffer {
    if (m == null || materialCopied(m) || !m.original || m.originalgone) {
        return null;
    }
    if (m.copy === "secret") {
        return "keepanyway";
    }
    if (m.copy === "spacefull" || (m.size ?? 0) > MaterialRequestedLimit) {
        return null;
    }
    return "keep";
}

// Title edits: an empty title brings the automatic one back (the registry's rule).
export function renamedTitle(input: string): string {
    return (input ?? "").trim();
}
