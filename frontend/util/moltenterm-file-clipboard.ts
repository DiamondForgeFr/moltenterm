// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the main process (emain/moltenterm-file-clipboard.ts) and the file panel agree on for "Copy file"
// (FR-FILE-005, DS-FILE-011): the platforms whose clipboard carries a file, and the answers of the copy.

// Windows follows in 1.1.0; where a platform is not listed, the action is not offered rather than offered and broken.
export const FileClipboardPlatforms: string[] = ["darwin", "linux"];

// "invalid" is anything that is not an absolute path of an existing regular file; "failed" is a refused clipboard write.
export type CopyFileResult = "copied" | "unsupported" | "invalid" | "failed";

export function platformCopiesFiles(platform: string): boolean {
    return FileClipboardPlatforms.includes(platform);
}
