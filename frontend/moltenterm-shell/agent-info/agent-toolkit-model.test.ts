// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { BlockLinks } from "../agent-links/agent-links-model";
import type { CompanionView } from "../companion/companion-model";
import { commandRows, serverRows } from "./agent-toolkit-model";

const links: BlockLinks = {
    blockid: "a",
    version: "1",
    agents: [{ links: [{ key: "1", server: "molten-browser", state: "connected" }] }],
};

describe("serverRows", () => {
    it("puts MoltenTerm's servers first with their live state, then the configured ones once", () => {
        const rows = serverRows(links, {
            supported: true,
            servers: [
                { name: "molten-browser", scope: "user", transport: "stdio" },
                { name: "github", scope: "user", transport: "http" },
                { name: "pending", scope: "project", state: "needsapproval" },
                { name: "figma", scope: "plugin", plugin: "design", state: "off" },
            ],
        });
        expect(rows).toEqual([
            { name: "molten-browser", origin: "molten", state: "connected" },
            { name: "github", origin: "user", plugin: undefined, transport: "http", state: "configured" },
            { name: "pending", origin: "project", plugin: undefined, transport: undefined, state: "needsapproval" },
            { name: "figma", origin: "plugin", plugin: "design", transport: undefined, state: "off" },
        ]);
    });

    it("keeps MoltenTerm's servers when the agent does not tell", () => {
        expect(serverRows(links, { supported: false })).toHaveLength(1);
        expect(serverRows(null, null)).toEqual([]);
    });
});

describe("commandRows", () => {
    it("orders by use, then by first use, and counts each program", () => {
        const view: CompanionView = {
            blockid: "a",
            version: 1,
            status: "loading",
            commands: ["git", "gh", "go", "rg"],
            commandcounts: { git: 3, gh: 1, go: 3 },
        };
        expect(commandRows(view)).toEqual([
            { name: "git", count: 3 },
            { name: "go", count: 3 },
            { name: "gh", count: 1 },
            { name: "rg", count: 1 },
        ]);
        expect(commandRows(null)).toEqual([]);
    });
});
