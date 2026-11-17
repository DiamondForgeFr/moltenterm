// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { MaxActions } from "../notifications-model";
import { decideLogsEdge, LogsClearGesture, LogsNoticeKey, logsNotification, LogsShowGesture } from "./logs-model";

describe("when the note of the logs is said (#2335)", () => {
    it("says it once when the logs pass the mark, then not again while it is said", () => {
        expect(decideLogsEdge({ high: true }, false)).toBe("say");
        expect(decideLogsEdge({ high: true }, true)).toBe("none");
    });

    it("settles it when the logs are back under the mark, and says nothing when it never was said", () => {
        expect(decideLogsEdge({ high: false }, true)).toBe("settle");
        expect(decideLogsEdge({ high: false }, false)).toBe("none");
    });
});

describe("the note of the logs (#2335)", () => {
    const note = logsNotification(1_240_000_000, 1_000_000_000);

    it("is one situation, kept as read so it makes no toast and no count", () => {
        expect(note.key).toBe(LogsNoticeKey);
        expect(note.read).toBe(true);
        expect(note.kind).toBe("info");
        expect(note.global).toBe(true);
        expect(note.source).toBe("moltenterm");
    });

    it("says the size and the mark in plain words", () => {
        // A size is written with a non-breaking space between the figure and its unit: read here as a plain one.
        const words = `${note.title}\n${note.message}`.replace(/\p{Zs}/gu, " ");
        expect(words).toContain("The logs take 1.2 GB");
        expect(words).toContain("grew past 1.0 GB on this computer");
        expect(words).not.toMatch(/\b(mac|macos|finder|windows|linux|explorer)\b/i);
    });

    it("offers Clear logs and Show in folder, the second one lasting", () => {
        expect(note.actions.length).toBeLessThanOrEqual(MaxActions);
        expect(note.actions.map((a) => [a.label, a.kind, a.gesture, a.lasting ?? false])).toEqual([
            ["Clear logs", "gesture", LogsClearGesture, false],
            ["Show in folder", "gesture", LogsShowGesture, true],
        ]);
    });
});
