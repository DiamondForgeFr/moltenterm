// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A file panel of a workspace linked to a project stays inside the project folder (FR-FILE-001, DS-FILE-001). One
// gate sits where the panel's model applies a new file meta, so every route goes through it: the parent folder, the
// path field, the bookmarks, history, a drop, and an agent's wsh view or wsh setmeta. A path outside the project is
// not shown until the user answers the question in the panel; one approval lets the panel go anywhere until it shows
// something inside the project again. wavesrv resolves the paths (pkg/molten/fileconfine) and guarantees the meta the
// gate trusts: only a window writes the approval, and a terminal's write says who asked.

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget, isBlank } from "@/util/util";
import { atom, Atom, Getter, PrimitiveAtom } from "jotai";
import { I18nModel, t } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import {
    checkPathInside,
    effectiveWorkspaceFolder,
    pathBaseName,
    pathParent,
    readWorkspaceProject,
} from "../workspace-project";

// must match pkg/molten/fileconfine/fileconfine.go
export const FileApprovedMetaKey = "molten:fileapproved";
export const FileOriginMetaKey = "molten:fileorigin";
export const FileOriginNameMetaKey = "molten:fileoriginname";
export const FileOriginAgent = "agent";
export const FileOriginCommand = "command";
export const FileConfineRoute = "molten:fileconfine";
export const FileConfineCheckCommand = "moltenfilecheck";

const CheckTimeoutMs = 10000;

// must match CheckResult in pkg/molten/fileconfine/fileconfine.go
export type FileCheckResult = {
    inside: boolean;
    path?: string;
    project?: string;
    isdir?: boolean;
    error?: string;
};

export type FileConfineScope = { root: string; name: string };

export type FileAskOrigin = { kind: "user" } | { kind: "agent"; name: string } | { kind: "command" };

export type FileConfinePending = {
    // The path as it was asked for, and as wavesrv resolved it.
    target: string;
    resolved: string;
    isDir: boolean;
    origin: FileAskOrigin;
    root: string;
    projectName: string;
    // The user's navigation, not written yet: Open writes it with the approval, Stay drops it.
    apply: MetaType;
    // The path a write from elsewhere replaced: Stay writes it back (the workspace folder for a panel being opened).
    restore: string;
};

// The project's connection is this computer: a panel on another connection (SSH, WSL) is never confined.
export function isLocalConnection(conn: string): boolean {
    return isBlank(conn) || conn === "local" || conn.startsWith("local:");
}

export function fileConfineScope(ws: Workspace, connection: string): FileConfineScope {
    const root = readWorkspaceProject(ws).dir;
    if (root === "" || !isLocalConnection(connection)) {
        return null;
    }
    return { root, name: pathBaseName(root) || root };
}

export function fileAskOrigin(meta: MetaType): FileAskOrigin {
    const kind = (meta as Record<string, any>)?.[FileOriginMetaKey];
    const name = (meta as Record<string, any>)?.[FileOriginNameMetaKey];
    if (kind === FileOriginAgent && typeof name === "string" && name.trim() !== "") {
        return { kind: "agent", name: name.trim() };
    }
    if (kind === FileOriginAgent || kind === FileOriginCommand) {
        return { kind: "command" };
    }
    return { kind: "user" };
}

export function approvedRoot(meta: MetaType): string {
    const value = (meta as Record<string, any>)?.[FileApprovedMetaKey];
    return typeof value === "string" ? value : "";
}

// The folder the question names: the target itself, or the folder of a file.
export function pendingFolder(pending: FileConfinePending): string {
    const path = pending.resolved || pending.target;
    return pending.isDir ? path : pathParent(path) || path;
}

// What Stay writes after a write from elsewhere moved the panel's meta: the path it showed, taken back out of the
// history when the write pushed it there.
export function stayMeta(meta: MetaType, restore: string): MetaType {
    const rtn: MetaType = { file: restore, [FileOriginMetaKey]: null, [FileOriginNameMetaKey]: null } as MetaType;
    const history = (meta?.history ?? []) as string[];
    if (history.length > 0 && history[history.length - 1] === restore) {
        rtn.history = history.slice(0, -1);
    }
    return rtn;
}

export async function checkFilePath(path: string, project: string): Promise<FileCheckResult> {
    try {
        const rtn: FileCheckResult = await TabRpcClient.wshRpcCall(
            FileConfineCheckCommand,
            { path, project },
            { route: FileConfineRoute, timeout: CheckTimeoutMs }
        );
        return rtn ?? { inside: false, error: "no answer" };
    } catch (e) {
        // wavesrv cannot be asked: compare the text, which still catches every path written outside the project.
        console.log("file confinement: check failed, comparing the paths as written", e);
        return { inside: checkPathInside(path, project), error: `${e}` };
    }
}

// The file panel's fixed bookmarks; a confined panel lists its project's root first (AC-9).
// TODO drive this using config
export const FileBookmarks: { labelKey: string; path: string }[] = [
    { labelKey: "fileConfine.bookmarkHome", path: "~" },
    { labelKey: "fileConfine.bookmarkDesktop", path: "~/Desktop" },
    { labelKey: "fileConfine.bookmarkDownloads", path: "~/Downloads" },
    { labelKey: "fileConfine.bookmarkDocuments", path: "~/Documents" },
    { labelKey: "fileConfine.bookmarkRoot", path: "/" },
];

export function fileBookmarkMenu(scope: FileConfineScope, go: (path: string) => void): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (scope != null) {
        items.push({
            label: t("fileConfine.goTo", { name: scope.name, path: scope.root }),
            click: () => go(scope.root),
        });
        items.push({ type: "separator" });
    }
    for (const bookmark of FileBookmarks) {
        items.push({
            label: t("fileConfine.goTo", { name: t(bookmark.labelKey), path: bookmark.path }),
            click: () => go(bookmark.path),
        });
    }
    return items;
}

// The header's calm marker and its way back while the panel shows something outside its project (AC-6, AC-11).
export function fileConfineHeaderElems(get: Getter, gate: FileConfineGate, onBack: () => void): HeaderElem[] {
    const scope = get(gate.scopeAtom);
    if (scope == null || !get(gate.outsideAtom)) {
        return [];
    }
    const locale = get(I18nModel.getInstance().localeAtom);
    return [
        {
            elemtype: "pill",
            text: translate(locale, "fileConfine.outsideMarker"),
            tone: "neutral",
            icon: "arrow-right-from-bracket",
            title: translate(locale, "fileConfine.outsideMarkerTitle", { project: scope.name }),
        },
        {
            elemtype: "textbutton",
            text: translate(locale, "fileConfine.backToProject"),
            className: "grey rounded-4 !py-[2px] !px-[10px] !text-11 font-[500]",
            onClick: onBack,
        },
    ];
}

export type FileConfineDeps = {
    blockAtom: Atom<Block>;
    workspaceAtom: Atom<Workspace>;
    writeMeta: (meta: MetaType) => Promise<unknown>;
    check?: (path: string, project: string) => Promise<FileCheckResult>;
    // A navigation the user approved was written (what navigate's true means for one that had to ask).
    onApplied?: () => void;
};

// A panel without a path of its own shows the home folder, or the workspace folder once confined (AC-1): wavesrv gives
// new panels that folder, and a panel created before the project was linked (the starter layout's) follows it.
export function rawFilePath(block: Block, ws: Workspace, scope: FileConfineScope): string {
    const file = block?.meta?.file;
    if (!isBlank(file)) {
        return file;
    }
    if (scope == null) {
        return "~";
    }
    return effectiveWorkspaceFolder(ws) || scope.root;
}

const ClearOrigin = { [FileOriginMetaKey]: null, [FileOriginNameMetaKey]: null };

export class FileConfineGate {
    deps: FileConfineDeps;
    check: (path: string, project: string) => Promise<FileCheckResult>;
    // null when the panel is not confined (no project, another connection): it then shows its meta as is.
    scopeAtom: Atom<FileConfineScope>;
    rawPathAtom: Atom<string>;
    // What the panel shows: null until the first check answers.
    shownPathAtom = atom(null) as PrimitiveAtom<string>;
    pendingAtom = atom(null) as PrimitiveAtom<FileConfinePending>;
    outsideAtom = atom(false) as PrimitiveAtom<boolean>;
    triggerAtom: Atom<string>;
    seq = 0;
    lastCheck: { path: string; project: string; result: FileCheckResult } = null;
    unsub: () => void = null;

    constructor(deps: FileConfineDeps) {
        this.deps = deps;
        this.check = deps.check ?? checkFilePath;
        this.scopeAtom = atom((get) => {
            const block = get(deps.blockAtom);
            return fileConfineScope(get(deps.workspaceAtom), block?.meta?.connection);
        });
        this.rawPathAtom = atom((get) =>
            rawFilePath(get(deps.blockAtom), get(deps.workspaceAtom), get(this.scopeAtom))
        );
        this.triggerAtom = atom((get) => {
            const scope = get(this.scopeAtom);
            const meta = get(deps.blockAtom)?.meta;
            return [get(this.rawPathAtom), scope?.root ?? "", approvedRoot(meta)].join("\u0000");
        });
    }

    start() {
        if (this.unsub != null) {
            return;
        }
        this.unsub = globalStore.sub(this.triggerAtom, () => fireAndForget(() => this.evaluate()));
        fireAndForget(() => this.evaluate());
    }

    dispose() {
        this.unsub?.();
        this.unsub = null;
        this.seq++;
    }

    blockMeta(): MetaType {
        return globalStore.get(this.deps.blockAtom)?.meta ?? {};
    }

    // A navigation's own answer serves the check its write triggers, once.
    async checkPath(path: string, project: string): Promise<FileCheckResult> {
        const last = this.lastCheck;
        this.lastCheck = null;
        if (last != null && last.path === path && last.project === project) {
            return last.result;
        }
        return this.check(path, project);
    }

    // Applies the panel's file meta, whoever wrote it. Never moves a panel because the project changed (AC-11): the
    // marker follows, the next navigation asks.
    async evaluate() {
        const seq = ++this.seq;
        const scope = globalStore.get(this.scopeAtom);
        const raw = globalStore.get(this.rawPathAtom);
        if (scope == null) {
            globalStore.set(this.shownPathAtom, raw);
            globalStore.set(this.outsideAtom, false);
            globalStore.set(this.pendingAtom, null);
            return;
        }
        const pending = globalStore.get(this.pendingAtom);
        if (pending != null && pending.apply == null && pending.target === raw && pending.root === scope.root) {
            return;
        }
        const result = await this.checkPath(raw, scope.root);
        if (seq !== this.seq) {
            return;
        }
        const meta = this.blockMeta();
        const approval = approvedRoot(meta);
        const shown = globalStore.get(this.shownPathAtom);
        if (raw === shown || result.inside || approval === scope.root) {
            if (raw !== shown) {
                globalStore.set(this.shownPathAtom, raw);
                const current = globalStore.get(this.pendingAtom);
                if (current != null && current.apply == null) {
                    globalStore.set(this.pendingAtom, null);
                }
            }
            globalStore.set(this.outsideAtom, !result.inside);
            if (result.inside && approval !== "") {
                await this.deps.writeMeta({ [FileApprovedMetaKey]: null } as MetaType);
            }
            return;
        }
        globalStore.set(this.pendingAtom, {
            target: raw,
            resolved: result.path ?? "",
            isDir: result.isdir ?? false,
            origin: fileAskOrigin(meta),
            root: scope.root,
            projectName: scope.name,
            apply: null,
            restore: shown ?? (effectiveWorkspaceFolder(globalStore.get(this.deps.workspaceAtom)) || scope.root),
        });
    }

    // The user moves the panel (parent, path field, bookmarks, Back and Forward): asked before anything is written,
    // so Stay leaves the panel, its history included, exactly as it was.
    // Returns whether update was written; false while the question waits (Open writes it later, see onApplied).
    async navigate(update: MetaType): Promise<boolean> {
        const scope = globalStore.get(this.scopeAtom);
        const target = update?.file;
        const write = { ...update, ...ClearOrigin } as MetaType;
        if (scope == null || isBlank(target)) {
            await this.deps.writeMeta(write);
            return true;
        }
        const result = await this.check(target, scope.root);
        const approval = approvedRoot(this.blockMeta());
        if (result.inside || approval === scope.root) {
            if (result.inside && approval !== "") {
                (write as Record<string, any>)[FileApprovedMetaKey] = null;
            }
            this.lastCheck = { path: target, project: scope.root, result };
            await this.deps.writeMeta(write);
            return true;
        }
        globalStore.set(this.pendingAtom, {
            target,
            resolved: result.path ?? "",
            isDir: result.isdir ?? false,
            origin: { kind: "user" },
            root: scope.root,
            projectName: scope.name,
            apply: write,
            restore: null,
        });
        return false;
    }

    async openOutside() {
        const pending = globalStore.get(this.pendingAtom);
        if (pending == null) {
            return;
        }
        globalStore.set(this.pendingAtom, null);
        const approval = { [FileApprovedMetaKey]: pending.root } as MetaType;
        if (pending.apply == null) {
            await this.deps.writeMeta(approval);
            return;
        }
        await this.deps.writeMeta({ ...pending.apply, ...approval });
        this.deps.onApplied?.();
    }

    async stay() {
        const pending = globalStore.get(this.pendingAtom);
        if (pending == null) {
            return;
        }
        globalStore.set(this.pendingAtom, null);
        if (pending.apply != null) {
            return;
        }
        await this.deps.writeMeta(stayMeta(this.blockMeta(), pending.restore));
    }
}
