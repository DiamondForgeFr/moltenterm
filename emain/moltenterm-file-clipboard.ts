// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as electron from "electron";
import { stat } from "node:fs/promises";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { CopyFileResult, platformCopiesFiles } from "../frontend/util/moltenterm-file-clipboard";
import { handleAppIpc } from "./moltenterm-privileged-ipc";

// must match the channel in emain/preload.ts
const CopyFileChannel = "moltenterm-copy-file";

// Electron maps text/uri-list to the platform's copied-files format (NSFilenamesPboardType on macOS, where the system
// adds public.file-url and the legacy file flavors by itself). Linux file managers of the GNOME family read
// x-special/gnome-copied-files instead.
const UriListType = "text/uri-list";
const GnomeCopiedFilesType = 'electron application/osclipboard;format="x-special/gnome-copied-files"';

export type FileClipboardDeps = {
    platform: string;
    isRegularFile: (filePath: string) => Promise<boolean>;
    write: (representations: Record<string, string>) => Promise<void>;
};

// The absolute path of a file named by the window, or null. Only an absolute path passes: "~" and relative paths
// would depend on a folder the window does not control.
export function checkedFilePath(value: unknown): string | null {
    if (typeof value !== "string" || value === "" || value.includes("\0")) {
        return null;
    }
    if (!posix.isAbsolute(value)) {
        return null;
    }
    return posix.resolve(value);
}

// The writes to try, richest first. All representations of an entry go in one write: a later write replaces the
// clipboard, it does not add to it.
export function fileRepresentations(filePath: string, platform: string): Record<string, string>[] {
    const url = pathToFileURL(filePath, { windows: false }).href;
    const uriList = { [UriListType]: url + "\r\n" };
    if (platform !== "linux") {
        return [uriList];
    }
    return [{ ...uriList, [GnomeCopiedFilesType]: "copy\n" + url }, uriList];
}

// A link to a regular file counts as that file; a link to a folder, a device, a socket and a pipe do not.
export async function isRegularFile(filePath: string): Promise<boolean> {
    try {
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
}

function makeDefaultDeps(): FileClipboardDeps {
    return {
        platform: process.platform,
        isRegularFile,
        write: (representations) => electron.clipboard.write([new electron.ClipboardItem(representations)]),
    };
}

// Puts the file itself on the system clipboard. The file is never read: only its path goes out, as a file URL.
export async function copyFileToClipboard(
    value: unknown,
    deps: FileClipboardDeps = makeDefaultDeps()
): Promise<CopyFileResult> {
    if (!platformCopiesFiles(deps.platform)) {
        return "unsupported";
    }
    const filePath = checkedFilePath(value);
    if (filePath == null || !(await deps.isRegularFile(filePath))) {
        return "invalid";
    }
    for (const representations of fileRepresentations(filePath, deps.platform)) {
        try {
            await deps.write(representations);
            return "copied";
        } catch (e) {
            console.error("Failed to put a file on the clipboard:", e);
        }
    }
    return "failed";
}

export function initFileClipboardIpc() {
    handleAppIpc(CopyFileChannel, (_event, value: unknown) => copyFileToClipboard(value));
}
