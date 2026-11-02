// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The file panel's filter (FR-FILE-002, DS-FILE-002). It lives in the block meta, so it survives a remount and a
// restart, whoever set it: the developer's type-to-filter, or an agent's `molten files` (pkg/molten/filesearch), which
// wavesrv labels with the agent's first name. A filter applies to one folder; showing another folder clears it. A
// recursive filter lists the matches of every subfolder, computed by wavesrv so the panel and the command agree.

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom, SetStateAction } from "jotai";
import type { FileAskOrigin } from "../file-confine/file-confine";

// must match pkg/molten/filesearch/filesearch.go
export const FileFilterMetaKey = "molten:filefilter";
export const FileFilterRecursiveMetaKey = "molten:filefilterrecursive";
export const FileFilterDirMetaKey = "molten:filefilterdir";
export const FileFilterByMetaKey = "molten:filefilterby";
export const FileFilterByNameMetaKey = "molten:filefilterbyname";
export const FileFilterPrevMetaKey = "molten:filefilterprev";
export const FileShowHiddenMetaKey = "molten:fileshowhidden";
export const FileFocusedTsMetaKey = "molten:filefocusedts";
export const FileFilterByAgent = "agent";
export const FileFilterByCommand = "command";
export const FileSearchRoute = "molten:files";
export const FileSearchCommand = "moltenfilessearch";
export const FileSearchMaxMatches = 1000;

const FilterKeys = [
    FileFilterMetaKey,
    FileFilterRecursiveMetaKey,
    FileFilterDirMetaKey,
    FileFilterByMetaKey,
    FileFilterByNameMetaKey,
];
const SearchTimeoutMs = 60000;

export type FileFilter = {
    pattern: string;
    recursive: boolean;
    // The folder it applies to, as the panel's file meta names it.
    dir: string;
    by: FileAskOrigin;
};

export type FileSearchResult = { matches: FileInfo[]; truncated?: boolean };

function metaRecord(meta: MetaType): Record<string, any> {
    return (meta ?? {}) as Record<string, any>;
}

function filterBy(meta: Record<string, any>): FileAskOrigin {
    const kind = meta[FileFilterByMetaKey];
    const name = meta[FileFilterByNameMetaKey];
    if (kind === FileFilterByAgent && typeof name === "string" && name.trim() !== "") {
        return { kind: "agent", name: name.trim() };
    }
    if (kind === FileFilterByAgent || kind === FileFilterByCommand) {
        return { kind: "command" };
    }
    return { kind: "user" };
}

// null when the panel has no filter.
export function readFileFilter(meta: MetaType): FileFilter {
    const m = metaRecord(meta);
    const pattern = m[FileFilterMetaKey];
    if (typeof pattern !== "string" || pattern === "") {
        return null;
    }
    return {
        pattern,
        recursive: m[FileFilterRecursiveMetaKey] === true,
        dir: typeof m[FileFilterDirMetaKey] === "string" ? m[FileFilterDirMetaKey] : "",
        by: filterBy(m),
    };
}

function filterKey(filter: FileFilter): string {
    if (filter == null) {
        return "";
    }
    const by = filter.by.kind === "agent" ? `agent:${filter.by.name}` : filter.by.kind;
    return [filter.pattern, filter.recursive ? "r" : "", filter.dir, by].join("\u0000");
}

export function clearFileFilterMeta(): MetaType {
    const rtn: Record<string, any> = {};
    for (const key of FilterKeys) {
        rtn[key] = null;
    }
    return rtn as MetaType;
}

// The developer's own filter: no one else's name on it.
export function userFileFilterMeta(dir: string, pattern: string, recursive: boolean): MetaType {
    if (pattern === "") {
        return clearFileFilterMeta();
    }
    return {
        [FileFilterMetaKey]: pattern,
        [FileFilterRecursiveMetaKey]: recursive ? true : null,
        [FileFilterDirMetaKey]: dir,
        [FileFilterByMetaKey]: null,
        [FileFilterByNameMetaKey]: null,
    } as MetaType;
}

// What Stay adds after `molten files` asked for a folder outside the project: the filter the panel had before.
export function fileFilterStayMeta(meta: MetaType): MetaType {
    const prev = metaRecord(meta)[FileFilterPrevMetaKey];
    if (prev == null || typeof prev !== "object") {
        return {};
    }
    const rtn: Record<string, any> = { [FileFilterPrevMetaKey]: null };
    for (const key of FilterKeys) {
        rtn[key] = prev[key] ?? null;
    }
    return rtn as MetaType;
}

export function readShowHidden(meta: MetaType, setting: boolean): boolean {
    const value = metaRecord(meta)[FileShowHiddenMetaKey];
    if (typeof value === "boolean") {
        return value;
    }
    return setting ?? true;
}

export function isGlobPattern(pattern: string): boolean {
    return /[*?[]/.test(pattern ?? "");
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

// globToRegExp follows Go's path.Match, which wavesrv uses: * and ? never match "/", [...] holds characters and
// ranges (negated by ^), \ escapes the next character. A malformed glob gives null and matches nothing.
export function globToRegExp(pattern: string): RegExp {
    let out = "^";
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === "*") {
            out += "[^/]*";
            i++;
            continue;
        }
        if (c === "?") {
            out += "[^/]";
            i++;
            continue;
        }
        if (c === "\\") {
            if (i + 1 >= pattern.length) {
                return null;
            }
            out += escapeRegExp(pattern[i + 1]);
            i += 2;
            continue;
        }
        if (c !== "[") {
            out += escapeRegExp(c);
            i++;
            continue;
        }
        i++;
        let cls = "";
        if (pattern[i] === "^") {
            cls += "^";
            i++;
        }
        let closed = false;
        let first = true;
        while (i < pattern.length) {
            if (pattern[i] === "]" && !first) {
                closed = true;
                i++;
                break;
            }
            first = false;
            let lo = pattern[i];
            if (lo === "\\") {
                i++;
                if (i >= pattern.length) {
                    return null;
                }
                lo = pattern[i];
            }
            i++;
            if (pattern[i] === "-" && i + 1 < pattern.length && pattern[i + 1] !== "]") {
                i++;
                let hi = pattern[i];
                if (hi === "\\") {
                    i++;
                    if (i >= pattern.length) {
                        return null;
                    }
                    hi = pattern[i];
                }
                i++;
                if (hi < lo) {
                    return null;
                }
                cls += `${escapeRegExp(lo)}-${escapeRegExp(hi)}`;
                continue;
            }
            cls += escapeRegExp(lo);
        }
        if (!closed || cls === "" || cls === "^") {
            return null;
        }
        out += `[${cls}]`;
        if (cls.startsWith("^")) {
            out = out.slice(0, -1) + "/]";
        }
    }
    return new RegExp(out + "$", "s");
}

// A case-insensitive substring, or a glob on the whole name when the pattern holds *, ? or [ (as wavesrv matches).
export function matchFileName(name: string, pattern: string): boolean {
    if (!pattern) {
        return true;
    }
    const lname = (name ?? "").toLowerCase();
    const lpattern = pattern.toLowerCase();
    if (!isGlobPattern(pattern)) {
        return lname.includes(lpattern);
    }
    const re = globToRegExp(lpattern);
    return re != null && re.test(lname);
}

// The chip's text: who set the filter, or null for the developer's own.
export function fileFilterSetBy(t: (key: string, vars?: Record<string, any>) => string, filter: FileFilter): string {
    if (filter == null || filter.by.kind === "user") {
        return null;
    }
    if (filter.by.kind === "agent") {
        return t("fileFilter.setByAgent", { name: filter.by.name });
    }
    return t("fileFilter.setByTerminal");
}

export async function searchFiles(
    folder: string,
    pattern: string,
    recursive: boolean,
    showHidden: boolean
): Promise<FileSearchResult> {
    const rtn: FileSearchResult = await TabRpcClient.wshRpcCall(
        FileSearchCommand,
        { folder, pattern, recursive, showhidden: showHidden },
        { route: FileSearchRoute, timeout: SearchTimeoutMs }
    );
    return { matches: rtn?.matches ?? [], truncated: rtn?.truncated ?? false };
}

function trimSlashes(path: string): string {
    return path.length > 1 ? path.replace(/[/\\]+$/, "") : path;
}

// A listing names a folder below the home folder with ~ (wshremote's ReplaceHomeDir); the meta may hold it in full.
export function samePath(listed: string, meta: string): boolean {
    if (listed == null || meta == null) {
        return false;
    }
    const a = trimSlashes(listed);
    const b = trimSlashes(meta);
    if (a === b) {
        return true;
    }
    if (a.startsWith("~")) {
        return b.endsWith(a.slice(1));
    }
    if (b.startsWith("~")) {
        return a.endsWith(b.slice(1));
    }
    return false;
}

type Draft = { pattern: string; recursive: boolean; dir: string; base: string };

export type FileFilterDeps = {
    blockAtom: Atom<Block>;
    shownPathAtom: Atom<string>;
    rawPathAtom: Atom<string>;
    showHiddenSettingAtom: Atom<boolean>;
    writeMeta: (meta: MetaType) => Promise<unknown>;
    isFocusedAtom?: Atom<boolean>;
    now?: () => number;
};

export class FileFilterModel {
    deps: FileFilterDeps;
    // The developer's typing, shown at once while its meta write travels (keys typed fast are never lost).
    draftAtom = atom(null) as PrimitiveAtom<Draft>;
    // The panel's filter, whatever folder it applies to.
    filterAtom: Atom<FileFilter>;
    // The filter of the folder the panel shows, or null.
    activeAtom: Atom<FileFilter>;
    showHiddenAtom: PrimitiveAtom<boolean>;
    unsubs: (() => void)[] = [];

    constructor(deps: FileFilterDeps) {
        this.deps = deps;
        this.filterAtom = atom((get) => {
            const draft = get(this.draftAtom);
            if (draft != null) {
                return draft.pattern === ""
                    ? null
                    : { pattern: draft.pattern, recursive: draft.recursive, dir: draft.dir, by: { kind: "user" } };
            }
            return readFileFilter(get(deps.blockAtom)?.meta);
        });
        this.activeAtom = atom((get) => {
            const filter = get(this.filterAtom);
            const shown = get(deps.shownPathAtom);
            if (filter == null || shown == null || filter.dir !== shown) {
                return null;
            }
            return filter;
        });
        this.showHiddenAtom = atom(
            (get) => readShowHidden(get(deps.blockAtom)?.meta, get(deps.showHiddenSettingAtom)),
            (get, _set, update: SetStateAction<boolean>) => {
                const current = readShowHidden(get(deps.blockAtom)?.meta, get(deps.showHiddenSettingAtom));
                const next = typeof update === "function" ? update(current) : update;
                fireAndForget(() => deps.writeMeta({ [FileShowHiddenMetaKey]: next } as MetaType));
            }
        ) as PrimitiveAtom<boolean>;
    }

    start() {
        if (this.unsubs.length > 0) {
            return;
        }
        this.unsubs.push(globalStore.sub(this.deps.blockAtom, () => this.syncDraft()));
        const focused = this.deps.isFocusedAtom;
        if (focused != null) {
            this.unsubs.push(
                globalStore.sub(focused, () => {
                    if (globalStore.get(focused)) {
                        this.markFocused();
                    }
                })
            );
        }
    }

    dispose() {
        for (const unsub of this.unsubs) {
            unsub();
        }
        this.unsubs = [];
    }

    // `molten files` reuses the panel focused last (FR-FILE-002 AC-1).
    markFocused() {
        const now = this.deps.now?.() ?? Date.now();
        fireAndForget(() => this.deps.writeMeta({ [FileFocusedTsMetaKey]: now } as MetaType));
    }

    // The draft ends when the meta caught up with it, or when someone else set a filter since.
    syncDraft() {
        const draft = globalStore.get(this.draftAtom);
        if (draft == null) {
            return;
        }
        const meta = readFileFilter(globalStore.get(this.deps.blockAtom)?.meta);
        const key = filterKey(meta);
        if (key === draft.base) {
            return;
        }
        const mine = meta == null || meta.by.kind === "user";
        if (mine && (meta?.pattern ?? "") !== draft.pattern) {
            globalStore.set(this.draftAtom, { ...draft, base: key });
            return;
        }
        globalStore.set(this.draftAtom, null);
    }

    // The developer edits the filter: it becomes theirs (the chip goes), on the folder shown. "" clears it.
    setPattern(pattern: string) {
        if (pattern === "" && globalStore.get(this.filterAtom) == null) {
            return;
        }
        const shown = globalStore.get(this.deps.shownPathAtom) ?? globalStore.get(this.deps.rawPathAtom);
        const active = globalStore.get(this.activeAtom);
        const recursive = pattern !== "" && (active?.recursive ?? false);
        const base = filterKey(readFileFilter(globalStore.get(this.deps.blockAtom)?.meta));
        globalStore.set(this.draftAtom, { pattern, recursive, dir: shown, base });
        fireAndForget(() => this.deps.writeMeta(userFileFilterMeta(shown, pattern, recursive)));
    }

    clear() {
        this.setPattern("");
    }

    // Showing another folder clears the filter (AC-6): the panel lists a folder (raw is shown, no question waiting)
    // that is not the filter's. A file opened from the list keeps it, so Back finds the same list: listed is the stat
    // of what the directory view lists, which still names the folder while the panel moves on to the file.
    clearIfAnotherFolder(listed: FileInfo) {
        const filter = globalStore.get(this.filterAtom);
        const raw = globalStore.get(this.deps.rawPathAtom);
        const shown = globalStore.get(this.deps.shownPathAtom);
        if (filter == null || shown == null || raw !== shown || raw === filter.dir) {
            return;
        }
        if (!listed?.isdir || !samePath(listed.path, shown)) {
            return;
        }
        globalStore.set(this.draftAtom, null);
        fireAndForget(() => this.deps.writeMeta(clearFileFilterMeta()));
    }
}
