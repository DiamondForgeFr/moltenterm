// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    compareNames,
    defaultSortFromSetting,
    DirSort,
    DirSortMetaKey,
    formatDirSort,
    isFolderEntry,
    nextDirSort,
    parseDirSort,
    resolveDirSort,
    sortColumnFromTableId,
    sortDirectoryEntries,
    tableColumnId,
} from "./directory-sort";

function dir(name: string, extra: Partial<FileInfo> = {}): FileInfo {
    return { path: `/p/${name}`, name, isdir: true, mimetype: "directory", size: -1, modtime: 0, ...extra };
}

function file(name: string, extra: Partial<FileInfo> = {}): FileInfo {
    return { path: `/p/${name}`, name, isdir: false, mimetype: "text/plain", size: 1, modtime: 0, ...extra };
}

const names = (entries: FileInfo[]) => entries.map((e) => e.name);

const AllSorts: DirSort[] = ["name", "type", "modtime", "size", "modestr"].flatMap((column) => [
    { column, desc: false } as DirSort,
    { column, desc: true } as DirSort,
]);

describe("folders first (FR-FILE-003)", () => {
    const entries = [
        file("b.txt", { modtime: 5, size: 10 }),
        dir("zeta", { modtime: 1 }),
        file("A.md", { mimetype: "text/markdown", modtime: 9, size: 999 }),
        { path: "/", name: "..", isdir: true, mimetype: "directory", modtime: 100 },
        dir("Alpha", { modtime: 50 }),
        file("link-to-dir", { isdir: false, mimetype: "directory", modtime: 2 }),
    ];

    it.each(AllSorts)("keeps .. first and folders before files in %o", (sort) => {
        const sorted = sortDirectoryEntries(entries, sort);
        expect(sorted[0].name).toBe("..");
        const kinds = sorted.slice(1).map(isFolderEntry);
        const firstFile = kinds.indexOf(false);
        expect(kinds.slice(0, firstFile).every(Boolean)).toBe(true);
        expect(kinds.slice(firstFile).some(Boolean)).toBe(false);
    });

    it("counts a link to a folder as a folder", () => {
        expect(isFolderEntry(file("x", { mimetype: "directory" }))).toBe(true);
        expect(isFolderEntry(dir("y"))).toBe(true);
        expect(isFolderEntry(file("z"))).toBe(false);
        expect(names(sortDirectoryEntries(entries, { column: "name", desc: false }))).toEqual([
            "..",
            "Alpha",
            "link-to-dir",
            "zeta",
            "A.md",
            "b.txt",
        ]);
    });

    it("reverses the order inside each group, never the groups", () => {
        expect(names(sortDirectoryEntries(entries, { column: "name", desc: true }))).toEqual([
            "..",
            "zeta",
            "link-to-dir",
            "Alpha",
            "b.txt",
            "A.md",
        ]);
        expect(names(sortDirectoryEntries(entries, { column: "modtime", desc: true }))).toEqual([
            "..",
            "Alpha",
            "link-to-dir",
            "zeta",
            "A.md",
            "b.txt",
        ]);
        expect(names(sortDirectoryEntries(entries, { column: "size", desc: true }))).toEqual([
            "..",
            "link-to-dir",
            "Alpha",
            "zeta",
            "A.md",
            "b.txt",
        ]);
    });

    it("does not change the list it is given", () => {
        const copy = [...entries];
        sortDirectoryEntries(entries, { column: "name", desc: true });
        expect(entries).toEqual(copy);
    });
});

describe("name order", () => {
    it("is natural: file2 before file10", () => {
        const sorted = sortDirectoryEntries([file("file10"), file("file2"), file("file1")], {
            column: "name",
            desc: false,
        });
        expect(names(sorted)).toEqual(["file1", "file2", "file10"]);
    });

    it("ignores case", () => {
        const sorted = sortDirectoryEntries([file("beta"), file("Alpha"), file("alpha2"), file("Gamma")], {
            column: "name",
            desc: false,
        });
        expect(names(sorted)).toEqual(["Alpha", "alpha2", "beta", "Gamma"]);
    });

    it("gives names equal but for case a stable order", () => {
        expect(compareNames("README", "readme")).not.toBe(0);
        expect(Math.sign(compareNames("README", "readme"))).toBe(-Math.sign(compareNames("readme", "README")));
    });
});

describe("type order", () => {
    it("sorts by the type column, then by name", () => {
        const sorted = sortDirectoryEntries(
            [
                file("z.ts", { mimetype: "text/typescript" }),
                file("b.md", { mimetype: "text/markdown" }),
                file("a.ts", { mimetype: "text/typescript" }),
                file("a.md", { mimetype: "text/markdown; charset=utf-8" }),
                dir("src"),
                dir("docs"),
            ],
            { column: "type", desc: false }
        );
        expect(names(sorted)).toEqual(["docs", "src", "a.md", "b.md", "a.ts", "z.ts"]);
    });

    it("keeps the name ascending when the type is reversed", () => {
        const sorted = sortDirectoryEntries(
            [
                file("b.md", { mimetype: "text/markdown" }),
                file("a.ts", { mimetype: "text/typescript" }),
                file("a.md", { mimetype: "text/markdown" }),
            ],
            { column: "type", desc: true }
        );
        expect(names(sorted)).toEqual(["a.ts", "a.md", "b.md"]);
    });
});

describe("the panel's sort", () => {
    it("reads the block meta first", () => {
        expect(resolveDirSort({ [DirSortMetaKey]: "size:desc" }, "type")).toEqual({ column: "size", desc: true });
        expect(resolveDirSort({ [DirSortMetaKey]: "type:asc" }, "modtime")).toEqual({ column: "type", desc: false });
    });

    it("falls back to preview:defaultsort, then to name", () => {
        expect(resolveDirSort({}, "type")).toEqual({ column: "type", desc: false });
        expect(resolveDirSort(null, "modtime")).toEqual({ column: "modtime", desc: true });
        expect(resolveDirSort({ [DirSortMetaKey]: "bogus:asc" }, "name")).toEqual({ column: "name", desc: false });
        expect(defaultSortFromSetting("size")).toEqual({ column: "name", desc: false });
        expect(defaultSortFromSetting("nonsense")).toEqual({ column: "name", desc: false });
        expect(defaultSortFromSetting(undefined)).toEqual({ column: "name", desc: false });
    });

    it("writes and reads back the same value", () => {
        for (const sort of AllSorts) {
            expect(parseDirSort(formatDirSort(sort))).toEqual(sort);
        }
        expect(parseDirSort("name")).toBeNull();
        expect(parseDirSort(42)).toBeNull();
        expect(parseDirSort("name:up")).toBeNull();
    });

    it("keeps each panel's sort apart", () => {
        const left = { [DirSortMetaKey]: "modtime:desc" };
        const right = { [DirSortMetaKey]: "name:asc" };
        expect(resolveDirSort(left, "name")).not.toEqual(resolveDirSort(right, "name"));
    });

    it("reverses on a second click and starts another column in its own direction", () => {
        const byName = { column: "name", desc: false } as DirSort;
        expect(nextDirSort(byName, "name")).toEqual({ column: "name", desc: true });
        expect(nextDirSort({ column: "name", desc: true }, "name")).toEqual({ column: "name", desc: false });
        expect(nextDirSort(byName, "modtime")).toEqual({ column: "modtime", desc: true });
        expect(nextDirSort(byName, "size")).toEqual({ column: "size", desc: true });
        expect(nextDirSort({ column: "size", desc: true }, "type")).toEqual({ column: "type", desc: false });
    });

    it("maps the type column to the table's mimetype column", () => {
        expect(tableColumnId("type")).toBe("mimetype");
        expect(sortColumnFromTableId("mimetype")).toBe("type");
        expect(sortColumnFromTableId("name")).toBe("name");
        expect(sortColumnFromTableId("logo")).toBeNull();
        expect(sortColumnFromTableId("path")).toBeNull();
    });
});
