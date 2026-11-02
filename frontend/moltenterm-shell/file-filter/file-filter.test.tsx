// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: Mocks.call } }));

import { FileCheckResult, FileConfineGate } from "../file-confine/file-confine";
import {
    clearFileFilterMeta,
    FileFilterByMetaKey,
    FileFilterByNameMetaKey,
    FileFilterDirMetaKey,
    FileFilterMetaKey,
    FileFilterModel,
    FileFilterPrevMetaKey,
    FileFilterRecursiveMetaKey,
    fileFilterStayMeta,
    FileFocusedTsMetaKey,
    FileSearchCommand,
    FileSearchRoute,
    FileShowHiddenMetaKey,
    globToRegExp,
    matchFileName,
    readFileFilter,
    samePath,
    searchFiles,
    userFileFilterMeta,
} from "./file-filter";
import { FileFilterBar } from "./file-filter-bar";

const Src = "/p/app/src";

function agentFilter(extra: Record<string, any> = {}): Record<string, any> {
    return {
        [FileFilterMetaKey]: "test",
        [FileFilterDirMetaKey]: Src,
        [FileFilterByMetaKey]: "agent",
        [FileFilterByNameMetaKey]: "Olivia",
        ...extra,
    };
}

describe("readFileFilter", () => {
    it("reads the pattern, the folder and who set it", () => {
        expect(readFileFilter(agentFilter({ [FileFilterRecursiveMetaKey]: true }) as MetaType)).toEqual({
            pattern: "test",
            recursive: true,
            dir: Src,
            by: { kind: "agent", name: "Olivia" },
        });
        expect(readFileFilter({ [FileFilterMetaKey]: "x", [FileFilterByMetaKey]: "command" } as MetaType).by).toEqual({
            kind: "command",
        });
        expect(readFileFilter({ [FileFilterMetaKey]: "x" } as MetaType).by).toEqual({ kind: "user" });
        expect(readFileFilter({ [FileFilterMetaKey]: "" } as MetaType)).toBeNull();
        expect(readFileFilter(null)).toBeNull();
    });
});

describe("matchFileName (as wavesrv matches, pkg/molten/filesearch)", () => {
    const cases: [string, string, boolean][] = [
        ["Button.test.tsx", "", true],
        ["Button.test.tsx", "TEST", true],
        ["Button.test.tsx", "est.t", true],
        ["Button.tsx", "test", false],
        ["Button.TSX", "*.tsx", true],
        ["Button.tsx.map", "*.tsx", false],
        ["file1.go", "file?.go", true],
        ["file10.go", "file?.go", false],
        ["a.go", "[ab].go", true],
        ["c.go", "[ab].go", false],
        ["c.go", "[^ab].go", true],
        ["m.go", "[a-p].go", true],
        ["z.go", "[a-p].go", false],
        ["a*b", "a\\*b", true],
        ["axb", "a\\*b", false],
        ["x", "[", false],
        ["a(b).c", "a(b).*", true],
    ];
    it.each(cases)("%s against %s", (name, pattern, want) => {
        expect(matchFileName(name, pattern)).toBe(want);
    });

    it("refuses malformed globs", () => {
        expect(globToRegExp("[abc")).toBeNull();
        expect(globToRegExp("abc\\")).toBeNull();
        expect(globToRegExp("[z-a]")).toBeNull();
        expect(globToRegExp("*.ts")).not.toBeNull();
    });
});

describe("filter meta", () => {
    it("the developer's filter carries no name; clearing writes every key null", () => {
        expect(userFileFilterMeta(Src, "a", false)).toEqual({
            [FileFilterMetaKey]: "a",
            [FileFilterRecursiveMetaKey]: null,
            [FileFilterDirMetaKey]: Src,
            [FileFilterByMetaKey]: null,
            [FileFilterByNameMetaKey]: null,
        });
        expect(userFileFilterMeta(Src, "", true)).toEqual(clearFileFilterMeta());
        expect(Object.values(clearFileFilterMeta()).every((v) => v === null)).toBe(true);
    });

    it("Stay puts back the filter a request outside the project replaced", () => {
        const meta = { [FileFilterPrevMetaKey]: { [FileFilterMetaKey]: "mine", [FileFilterDirMetaKey]: "/p/app" } };
        expect(fileFilterStayMeta(meta as MetaType)).toEqual({
            [FileFilterPrevMetaKey]: null,
            [FileFilterMetaKey]: "mine",
            [FileFilterRecursiveMetaKey]: null,
            [FileFilterDirMetaKey]: "/p/app",
            [FileFilterByMetaKey]: null,
            [FileFilterByNameMetaKey]: null,
        });
        expect(fileFilterStayMeta({ [FileFilterPrevMetaKey]: {} } as MetaType)[FileFilterMetaKey]).toBeNull();
        expect(fileFilterStayMeta({} as MetaType)).toEqual({});
    });
});

describe("searchFiles", () => {
    it("asks wavesrv's molten files route", async () => {
        Mocks.call.mockResolvedValueOnce({
            matches: [{ name: "ui/a.tsx", path: "/p/app/src/ui/a.tsx" }],
            truncated: true,
        });
        const got = await searchFiles(Src, "*.tsx", true, false);
        expect(Mocks.call).toHaveBeenCalledWith(
            FileSearchCommand,
            { folder: Src, pattern: "*.tsx", recursive: true, showhidden: false },
            expect.objectContaining({ route: FileSearchRoute })
        );
        expect(got).toEqual({ matches: [{ name: "ui/a.tsx", path: "/p/app/src/ui/a.tsx" }], truncated: true });
    });
});

type Fixture = {
    model: FileFilterModel;
    blockAtom: PrimitiveAtom<Block>;
    shownAtom: PrimitiveAtom<string>;
    rawAtom: PrimitiveAtom<string>;
    focusAtom: PrimitiveAtom<boolean>;
    settingAtom: PrimitiveAtom<boolean>;
    writes: MetaType[];
    hold: boolean;
    held: (() => void)[];
};

const models: FileFilterModel[] = [];

afterEach(() => {
    models.splice(0).forEach((m) => m.dispose());
});

function merge(blockAtom: PrimitiveAtom<Block>, update: Record<string, any>) {
    const next: Record<string, any> = { ...globalStore.get(blockAtom).meta };
    for (const [k, v] of Object.entries(update)) {
        if (v == null) {
            delete next[k];
        } else {
            next[k] = v;
        }
    }
    globalStore.set(blockAtom, { ...globalStore.get(blockAtom), meta: next as MetaType });
}

// Writes merge into the block like wavesrv does (null deletes); with hold, they land only when released.
function fixture(meta: Record<string, any>, path = Src): Fixture {
    const blockAtom = atom({ oid: "b1", meta: { file: path, ...meta } } as Block) as PrimitiveAtom<Block>;
    const f: Fixture = {
        model: null,
        blockAtom,
        shownAtom: atom(path) as PrimitiveAtom<string>,
        rawAtom: atom(path) as PrimitiveAtom<string>,
        focusAtom: atom(false) as PrimitiveAtom<boolean>,
        settingAtom: atom(true) as PrimitiveAtom<boolean>,
        writes: [],
        hold: false,
        held: [],
    };
    f.model = new FileFilterModel({
        blockAtom,
        shownPathAtom: f.shownAtom,
        rawPathAtom: f.rawAtom,
        showHiddenSettingAtom: f.settingAtom,
        isFocusedAtom: f.focusAtom,
        now: () => 1234,
        writeMeta: async (update) => {
            f.writes.push(update);
            const land = () => merge(blockAtom, update as Record<string, any>);
            if (f.hold) {
                f.held.push(land);
                return;
            }
            land();
        },
    });
    f.model.start();
    models.push(f.model);
    return f;
}

describe("FileFilterModel", () => {
    it("shows an agent's filter on its folder only", () => {
        const f = fixture(agentFilter());
        expect(globalStore.get(f.model.activeAtom)?.by).toEqual({ kind: "agent", name: "Olivia" });
        globalStore.set(f.shownAtom, "/p/app");
        expect(globalStore.get(f.model.activeAtom)).toBeNull();
        expect(globalStore.get(f.model.filterAtom)?.pattern).toBe("test");
    });

    it("editing makes the filter the developer's and keeps a recursive one recursive (AC-6)", () => {
        const f = fixture(agentFilter({ [FileFilterRecursiveMetaKey]: true }));
        f.model.setPattern("tests");
        expect(f.writes.at(-1)).toEqual(userFileFilterMeta(Src, "tests", true));
        expect(globalStore.get(f.model.activeAtom)).toEqual({
            pattern: "tests",
            recursive: true,
            dir: Src,
            by: { kind: "user" },
        });
    });

    it("keys typed faster than the meta writes are never lost", () => {
        const f = fixture({});
        f.hold = true;
        f.model.setPattern("a");
        f.model.setPattern(globalStore.get(f.model.activeAtom).pattern + "b");
        f.held.shift()();
        expect(globalStore.get(f.model.activeAtom).pattern).toBe("ab");
        f.model.setPattern(globalStore.get(f.model.activeAtom).pattern + "c");
        f.held.splice(0).forEach((land) => land());
        expect(globalStore.get(f.model.activeAtom).pattern).toBe("abc");
        expect(globalStore.get(f.model.draftAtom)).toBeNull();
    });

    it("an agent's filter arriving while the developer types wins", () => {
        const f = fixture({});
        f.hold = true;
        f.model.setPattern("a");
        merge(f.blockAtom, agentFilter());
        expect(globalStore.get(f.model.activeAtom).by).toEqual({ kind: "agent", name: "Olivia" });
    });

    it("clearing writes every key null, and does nothing without a filter", () => {
        const f = fixture(agentFilter());
        f.model.clear();
        expect(f.writes.at(-1)).toEqual(clearFileFilterMeta());
        expect(globalStore.get(f.model.activeAtom)).toBeNull();
        const writes = f.writes.length;
        f.model.clear();
        expect(f.writes.length).toBe(writes);
    });

    it("opening another folder clears the filter, opening a file keeps it for Back (AC-4, AC-6)", () => {
        const f = fixture(agentFilter());
        const srcListing = { path: Src, isdir: true } as FileInfo;
        // The directory view still lists src while the panel moves on to the file it opened.
        globalStore.set(f.rawAtom, Src + "/a.test.ts");
        globalStore.set(f.shownAtom, Src + "/a.test.ts");
        f.model.clearIfAnotherFolder(srcListing);
        f.model.clearIfAnotherFolder({ path: Src + "/a.test.ts", isdir: false } as FileInfo);
        globalStore.set(f.rawAtom, Src);
        globalStore.set(f.shownAtom, Src);
        f.model.clearIfAnotherFolder(srcListing);
        expect(f.writes).toEqual([]);
        globalStore.set(f.rawAtom, "/p/app/docs");
        f.model.clearIfAnotherFolder(srcListing);
        expect(f.writes).toEqual([]);
        globalStore.set(f.shownAtom, "/p/app/docs");
        f.model.clearIfAnotherFolder(srcListing);
        expect(f.writes).toEqual([]);
        f.model.clearIfAnotherFolder({ path: "/p/app/docs/", isdir: true } as FileInfo);
        expect(f.writes).toEqual([clearFileFilterMeta()]);
    });

    it("a question waiting in the panel keeps the agent's filter (raw is not what the panel shows yet)", () => {
        const f = fixture(agentFilter({ [FileFilterDirMetaKey]: "/elsewhere" }), "/elsewhere");
        globalStore.set(f.shownAtom, Src);
        f.model.clearIfAnotherFolder({ path: Src, isdir: true } as FileInfo);
        expect(f.writes).toEqual([]);
        expect(globalStore.get(f.model.activeAtom)).toBeNull();
    });

    it("compares a listing's ~ path with the meta's full one", () => {
        expect(samePath("~/code/app", "/Users/me/code/app/")).toBe(true);
        expect(samePath("/p/app", "/p/app")).toBe(true);
        expect(samePath("/p/app", "/p/other")).toBe(false);
        expect(samePath(null, "/p")).toBe(false);
    });

    it("keeps the hidden files choice in the block meta", () => {
        const f = fixture({});
        expect(globalStore.get(f.model.showHiddenAtom)).toBe(true);
        globalStore.set(f.settingAtom, false);
        expect(globalStore.get(f.model.showHiddenAtom)).toBe(false);
        globalStore.set(f.model.showHiddenAtom, (prev) => !prev);
        expect(f.writes.at(-1)).toEqual({ [FileShowHiddenMetaKey]: true });
        expect(globalStore.get(f.model.showHiddenAtom)).toBe(true);
    });

    it("notes when the panel was focused, for molten files to reuse it (AC-1)", () => {
        const f = fixture({});
        globalStore.set(f.focusAtom, true);
        expect(f.writes).toEqual([{ [FileFocusedTsMetaKey]: 1234 }]);
        globalStore.set(f.focusAtom, false);
        expect(f.writes.length).toBe(1);
    });

    it("the filter survives a remount: a new model reads it back from the meta (AC-7)", () => {
        const f = fixture(agentFilter({ [FileFilterRecursiveMetaKey]: true }));
        f.model.dispose();
        const again = new FileFilterModel({
            blockAtom: f.blockAtom,
            shownPathAtom: f.shownAtom,
            rawPathAtom: f.rawAtom,
            showHiddenSettingAtom: f.settingAtom,
            writeMeta: async () => {},
        });
        expect(globalStore.get(again.activeAtom)).toMatchObject({ pattern: "test", recursive: true });
    });
});

describe("the gate's Stay after molten files", () => {
    it("puts the panel and its previous filter back in one write", async () => {
        const blockAtom = atom({
            oid: "b1",
            meta: {
                file: "/elsewhere",
                "molten:fileorigin": "agent",
                "molten:fileoriginname": "Olivia",
                ...agentFilter({ [FileFilterDirMetaKey]: "/elsewhere" }),
                [FileFilterPrevMetaKey]: { [FileFilterMetaKey]: "mine", [FileFilterDirMetaKey]: "/p/app" },
            },
        } as unknown as Block) as PrimitiveAtom<Block>;
        const writes: MetaType[] = [];
        const gate = new FileConfineGate({
            blockAtom,
            workspaceAtom: atom({ oid: "ws", meta: { "molten:project": "/p/app" } } as unknown as Workspace),
            check: async (path: string, project: string): Promise<FileCheckResult> => ({
                inside: path.startsWith(project),
                path,
                project,
                isdir: true,
            }),
            writeMeta: async (update) => {
                writes.push(update);
            },
        });
        globalStore.set(gate.shownPathAtom, "/p/app");
        await gate.evaluate();
        expect(globalStore.get(gate.pendingAtom)?.origin).toEqual({ kind: "agent", name: "Olivia" });
        await gate.stay();
        expect(writes.at(-1)).toMatchObject({
            file: "/p/app",
            [FileFilterMetaKey]: "mine",
            [FileFilterDirMetaKey]: "/p/app",
            [FileFilterByMetaKey]: null,
            [FileFilterPrevMetaKey]: null,
        });
        gate.dispose();
    });
});

describe("FileFilterBar", () => {
    const noop = () => {};

    it("names the agent that set the filter (AC-6)", () => {
        const filter = readFileFilter(agentFilter() as MetaType);
        const html = renderToStaticMarkup(
            <FileFilterBar search="test" filter={filter} truncated={false} onClear={noop} />
        );
        expect(html).toContain("Set by Olivia");
        expect(html).toContain("test");
        expect(html).not.toContain("file-filter-truncated");
    });

    it("says a terminal set it, a recursive search and a cut list", () => {
        const filter = readFileFilter({
            [FileFilterMetaKey]: "*.tsx",
            [FileFilterRecursiveMetaKey]: true,
            [FileFilterByMetaKey]: "command",
        } as MetaType);
        const html = renderToStaticMarkup(
            <FileFilterBar search="*.tsx" filter={filter} truncated={true} onClear={noop} />
        );
        expect(html).toContain("Set by the terminal");
        expect(html).toContain("every subfolder");
        expect(html).toContain("1000");
    });

    it("the developer's own filter has no chip", () => {
        const filter = readFileFilter({ [FileFilterMetaKey]: "a" } as MetaType);
        const html = renderToStaticMarkup(
            <FileFilterBar search="a" filter={filter} truncated={false} onClear={noop} />
        );
        expect(html).not.toContain("file-filter-setby");
    });
});
