// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    agentGlyph,
    DefaultAgentGlyph,
    DefaultTabIcon,
    isGenericTabName,
    panelIcon,
    panelTitle,
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
        expect(panelTitle({ view: "web", url: "not a url" })).toBe("Web");
        expect(panelTitle({ view: "molten-sessions" })).toBe("Sessions");
        expect(panelTitle({ view: "tsunami" })).toBe("Tsunami");
    });

    it("keeps a name the user typed and replaces T<n> only", () => {
        const term = { view: "term", "cmd:cwd": "/src/api" };
        expect(tabDisplayName("T3", term)).toBe("api");
        expect(tabDisplayName("Release", term)).toBe("Release");
        expect(tabDisplayName("T3", null)).toBe("T3");
    });

    it("takes the agent's glyph from its preset", () => {
        const presets = { "agent@claude": { "display:icon": "asterisk" }, "agent@codex": { "display:icon": "" } };
        expect(agentGlyph("claude", presets)).toBe("asterisk");
        expect(agentGlyph("codex", presets)).toBe(DefaultAgentGlyph);
        expect(agentGlyph("other", null)).toBe(DefaultAgentGlyph);
    });
});
