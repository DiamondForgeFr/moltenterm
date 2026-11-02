// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../workspace-project", () => ({ ProjectMetaKey: "molten:project", WorkspaceFolderMetaKey: "molten:folder" }));

import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import { effectiveSetting, isChanged, settingsCatalog } from "./settings-catalog";

// #1655: a new file panel hides dotfiles and .git; the panel's eye or its menu shows them (FR-FILE-002).
describe("hidden files are hidden by default (#1655)", () => {
    it("ships preview:showhiddenfiles off in the built-in config", () => {
        expect((builtinDefaults as Record<string, unknown>)["preview:showhiddenfiles"]).toBe(false);
    });

    it("shows the setting off in Preferences while unset, and on as a change", () => {
        const entry = settingsCatalog("darwin").find((e) => e.key === "preview:showhiddenfiles");
        expect(entry).toBeTruthy();
        expect(effectiveSetting(entry, undefined)).toBe(false);
        expect(isChanged(entry, undefined)).toBe(false);
        expect(isChanged(entry, true)).toBe(true);
    });
});
