// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Copy file (FR-FILE-005, DS-FILE-011): a file panel puts the file it shows, or a file of its folder listing, on the
// system clipboard, to paste it in a chat, a mail or a folder. The main process does the copy
// (emain/moltenterm-file-clipboard.ts); this model decides where the action is offered and shows the answer in place:
// the header button's check, and a pill next to the file name, which a narrow header that folded the button still shows.

import { globalStore } from "@/app/store/jotaiStore";
import { CopyFileResult, platformCopiesFiles } from "@/util/moltenterm-file-clipboard";
import { fireAndForget, isLocalConnName } from "@/util/util";
import { atom, Getter, PrimitiveAtom } from "jotai";
import { I18nModel, t } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";

export const FileCopyFeedbackMs = 2000;

export type FileCopyState = "idle" | "copied" | "copiedsaved" | "failed";

export type FileCopyDeps = {
    copy: (path: string) => Promise<CopyFileResult>;
    platform: () => string;
    // The editor holds changes that are not saved: the copy is the file on disk, which does not have them.
    hasUnsaved: () => boolean;
};

// The absolute path of the file to copy, or null where Copy file is not offered: a platform that cannot carry a file,
// another connection than this computer, no file shown (loading, error), a folder or a file that does not exist.
export function copyableFilePath(platform: string, conn: string, finfo: FileInfo): string {
    if (!platformCopiesFiles(platform) || !isLocalConnName(conn) || finfo == null) {
        return null;
    }
    if (finfo.notfound || finfo.isdir || finfo.mimetype === "directory") {
        return null;
    }
    return finfo.path?.startsWith("/") ? finfo.path : null;
}

export class FileCopyModel {
    stateAtom = atom<FileCopyState>("idle") as PrimitiveAtom<FileCopyState>;
    deps: FileCopyDeps;
    timer: ReturnType<typeof setTimeout> = null;

    constructor(deps: FileCopyDeps) {
        this.deps = deps;
    }

    dispose() {
        clearTimeout(this.timer);
        this.timer = null;
    }

    show(state: FileCopyState) {
        clearTimeout(this.timer);
        globalStore.set(this.stateAtom, state);
        this.timer = setTimeout(() => {
            this.timer = null;
            globalStore.set(this.stateAtom, "idle");
        }, FileCopyFeedbackMs);
    }

    async copy(conn: string, finfo: FileInfo): Promise<void> {
        const path = copyableFilePath(this.deps.platform(), conn, finfo);
        if (path == null) {
            return;
        }
        const unsaved = this.deps.hasUnsaved();
        let result: CopyFileResult = "failed";
        try {
            result = await this.deps.copy(path);
        } catch (e) {
            console.error("Copy file failed:", e);
        }
        if (result !== "copied") {
            this.show("failed");
            return;
        }
        this.show(unsaved ? "copiedsaved" : "copied");
    }

    // The header button, or null where the action is not offered. The state shows in the button itself.
    headerButton(get: Getter, conn: string, finfo: FileInfo, click: () => void): IconButtonDecl {
        if (copyableFilePath(this.deps.platform(), conn, finfo) == null) {
            return null;
        }
        const locale = get(I18nModel.getInstance().localeAtom);
        const state = get(this.stateAtom);
        if (state === "idle") {
            return { elemtype: "iconbutton", icon: "copy", title: translate(locale, "wave.files.copyFile"), click };
        }
        if (state === "failed") {
            return {
                elemtype: "iconbutton",
                icon: "triangle-exclamation",
                iconColor: "var(--error-color)",
                title: translate(locale, "wave.files.copyFileFailed"),
                click,
            };
        }
        const key = state === "copiedsaved" ? "wave.files.fileCopiedSaved" : "wave.files.fileCopied";
        return {
            elemtype: "iconbutton",
            icon: "check",
            iconColor: "var(--success-color)",
            title: translate(locale, key),
            click,
        };
    }

    // The answer next to the file name, for the copies the button cannot carry: from the listing of a folder, with
    // unsaved changes (the note matters), failed, or from a folded header.
    pill(get: Getter): HeaderElem {
        const state = get(this.stateAtom);
        if (state === "idle") {
            return null;
        }
        const locale = get(I18nModel.getInstance().localeAtom);
        if (state === "failed") {
            return {
                elemtype: "pill",
                text: translate(locale, "wave.files.copyFileFailed"),
                tone: "danger",
                icon: "triangle-exclamation",
            };
        }
        const saved = state === "copiedsaved";
        return {
            elemtype: "pill",
            text: translate(locale, saved ? "wave.files.fileCopiedSaved" : "wave.files.fileCopied"),
            tone: saved ? "warning" : "neutral",
            icon: "check",
        };
    }

    // The menu entries (none, or one) for a file panel's menu and a folder listing's file menu. Where the platform
    // carries a file but this file cannot be copied, the entry is disabled and says why.
    menuItems(conn: string, finfo: FileInfo): ContextMenuItem[] {
        if (!platformCopiesFiles(this.deps.platform())) {
            return [];
        }
        const label = t("wave.files.copyFile");
        if (copyableFilePath(this.deps.platform(), conn, finfo) == null) {
            return [{ label, enabled: false, sublabel: t("wave.files.copyFileLocalOnly") }];
        }
        return [{ label, click: () => fireAndForget(() => this.copy(conn, finfo)) }];
    }
}
