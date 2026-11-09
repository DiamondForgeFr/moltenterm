// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import { copyableFilePath, FileCopyDeps, FileCopyFeedbackMs, FileCopyModel } from "./file-copy";

const File = { path: "/work/notes.md", dir: "/work", name: "notes.md", mimetype: "text/markdown" } as FileInfo;
const Folder = { path: "/work", dir: "/", name: "work", mimetype: "directory", isdir: true } as FileInfo;

function text(key: string): string {
    return translate(globalStore.get(I18nModel.getInstance().localeAtom), key);
}

type Fixture = { model: FileCopyModel; copy: ReturnType<typeof vi.fn>; deps: FileCopyDeps; unsaved: { value: boolean } };

function fixture(platform = "darwin", result: string | Error = "copied"): Fixture {
    const unsaved = { value: false };
    const copy = vi.fn(async (_path: string) => {
        if (result instanceof Error) {
            throw result;
        }
        return result;
    });
    const deps = { copy, platform: () => platform, hasUnsaved: () => unsaved.value } as FileCopyDeps;
    return { model: new FileCopyModel(deps), copy, deps, unsaved };
}

describe("copyableFilePath", () => {
    it("offers a file of this computer on macOS and Linux", () => {
        for (const conn of [undefined, "", "local", "local:default"]) {
            expect(copyableFilePath("darwin", conn, File), String(conn)).toBe("/work/notes.md");
        }
        expect(copyableFilePath("linux", "", File)).toBe("/work/notes.md");
    });

    it("offers nothing for a platform that cannot carry a file", () => {
        expect(copyableFilePath("win32", "", File)).toBeNull();
        expect(copyableFilePath("freebsd", "", File)).toBeNull();
    });

    it("offers nothing for a remote connection", () => {
        expect(copyableFilePath("darwin", "user@host", File)).toBeNull();
        expect(copyableFilePath("darwin", "wsl://Ubuntu", File)).toBeNull();
    });

    it("offers nothing where no file is shown: loading, error, a missing file, a folder", () => {
        expect(copyableFilePath("darwin", "", null)).toBeNull();
        expect(copyableFilePath("darwin", "", { ...File, notfound: true } as FileInfo)).toBeNull();
        expect(copyableFilePath("darwin", "", { ...File, isdir: true } as FileInfo)).toBeNull();
        expect(copyableFilePath("darwin", "", Folder)).toBeNull();
        expect(copyableFilePath("darwin", "", { ...Folder, isdir: false } as FileInfo)).toBeNull();
    });

    it("offers nothing for a path that is not absolute", () => {
        expect(copyableFilePath("darwin", "", { ...File, path: "~/notes.md" } as FileInfo)).toBeNull();
        expect(copyableFilePath("darwin", "", { ...File, path: "notes.md" } as FileInfo)).toBeNull();
        expect(copyableFilePath("darwin", "", { ...File, path: undefined } as FileInfo)).toBeNull();
    });
});

describe("FileCopyModel", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("copies the shown file by its path and confirms in the button and the pill", async () => {
        const { model, copy } = fixture();
        const get = globalStore.get;
        expect(model.headerButton(get, "", File, () => {})).toMatchObject({ icon: "copy", title: text("wave.files.copyFile") });
        expect(model.pill(get)).toBeNull();

        await model.copy("", File);

        expect(copy).toHaveBeenCalledExactlyOnceWith("/work/notes.md");
        expect(model.headerButton(get, "", File, () => {})).toMatchObject({
            icon: "check",
            title: text("wave.files.fileCopied"),
        });
        expect(model.pill(get)).toMatchObject({ elemtype: "pill", text: text("wave.files.fileCopied"), tone: "neutral" });
    });

    it("goes back to the plain button once the confirmation is over", async () => {
        const { model } = fixture();
        await model.copy("", File);
        vi.advanceTimersByTime(FileCopyFeedbackMs - 1);
        expect(globalStore.get(model.stateAtom)).toBe("copied");
        vi.advanceTimersByTime(1);
        expect(globalStore.get(model.stateAtom)).toBe("idle");
        expect(model.headerButton(globalStore.get, "", File, () => {})).toMatchObject({ icon: "copy" });
        expect(model.pill(globalStore.get)).toBeNull();
    });

    it("restarts the confirmation when the file is copied again", async () => {
        const { model } = fixture();
        await model.copy("", File);
        vi.advanceTimersByTime(FileCopyFeedbackMs - 1);
        await model.copy("", File);
        vi.advanceTimersByTime(FileCopyFeedbackMs - 1);
        expect(globalStore.get(model.stateAtom)).toBe("copied");
        vi.advanceTimersByTime(1);
        expect(globalStore.get(model.stateAtom)).toBe("idle");
    });

    it("says the saved version was copied when the editor holds unsaved changes", async () => {
        const { model, unsaved } = fixture();
        unsaved.value = true;
        await model.copy("", File);
        expect(model.headerButton(globalStore.get, "", File, () => {})).toMatchObject({
            icon: "check",
            title: text("wave.files.fileCopiedSaved"),
        });
        expect(model.pill(globalStore.get)).toMatchObject({ text: text("wave.files.fileCopiedSaved"), tone: "warning" });
    });

    it("says so in place when the copy fails, whether the answer is a code or an error", async () => {
        for (const result of ["failed", "invalid", "unsupported", new Error("channel closed")] as const) {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const { model } = fixture("darwin", result);
            await model.copy("", File);
            expect(model.headerButton(globalStore.get, "", File, () => {})).toMatchObject({
                icon: "triangle-exclamation",
                title: text("wave.files.copyFileFailed"),
            });
            expect(model.pill(globalStore.get)).toMatchObject({ tone: "danger", text: text("wave.files.copyFileFailed") });
            model.dispose();
            vi.restoreAllMocks();
        }
    });

    it("asks nothing of the main process where the action is not offered", async () => {
        for (const [platform, conn, finfo] of [
            ["darwin", "", Folder],
            ["darwin", "user@host", File],
            ["darwin", "", null],
            ["win32", "", File],
        ] as const) {
            const { model, copy } = fixture(platform);
            await model.copy(conn, finfo);
            expect(copy).not.toHaveBeenCalled();
            expect(globalStore.get(model.stateAtom)).toBe("idle");
            expect(model.headerButton(globalStore.get, conn, finfo, () => {})).toBeNull();
        }
    });

    it("runs the click it is given from the header button", () => {
        const { model } = fixture();
        const click = vi.fn();
        model.headerButton(globalStore.get, "", File, click).click(null);
        expect(click).toHaveBeenCalledTimes(1);
    });

    it("stops its timer when the panel goes", async () => {
        const { model } = fixture();
        await model.copy("", File);
        model.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("FileCopyModel menu entries", () => {
    it("lists Copy file for a file, and copies it when it is chosen", async () => {
        const { model, copy } = fixture();
        const items = model.menuItems("", File);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ label: text("wave.files.copyFile") });
        expect(items[0].enabled).not.toBe(false);
        items[0].click();
        await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith("/work/notes.md"));
    });

    it("disables the entry and says why for a folder, a remote file and a panel without a file", () => {
        const { model, copy } = fixture();
        for (const [conn, finfo] of [
            ["", Folder],
            ["user@host", File],
            ["", null],
            ["", { ...File, notfound: true } as FileInfo],
        ] as const) {
            const items = model.menuItems(conn, finfo);
            expect(items).toEqual([
                { label: text("wave.files.copyFile"), enabled: false, sublabel: text("wave.files.copyFileLocalOnly") },
            ]);
        }
        expect(copy).not.toHaveBeenCalled();
    });

    it("has no entry at all where the platform cannot carry a file", () => {
        const { model } = fixture("win32");
        expect(model.menuItems("", File)).toEqual([]);
        expect(model.menuItems("", Folder)).toEqual([]);
    });
});
