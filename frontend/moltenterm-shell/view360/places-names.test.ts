// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { placeSentenceName } from "./places-names";

const Browser = "molten-browser";

describe("placeSentenceName", () => {
    it("names an agent by its first name alone", () => {
        const info = { firstname: "Adrien", agentname: "Claude Code", agent: "claude" } as any;
        expect(placeSentenceName({ view: "term" } as any, info)).toBe("Adrien");
    });

    it("falls back to the agent's name without a first name", () => {
        const info = { agentname: "Some Agent" } as any;
        expect(placeSentenceName({ view: "term" } as any, info)).toBe("Some Agent");
    });

    it("names a page by its title, not its host", () => {
        const meta = {
            view: Browser,
            "molten:browser:tabs": [{ id: "a", url: "https://example.com/x", title: "Project board" }],
            "molten:browser:active": "a",
        } as any;
        expect(placeSentenceName(meta, null)).toBe("Project board");
    });

    it("uses the host only when the page has no title", () => {
        const meta = {
            view: Browser,
            "molten:browser:tabs": [{ id: "a", url: "https://example.com/x" }],
            "molten:browser:active": "a",
        } as any;
        expect(placeSentenceName(meta, null)).toBe("example.com");
    });
});
