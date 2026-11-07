// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const Calls = vi.hoisted(() => ({ key: [] as unknown[][], section: [] as string[], write: [] as unknown[] }));

vi.mock("../settings/settings-open", () => ({
    openSettingsKey: async (...args: unknown[]) => void Calls.key.push(args),
    openSettingsSection: async (section: string) => void Calls.section.push(section),
}));
vi.mock("../command-panel/bindings", () => ({
    writeSettings: async (settings: unknown) => void Calls.write.push(settings),
}));

import { BrokkTableFirstKey, brokkMenuItems } from "./brokk-menu";

beforeEach(() => {
    Calls.key.length = 0;
    Calls.section.length = 0;
    Calls.write.length = 0;
});

describe("Brokk's menu, once the panel's ⋯ (FR-BOSS-009, AC4 and AC21)", () => {
    it("holds When Brokk comes to fetch me, his preferences and Turn Brokk off, in that order", () => {
        const items = brokkMenuItems("Brokk");
        expect(items.filter((i) => i.type !== "separator").map((i) => i.label)).toEqual([
            "When Brokk comes to fetch me…",
            "Brokk's preferences",
            "Turn Brokk off",
        ]);
        expect(items.map((i) => i.type)).toContain("separator");
    });

    it("puts the entry of the surface first, before a separator", () => {
        const first = { label: "Open the card of Brokk", click: () => {} };
        const items = brokkMenuItems("Brokk", undefined, first);
        expect(items[0]).toBe(first);
        expect(items[1].type).toBe("separator");
    });

    it("uses the name the developer chose", () => {
        expect(brokkMenuItems("Léa").map((i) => i.label)).toContain("Turn Léa off");
    });

    it("opens Preferences on the table, then the Brokk section, and the group closes first", () => {
        const order: string[] = [];
        const items = brokkMenuItems("Brokk", () => order.push("leave"));
        items[0].click();
        items[1].click();
        expect(order).toEqual(["leave", "leave"]);
        expect(Calls.key).toEqual([["boss", BrokkTableFirstKey]]);
        expect(Calls.section).toEqual(["boss"]);
    });

    it("turns Brokk off through the setting, and the group closes first", () => {
        const order: string[] = [];
        const items = brokkMenuItems("Brokk", () => order.push("leave"));
        items.find((i) => i.label === "Turn Brokk off").click();
        expect(order).toEqual(["leave"]);
        expect(Calls.write).toEqual([{ "boss:show": false }]);
    });
});
