// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { translate } from "./i18n/i18n-core";
import { hasDefaultName } from "./project-detect";
import { defaultWorkspaceName, workspaceShownName } from "./workspace-default-name";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

describe("default workspace names (#743)", () => {
    it("recognises the names wavesrv gives", () => {
        expect(defaultWorkspaceName("Starter workspace")).toEqual({ kind: "starter" });
        expect(defaultWorkspaceName("New Workspace (a7b51)")).toEqual({ kind: "new", id: "a7b51" });
    });

    it("leaves a name the user typed alone", () => {
        for (const name of ["Client A", "New Workspace plan", "New Workspace (a7b51) v2", "starter workspace", ""]) {
            expect(defaultWorkspaceName(name)).toBeNull();
            expect(workspaceShownName(name, fr)).toBe(name);
        }
        expect(workspaceShownName(null, fr)).toBeNull();
    });

    it("shows the default names in the interface language", () => {
        expect(workspaceShownName("Starter workspace", fr)).toBe("Espace de départ");
        expect(workspaceShownName("New Workspace (a7b51)", fr)).toBe("Nouvel espace de travail (a7b51)");
        expect(workspaceShownName("Starter workspace", en)).toBe("Starter workspace");
        expect(workspaceShownName("New Workspace (a7b51)", en)).toBe("New workspace (a7b51)");
    });

    it("gives a shown name back unchanged, so showing it twice is harmless", () => {
        for (const tr of [en, fr]) {
            for (const name of ["Starter workspace", "New Workspace (a7b51)"]) {
                const shown = workspaceShownName(name, tr);
                expect(workspaceShownName(shown, tr)).toBe(shown);
            }
        }
    });

    it("still treats both stored names as defaults for the project offer", () => {
        expect(hasDefaultName("Starter workspace")).toBe(true);
        expect(hasDefaultName("New Workspace (a7b51)")).toBe(true);
        expect(hasDefaultName("Client A")).toBe(false);
    });
});
