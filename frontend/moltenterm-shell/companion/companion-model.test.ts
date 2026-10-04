// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    companionMarkdown,
    CompanionView,
    diffLineKind,
    displayPath,
    firstChangedLine,
    formatArgs,
    neighbourAnswer,
    newerView,
    permissionRequest,
    statusMessage,
    todoCounts,
} from "./companion-model";

const view = (patch: Partial<CompanionView>): CompanionView => ({ blockid: "b", version: 1, status: "live", ...patch });

describe("companion model", () => {
    it("keeps the newest of a snapshot and an event", () => {
        const a = view({ version: 3 });
        const b = view({ version: 2 });
        expect(newerView(a, b)).toBe(a);
        expect(newerView(b, a)).toBe(a);
        expect(newerView(null, b)).toBe(b);
        expect(newerView(a, null)).toBe(a);
    });

    it("explains every state without a session", () => {
        expect(statusMessage(view({ status: "unsupportedagent", agentname: "Gemini CLI" })).title).toBe(
            "No companion for Gemini CLI"
        );
        expect(statusMessage(view({ status: "unsupportedformat", message: "Claude Code 9.0.0" })).detail).toContain(
            "Claude Code 9.0.0"
        );
        expect(statusMessage(view({ status: "unsupportedformat" })).detail).toContain("not affected");
        expect(statusMessage(view({ status: "noagent" })).title).toContain("No agent");
        expect(statusMessage(view({ status: "choose" })).title).toContain("Which session");
        expect(statusMessage(view({ status: "live" }))).toBeNull();
        expect(statusMessage(view({ status: "loading", session: { path: "/x", linkedby: "hook" } }))).toBeNull();
        expect(statusMessage(null).title).toContain("Reading");
    });

    it("shows a permission request when the transcript asks, or when the agent waits on a call", () => {
        const pending = [
            { id: "1", tool: "Bash", args: '{"command":"ls"}' },
            { id: "2", tool: "Edit" },
        ];
        expect(permissionRequest(pending, "working")).toBeNull();
        expect(permissionRequest(pending, "waiting").id).toBe("2");
        expect(permissionRequest([{ id: "3", tool: "exec", approval: true }], "working").id).toBe("3");
        expect(permissionRequest([], "waiting")).toBeNull();
    });

    it("formats arguments", () => {
        expect(formatArgs('{"a":1}')).toBe('{\n  "a": 1\n}');
        expect(formatArgs('"ls -la"')).toBe("ls -la");
        expect(formatArgs("not json")).toBe("not json");
    });

    it("reads diffs", () => {
        expect(diffLineKind("@@ -1,2 +1,3 @@")).toBe("hunk");
        expect(diffLineKind("+added")).toBe("add");
        expect(diffLineKind("-removed")).toBe("del");
        expect(diffLineKind("+++ b/file")).toBe("meta");
        expect(diffLineKind(" same")).toBe("ctx");
        expect(firstChangedLine("@@ -3,2 +5,3 @@\n x")).toBe(5);
        expect(firstChangedLine("@@ -0,0 +1 @@\n+a")).toBe(1);
        expect(firstChangedLine("")).toBe(0);
    });

    it("shows paths relative to the session folder", () => {
        expect(displayPath("/work/demo/src/a.ts", "/work/demo")).toBe("src/a.ts");
        expect(displayPath("/work/demo2/a.ts", "/work/demo")).toBe("/work/demo2/a.ts");
        expect(displayPath("/x/a.ts", "")).toBe("/x/a.ts");
    });

    it("browses answers", () => {
        const answers = [
            { index: 2, preview: "a" },
            { index: 5, preview: "b" },
            { index: 9, preview: "c" },
        ];
        expect(neighbourAnswer(answers, 9, -1)).toBe(5);
        expect(neighbourAnswer(answers, 2, -1)).toBeNull();
        expect(neighbourAnswer(answers, 5, 1)).toBe(9);
        expect(neighbourAnswer(answers, 9, 1)).toBeNull();
        expect(neighbourAnswer(answers, 42, -1)).toBe(5);
        expect(neighbourAnswer([], 1, -1)).toBeNull();
    });

    it("counts tasks", () => {
        expect(
            todoCounts([
                { text: "a", status: "completed" },
                { text: "b", status: "pending" },
            ])
        ).toEqual({ done: 1, total: 2 });
        expect(todoCounts(null)).toEqual({ done: 0, total: 0 });
    });

    it("keeps an answer from loading remote media, but not its code", () => {
        const md = 'See <picture><source srcset="https://x/y.png"></picture>\n```html\n<source src="a">\n```';
        const out = companionMarkdown(md);
        expect(out).toContain("&lt;picture>&lt;source");
        expect(out).toContain('```html\n<source src="a">\n```');
        expect(companionMarkdown(null)).toBe("");
    });
});
