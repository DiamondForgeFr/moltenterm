// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The file panel's order (FR-FILE-003, DS-FILE-003): folders first in every sort and direction, ".." on top, one
// column at a time. A panel keeps its sort in its block meta; without one it uses the preview:defaultsort setting.

export const DirSortMetaKey = "molten:filesort";
export const DirSortColumns = ["name", "type", "modtime", "size", "modestr"] as const;
// The columns preview:defaultsort accepts; an unknown value falls back to name.
export const DefaultSortSettingValues = ["name", "type", "modtime"] as const;

export type DirSortColumn = (typeof DirSortColumns)[number];
export type DirSort = { column: DirSortColumn; desc: boolean };

// The table's column ids differ from the sort names only for the type column (Wave's id is its accessor).
const TableColumnIds: Record<DirSortColumn, string> = {
    name: "name",
    type: "mimetype",
    modtime: "modtime",
    size: "size",
    modestr: "modestr",
};

const NameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function isSortColumn(value: unknown): value is DirSortColumn {
    return typeof value === "string" && (DirSortColumns as readonly string[]).includes(value);
}

// The direction a column takes on its first click: newest and largest first, words from A.
export function firstDirectionDesc(column: DirSortColumn): boolean {
    return column === "modtime" || column === "size";
}

export function defaultSortFromSetting(setting: string): DirSort {
    const column: DirSortColumn = (DefaultSortSettingValues as readonly string[]).includes(setting)
        ? (setting as DirSortColumn)
        : "name";
    return { column, desc: firstDirectionDesc(column) };
}

// "<column>:<asc|desc>", or null when the value is not a sort.
export function parseDirSort(value: unknown): DirSort {
    if (typeof value !== "string") {
        return null;
    }
    const [column, dir] = value.split(":");
    if (!isSortColumn(column) || (dir !== "asc" && dir !== "desc")) {
        return null;
    }
    return { column, desc: dir === "desc" };
}

export function formatDirSort(sort: DirSort): string {
    return `${sort.column}:${sort.desc ? "desc" : "asc"}`;
}

export function resolveDirSort(blockMeta: { [key: string]: any }, defaultSetting: string): DirSort {
    return parseDirSort(blockMeta?.[DirSortMetaKey]) ?? defaultSortFromSetting(defaultSetting);
}

// A header click: the same column reverses, another column starts in its own first direction.
export function nextDirSort(current: DirSort, column: DirSortColumn): DirSort {
    if (current?.column === column) {
        return { column, desc: !current.desc };
    }
    return { column, desc: firstDirectionDesc(column) };
}

export function tableColumnId(column: DirSortColumn): string {
    return TableColumnIds[column];
}

export function sortColumnFromTableId(id: string): DirSortColumn {
    const found = DirSortColumns.find((c) => TableColumnIds[c] === id);
    return found ?? null;
}

// A link to a folder counts as a folder: the listing reports it with the "directory" type (wshremote_file.go).
export function isFolderEntry(entry: FileInfo): boolean {
    return !!entry?.isdir || cleanType(entry?.mimetype) === "directory";
}

function cleanType(mimetype: string): string {
    return (mimetype ?? "").split(";")[0].trim();
}

// Case-insensitive natural order (file2 before file10); names equal but for case keep a stable order.
export function compareNames(a: string, b: string): number {
    const cmp = NameCollator.compare(a ?? "", b ?? "");
    if (cmp !== 0) {
        return cmp;
    }
    return (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;
}

function compareNumbers(a: number, b: number): number {
    return (a ?? 0) - (b ?? 0);
}

function compareByColumn(a: FileInfo, b: FileInfo, column: DirSortColumn): number {
    switch (column) {
        case "type":
            return NameCollator.compare(cleanType(a.mimetype), cleanType(b.mimetype));
        case "modtime":
            return compareNumbers(a.modtime, b.modtime);
        case "size":
            return compareNumbers(a.size, b.size);
        case "modestr":
            return (a.modestr ?? "").localeCompare(b.modestr ?? "");
        default:
            return compareNames(a.name, b.name);
    }
}

// ".." first, then folders, then files; inside each group the column in the sort's direction, then the name.
export function compareEntries(a: FileInfo, b: FileInfo, sort: DirSort): number {
    const aUp = a.name === "..";
    const bUp = b.name === "..";
    if (aUp !== bUp) {
        return aUp ? -1 : 1;
    }
    const aFolder = isFolderEntry(a);
    const bFolder = isFolderEntry(b);
    if (aFolder !== bFolder) {
        return aFolder ? -1 : 1;
    }
    const cmp = compareByColumn(a, b, sort.column);
    if (cmp !== 0) {
        return sort.desc ? -cmp : cmp;
    }
    if (sort.column === "name") {
        return 0;
    }
    return compareNames(a.name, b.name);
}

export function sortDirectoryEntries(entries: FileInfo[], sort: DirSort): FileInfo[] {
    return [...(entries ?? [])].sort((a, b) => compareEntries(a, b, sort));
}
