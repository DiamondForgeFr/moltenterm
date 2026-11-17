// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import type { PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ write: vi.fn(async (_settings: Record<string, unknown>) => {}) }));
vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    const settings = new Map<string, ReturnType<typeof atom>>();
    return {
        getSettingsKeyAtom: (key: string) => {
            if (!settings.has(key)) {
                settings.set(key, atom(undefined as unknown));
            }
            return settings.get(key);
        },
    };
});
vi.mock("../command-panel/bindings", () => ({ writeSettings: m.write }));

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import {
    choiceSettings,
    choicesOf,
    chooseUsage,
    readChoices,
    usageChoiceMenu,
    UsageHideKey,
    UsageShowKey,
} from "./brokk-usage-choices";

// The settings of this test are writable atoms (the mock above); the real ones are read-only.
function setSetting(key: string, value: unknown) {
    globalStore.set(getSettingsKeyAtom(key as any) as unknown as PrimitiveAtom<unknown>, value);
}

beforeEach(() => {
    m.write.mockClear();
    setSetting(UsageShowKey, undefined);
    setSetting(UsageHideKey, undefined);
});

describe("the choices of which providers the usage grid shows (FR-BOSS-009, AC97)", () => {
    it("are MoltenTerm's settings, never a project's files", () => {
        expect(UsageShowKey).toBe("boss:usageshow");
        expect(UsageHideKey).toBe("boss:usagehide");
    });

    it("read the lists the settings hold, and nothing that is not a list of ids", () => {
        expect(choicesOf(["claude", "", 4, "codex"], ["x"])).toEqual({ show: ["claude", "codex"], hide: ["x"] });
        expect(choicesOf(undefined, null)).toEqual({ show: [], hide: [] });
        expect(choicesOf("claude", { 0: "x" })).toEqual({ show: [], hide: [] });
    });

    it("take a key away when its list is empty", () => {
        expect(choiceSettings({ show: [], hide: [] })).toEqual({ [UsageShowKey]: null, [UsageHideKey]: null });
        expect(choiceSettings({ show: ["claude"], hide: ["codex"] })).toEqual({
            [UsageShowKey]: ["claude"],
            [UsageHideKey]: ["codex"],
        });
    });

    it("write the lists with the provider moved, the other choices kept", async () => {
        setSetting(UsageShowKey, ["claude"]);
        setSetting(UsageHideKey, ["codex"]);
        expect(readChoices()).toEqual({ show: ["claude"], hide: ["codex"] });
        await chooseUsage("codex", "show");
        expect(m.write).toHaveBeenLastCalledWith({ [UsageShowKey]: ["claude", "codex"], [UsageHideKey]: null });
        await chooseUsage("claude", "auto");
        expect(m.write).toHaveBeenLastCalledWith({ [UsageShowKey]: null, [UsageHideKey]: ["codex"] });
        await chooseUsage("claude", "hide");
        expect(m.write).toHaveBeenLastCalledWith({ [UsageShowKey]: null, [UsageHideKey]: ["codex", "claude"] });
    });

    it("make the menu of a row: three radio choices, the current one marked, named for the provider", () => {
        const items = usageChoiceMenu("claude", "Claude Code", "hide");
        expect(items.map((i) => [i.label, i.type, i.checked])).toEqual([
            ["Always show Claude Code", "radio", false],
            ["Hide Claude Code", "radio", true],
            ["Show Claude Code automatically", "radio", false],
        ]);
    });

    it("write only when the developer picks another choice", async () => {
        const items = usageChoiceMenu("claude", "Claude Code", "hide");
        items[1].click();
        expect(m.write).not.toHaveBeenCalled();
        items[0].click();
        await vi.waitFor(() => expect(m.write).toHaveBeenCalledOnce());
        expect(m.write).toHaveBeenCalledWith({ [UsageShowKey]: ["claude"], [UsageHideKey]: null });
    });
});
