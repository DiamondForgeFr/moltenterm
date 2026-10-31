// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    AiIcon,
    DefaultTabIcon,
    isGenericTabName,
    numberDuplicateViewNames,
    panelIcon,
    panelReviewDone,
    panelTitle,
    panelViewName,
    tabDisplayName,
} from "./tab-identity";

describe("tab identity (FR-SHELL-056, DS-SHELL-098)", () => {
    it("recognises Wave's generic names only", () => {
        expect(isGenericTabName("T1")).toBe(true);
        expect(isGenericTabName(" T12 ")).toBe(true);
        expect(isGenericTabName("Tests")).toBe(false);
        expect(isGenericTabName("T1 api")).toBe(false);
        expect(isGenericTabName("")).toBe(false);
    });

    it("gives each view its icon", () => {
        expect(panelIcon({ view: "term" })).toBe("terminal");
        expect(panelIcon({ view: "molten-project" })).toBe("gauge");
        expect(panelIcon({ view: "molten-browser" })).toBe("globe");
        expect(panelIcon({ view: "something-new" })).toBe(DefaultTabIcon);
        expect(panelIcon(null)).toBe(DefaultTabIcon);
    });

    it("names a panel after what it shows", () => {
        expect(panelTitle({ view: "term", "cmd:cwd": "/Users/me/src/moltenterm/" }, "/Users/me")).toBe("moltenterm");
        expect(panelTitle({ view: "term", "cmd:cwd": "/Users/me" }, "/Users/me")).toBe("~");
        expect(panelTitle({ view: "term" })).toBe("Terminal");
        expect(panelTitle({ view: "term", connection: "dev@box" })).toBe("dev@box");
        expect(panelTitle({ view: "preview", file: "/tmp/notes/todo.md" })).toBe("todo.md");
        expect(panelTitle({ view: "web", url: "https://www.github.com/x" })).toBe("github.com");
        expect(panelTitle({ view: "web", url: "not a url" })).toBe("Web page");
        expect(panelTitle({ view: "molten-sessions" })).toBe("Sessions");
        expect(panelTitle({ view: "tsunami" })).toBe("App");
        expect(panelTitle({ view: "molten-review-ai" })).toBe("AI review");
        expect(panelTitle({ view: "tips" })).toBe("Tips");
        expect(panelTitle({ view: "something-new" })).toBe("");
    });

    it("keeps a name the user typed and replaces T<n> only", () => {
        const term = { view: "term", "cmd:cwd": "/src/api" };
        expect(tabDisplayName("T3", term)).toBe("Terminal · api");
        expect(tabDisplayName("Release", term)).toBe("Release");
        expect(tabDisplayName("T3", null)).toBe("T3");
    });

    it("names a new view after its main panel's kind and place (#1669)", () => {
        expect(panelViewName({ view: "term", "cmd:cwd": "/src/roman" })).toBe("Terminal · roman");
        expect(panelViewName({ view: "preview", file: "/src/roman" })).toBe("Files · roman");
        expect(panelViewName({ view: "molten-browser", url: "https://github.com/x" })).toBe("Web page · github.com");
        expect(panelViewName({ view: "term", "cmd:cwd": "/Users/me" }, "/Users/me")).toBe("Terminal · ~");
        expect(panelViewName({ view: "term" })).toBe("Terminal");
        expect(panelViewName({ view: "preview" })).toBe("Files");
        expect(panelViewName({ view: "molten-project" })).toBe("Project");
        expect(panelViewName({ view: "something-new" })).toBe("");
        expect(panelViewName(null)).toBe("");
    });

    it("numbers a derived name only on a real duplicate, never a typed one (#1669)", () => {
        const names = numberDuplicateViewNames([
            { id: "a", name: "Terminal · roman", derived: true },
            { id: "b", name: "Files · roman", derived: true },
            { id: "c", name: "Terminal · roman", derived: true },
            { id: "d", name: "Release", derived: false },
            { id: "e", name: "Release", derived: false },
            { id: "f", name: "Terminal · roman", derived: true },
        ]);
        expect([...names.entries()]).toEqual([
            ["a", "Terminal · roman"],
            ["b", "Files · roman"],
            ["c", "Terminal · roman 2"],
            ["d", "Release"],
            ["e", "Release"],
            ["f", "Terminal · roman 3"],
        ]);
        const typed = numberDuplicateViewNames([
            { id: "t", name: "Files · roman", derived: false },
            { id: "g", name: "Files · roman", derived: true },
        ]);
        expect(typed.get("t")).toBe("Files · roman");
        expect(typed.get("g")).toBe("Files · roman 2");
    });

    it("shows the AI icon for a terminal that holds an agent, and only for a terminal (#1257)", () => {
        expect(panelIcon({ view: "term" }, true)).toBe(AiIcon);
        expect(panelIcon({ view: "term" }, false)).toBe("terminal");
        expect(panelIcon({ view: "term" })).toBe("terminal");
        expect(panelIcon({ view: "preview" }, true)).toBe("folder-open");
    });

    it("marks a Review tab whose PR is finished, and no other tab (#686)", () => {
        expect(panelReviewDone({ view: "molten-review", "molten:reviewdone": { state: "merged" } })).toEqual({
            state: "merged",
        });
        expect(panelReviewDone({ view: "molten-review", "molten:reviewdone": { state: "closed" } })).toEqual({
            state: "closed",
        });
        expect(panelReviewDone({ view: "molten-review" })).toBeNull();
        expect(panelReviewDone({ view: "term", "molten:reviewdone": { state: "merged" } })).toBeNull();
        expect(panelReviewDone(null)).toBeNull();
    });
});
