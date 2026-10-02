// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AttentionDedupMs, parseOsc777, parseOsc9, shouldRecord } from "./agent-attention-model";

describe("parseOsc9", () => {
    it("takes the text as the title", () => {
        expect(parseOsc9("Claude is waiting for your input")).toEqual({ title: "Claude is waiting for your input" });
    });

    it.each(["", "   ", "4;1;50", "4;0"])("ignores %j (empty or a ConEmu progress report)", (data) => {
        expect(parseOsc9(data)).toBeNull();
    });
});

describe("parseOsc777", () => {
    it("reads notify;title;body, keeping semicolons in the body", () => {
        expect(parseOsc777("notify;Codex;Task done; 3 files changed")).toEqual({
            title: "Codex",
            message: "Task done; 3 files changed",
        });
    });

    it("uses the body as the title when the title is empty", () => {
        expect(parseOsc777("notify;;Build finished")).toEqual({ title: "Build finished" });
    });

    it.each(["", "notify", "notify;;", "other;Title;Body"])("ignores %j", (data) => {
        expect(parseOsc777(data)).toBeNull();
    });
});

describe("shouldRecord", () => {
    it("records one signal per block within the window", () => {
        const last = new Map<string, number>();
        expect(shouldRecord(last, "a", 1000)).toBe(true);
        expect(shouldRecord(last, "a", 1000 + AttentionDedupMs - 1)).toBe(false);
        expect(shouldRecord(last, "b", 1500)).toBe(true);
        expect(shouldRecord(last, "a", 1000 + AttentionDedupMs)).toBe(true);
    });
});
