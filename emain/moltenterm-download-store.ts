// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The downloads' history on disk (FR-MC-019 AC11, #1992): one JSON file in the application's own data folder, written
// atomically (a temporary file, then a rename) so a crash never leaves half a list. It holds records only, never a
// file's content: clearing it, or losing it, touches no downloaded file.

import * as fs from "fs";
import * as path from "path";
import type { DownloadRecord } from "../frontend/moltenterm-shell/downloads/downloads-model";

const HistoryFileName = "downloads.json";
const HistoryVersion = 1;

export class DownloadStore {
    constructor(private dir: string) {}

    private file(): string {
        return path.join(this.dir, HistoryFileName);
    }

    // The parsed file, or null when there is none or it cannot be read: the history starts empty rather than fail.
    async load(): Promise<unknown> {
        try {
            return JSON.parse(await fs.promises.readFile(this.file(), "utf8"));
        } catch {
            return null;
        }
    }

    private body(items: DownloadRecord[]): string {
        // What is measured live (speed, the missing mark) is not history.
        const kept = items.map((r) => ({ ...r, bytesPerSecond: 0, missing: false }));
        return JSON.stringify({ version: HistoryVersion, items: kept });
    }

    async save(items: DownloadRecord[]): Promise<void> {
        await fs.promises.mkdir(this.dir, { recursive: true });
        const temp = `${this.file()}.${process.pid}.tmp`;
        await fs.promises.writeFile(temp, this.body(items));
        await fs.promises.rename(temp, this.file());
    }

    // At quit, when no later tick is left to write it.
    saveSync(items: DownloadRecord[]): void {
        fs.mkdirSync(this.dir, { recursive: true });
        const temp = `${this.file()}.${process.pid}.tmp`;
        fs.writeFileSync(temp, this.body(items));
        fs.renameSync(temp, this.file());
    }
}
