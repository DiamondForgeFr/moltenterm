// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { translate, translateCount } from "../i18n/i18n-core";
import { ProjectLooksMetaKey, WindowLookMetaKey } from "../window-look-model";
import { ProjectMetaKey } from "../workspace-project";
import { lookOverriders, settingOverriders } from "./settings-overrides";

const own = { oid: "a", name: "Alpha", meta: { [WindowLookMetaKey]: { opacity: 0.85, blur: false } } };
const onProject = { oid: "b", name: "Beta", meta: { [ProjectMetaKey]: "/code/b" } };
const plain = { oid: "c", name: "Gamma", meta: { [ProjectMetaKey]: "/code/c" } };
const clientMeta = { [ProjectLooksMetaKey]: { "/code/b": { opacity: 0.9, blur: true } } };

describe("app settings a workspace replaces (FR-SHELL-101)", () => {
    it("counts the workspaces with their own look or their project's", () => {
        expect(lookOverriders([own, onProject, plain], clientMeta).map((w) => w.oid)).toEqual(["a", "b"]);
        expect(lookOverriders([plain], clientMeta)).toEqual([]);
        expect(lookOverriders([own, plain], null).map((w) => w.oid)).toEqual(["a"]);
    });

    it("applies to the window's look settings only", () => {
        for (const key of ["window:transparent", "window:blur", "window:opacity"]) {
            expect(settingOverriders(key, [own, onProject], clientMeta), key).toHaveLength(2);
        }
        expect(settingOverriders("window:bgcolor", [own, onProject], clientMeta)).toEqual([]);
        expect(settingOverriders("term:fontsize", [own], clientMeta)).toEqual([]);
    });

    it("words the notice with plurals in English and French", () => {
        expect(translateCount("en", "settings.overridden", 1)).toBe("Overridden in 1 workspace");
        expect(translateCount("en", "settings.overridden", 2)).toBe("Overridden in 2 workspaces");
        expect(translateCount("fr", "settings.overridden", 1)).toBe("Remplacé dans 1 espace");
        expect(translateCount("fr", "settings.overridden", 2)).toBe("Remplacé dans 2 espaces");
        expect(translate("fr", "settings.scope.app")).toBe("Pour toute l'app");
        expect(translate("fr", "settings.scope.workspace")).toBe("Pour cet espace");
        expect(translate("fr", "settings.scope.project")).toBe("Pour ce projet");
        expect(translate("en", "settings.scope.app")).toBe("For the whole app");
    });
});
