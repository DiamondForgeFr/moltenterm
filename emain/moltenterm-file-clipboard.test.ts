// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    register: null as any,
    write: vi.fn(async (_items: any[]) => {}),
}));
vi.mock("electron", () => ({
    ipcMain: {},
    clipboard: { write: mocks.write },
    ClipboardItem: class {
        items: Record<string, string>;
        constructor(items: Record<string, string>) {
            this.items = items;
        }
    },
}));
vi.mock("./moltenterm-privileged-ipc", async (original) => ({
    ...(await original<typeof import("./moltenterm-privileged-ipc")>()),
    handleAppIpc: (...args: any[]) => mocks.register(...args),
}));

import {
    checkedFilePath,
    copyFileToClipboard,
    FileClipboardDeps,
    fileRepresentations,
    initFileClipboardIpc,
    isRegularFile,
} from "./moltenterm-file-clipboard";
import { createPrivilegedIpc, IpcDeniedMessage } from "./moltenterm-privileged-ipc";

const UriList = "text/uri-list";
const GnomeCopiedFiles = 'electron application/osclipboard;format="x-special/gnome-copied-files"';
const IsPosix = process.platform !== "win32";
const HostCopiesFiles = process.platform === "darwin" || process.platform === "linux";

function makeDeps(platform: string, overrides: Partial<FileClipboardDeps> = {}) {
    const deps = {
        platform,
        isRegularFile: vi.fn(async (_filePath: string) => true),
        write: vi.fn(async (_representations: Record<string, string>) => {}),
        ...overrides,
    };
    return deps;
}

describe("checkedFilePath", () => {
    it("accepts an absolute path and cleans it", () => {
        expect(checkedFilePath("/tmp/a.txt")).toBe("/tmp/a.txt");
        expect(checkedFilePath("/tmp/x/../a.txt")).toBe("/tmp/a.txt");
        expect(checkedFilePath("/tmp/it's a file; $(x) `y`.txt")).toBe("/tmp/it's a file; $(x) `y`.txt");
    });

    it("refuses what is not an absolute path", () => {
        for (const value of [undefined, null, 42, {}, ["/tmp/a.txt"], "", "a.txt", "./a.txt", "~/a.txt", "~", "a\0b"]) {
            expect(checkedFilePath(value), String(value)).toBeNull();
        }
        expect(checkedFilePath("/tmp/a\0.txt")).toBeNull();
    });
});

describe("fileRepresentations", () => {
    it("writes one text/uri-list entry on macOS, with the file URL encoded", () => {
        expect(fileRepresentations("/tmp/My Files/résumé #1 100%.txt", "darwin")).toEqual([
            { [UriList]: "file:///tmp/My%20Files/r%C3%A9sum%C3%A9%20%231%20100%25.txt\r\n" },
        ]);
    });

    it("adds the GNOME copied-files format on Linux, then falls back to text/uri-list alone", () => {
        const url = "file:///home/dev/a%20b.md";
        expect(fileRepresentations("/home/dev/a b.md", "linux")).toEqual([
            { [UriList]: url + "\r\n", [GnomeCopiedFiles]: "copy\n" + url },
            { [UriList]: url + "\r\n" },
        ]);
    });
});

describe("copyFileToClipboard", () => {
    afterEach(() => vi.restoreAllMocks());

    it("offers nothing off macOS and Linux, and touches neither the file nor the clipboard", async () => {
        const deps = makeDeps("win32");
        expect(await copyFileToClipboard("C:\\Users\\dev\\a.txt", deps)).toBe("unsupported");
        expect(await copyFileToClipboard("/tmp/a.txt", deps)).toBe("unsupported");
        expect(deps.isRegularFile).not.toHaveBeenCalled();
        expect(deps.write).not.toHaveBeenCalled();
    });

    it("refuses a bad value before looking at the disk, and a path that is not a regular file", async () => {
        const deps = makeDeps("darwin");
        for (const value of [undefined, "", "a.txt", "~/a.txt", "/tmp/a\0.txt"]) {
            expect(await copyFileToClipboard(value, deps), String(value)).toBe("invalid");
        }
        expect(deps.isRegularFile).not.toHaveBeenCalled();
        const notAFile = makeDeps("darwin", { isRegularFile: vi.fn(async () => false) });
        expect(await copyFileToClipboard("/tmp/a-folder", notAFile)).toBe("invalid");
        expect(deps.write).not.toHaveBeenCalled();
        expect(notAFile.write).not.toHaveBeenCalled();
    });

    it("puts the checked path on the clipboard in one write", async () => {
        const deps = makeDeps("darwin");
        expect(await copyFileToClipboard("/tmp/x/../a.txt", deps)).toBe("copied");
        expect(deps.isRegularFile).toHaveBeenCalledExactlyOnceWith("/tmp/a.txt");
        expect(deps.write).toHaveBeenCalledExactlyOnceWith({ [UriList]: "file:///tmp/a.txt\r\n" });
    });

    it("writes both Linux formats at once", async () => {
        const deps = makeDeps("linux");
        expect(await copyFileToClipboard("/home/dev/a.md", deps)).toBe("copied");
        expect(deps.write).toHaveBeenCalledExactlyOnceWith({
            [UriList]: "file:///home/dev/a.md\r\n",
            [GnomeCopiedFiles]: "copy\nfile:///home/dev/a.md",
        });
    });

    it("falls back to text/uri-list alone on Linux when the richer write is refused", async () => {
        const write = vi
            .fn<(representations: Record<string, string>) => Promise<void>>()
            .mockRejectedValueOnce(new Error("unsupported format"))
            .mockResolvedValue(undefined);
        vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await copyFileToClipboard("/home/dev/a.md", makeDeps("linux", { write }))).toBe("copied");
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1][0]).toEqual({ [UriList]: "file:///home/dev/a.md\r\n" });
    });

    it("answers failed when every write is refused", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const write = vi.fn(async () => {
            throw new Error("clipboard busy");
        });
        expect(await copyFileToClipboard("/home/dev/a.md", makeDeps("linux", { write }))).toBe("failed");
        expect(write).toHaveBeenCalledTimes(2);
    });
});

describe.runIf(IsPosix)("isRegularFile on the disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "mt2115-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("accepts a regular file and a link to one, even one that cannot be read", () => {
        const file = join(dir, "sample.txt");
        writeFileSync(file, "neutral content");
        symlinkSync(file, join(dir, "link.txt"));
        const sealed = join(dir, "sealed.txt");
        writeFileSync(sealed, "neutral content");
        chmodSync(sealed, 0o000);
        return Promise.all([
            expect(isRegularFile(file)).resolves.toBe(true),
            expect(isRegularFile(join(dir, "link.txt"))).resolves.toBe(true),
            expect(isRegularFile(sealed)).resolves.toBe(true),
        ]);
    });

    it("refuses a folder, a link to a folder, a missing path, a broken link and a pipe", async () => {
        mkdirSync(join(dir, "folder"));
        symlinkSync(join(dir, "folder"), join(dir, "folder-link"));
        symlinkSync(join(dir, "missing"), join(dir, "broken-link"));
        execFileSync("mkfifo", [join(dir, "pipe")]);
        for (const name of ["folder", "folder-link", "missing", "broken-link", "pipe"]) {
            expect(await isRegularFile(join(dir, name)), name).toBe(false);
        }
    });
});

describe("the moltenterm-copy-file channel", () => {
    const frame = {};
    const host = { mainFrame: frame };
    const handlers = new Map<string, (...args: any[]) => any>();
    const dir = mkdtempSync(join(tmpdir(), "mt2115-ipc-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    beforeEach(() => {
        handlers.clear();
        mocks.write.mockClear();
        const ipc = createPrivilegedIpc(
            { on: () => {}, removeListener: () => {}, handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any,
            (event) => event.sender === host && event.senderFrame === frame
        );
        mocks.register = ipc.handleApp;
        initFileClipboardIpc();
    });

    it("is registered once, as an application channel", () => {
        expect([...handlers.keys()]).toEqual(["moltenterm-copy-file"]);
    });

    it("refuses a page, a webview or a subframe, and writes nothing", async () => {
        const file = join(dir, "sample.md");
        writeFileSync(file, "neutral content");
        const handler = handlers.get("moltenterm-copy-file");
        await expect(Promise.resolve().then(() => handler({ sender: {}, senderFrame: frame }, file))).rejects.toThrow(
            IpcDeniedMessage
        );
        await expect(Promise.resolve().then(() => handler({ sender: host, senderFrame: {} }, file))).rejects.toThrow(
            IpcDeniedMessage
        );
        expect(mocks.write).not.toHaveBeenCalled();
    });

    it.runIf(HostCopiesFiles)("copies an existing file for the application window and refuses a folder", async () => {
        const file = join(dir, "sample.md");
        writeFileSync(file, "neutral content");
        const handler = handlers.get("moltenterm-copy-file");
        const event = { sender: host, senderFrame: frame };
        expect(await handler(event, file)).toBe("copied");
        expect(mocks.write).toHaveBeenCalledTimes(1);
        const [items] = mocks.write.mock.calls[0];
        expect(items).toHaveLength(1);
        expect(items[0].items[UriList]).toMatch(/^file:\/\/\/.*\/sample\.md\r\n$/);
        expect(await handler(event, dir)).toBe("invalid");
        expect(await handler(event, "sample.md")).toBe("invalid");
        expect(mocks.write).toHaveBeenCalledTimes(1);
    });
});
