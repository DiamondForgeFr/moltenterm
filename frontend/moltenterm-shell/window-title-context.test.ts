// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import type { PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nModel } from "./i18n/i18n";
import { setWindowTitleTab } from "./window-title";

const h = vi.hoisted(() => ({
    workspaceAtom: null as PrimitiveAtom<unknown>,
    clientAtom: null as PrimitiveAtom<unknown>,
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    h.workspaceAtom = atom(null) as PrimitiveAtom<unknown>;
    return { atoms: { workspace: h.workspaceAtom } };
});
vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    h.clientAtom = atom(null) as PrimitiveAtom<unknown>;
    return { ClientModel: { getInstance: () => ({ clientAtom: h.clientAtom }) } };
});
vi.mock("@/app/store/wos", async () => {
    const { atom } = await import("jotai");
    const atoms = new Map<string, unknown>();
    return {
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getWaveObjectAtom: (oref: string) => {
            if (!atoms.has(oref)) {
                atoms.set(oref, atom(oref === "tab:t1" ? { oid: "t1", name: "Release", blockids: [] } : null));
            }
            return atoms.get(oref);
        },
    };
});
vi.mock("./tab-identity-ui", () => ({ getHomeDir: () => "/Users/me" }));

const tab = { oid: "t1", name: "Release", blockids: [] as string[] } as Tab;

// FR-SHELL-158: the window's title names the context of the workspace it shows.
describe("the window title names the context", () => {
    const doc = { title: "" };

    beforeEach(() => {
        vi.stubGlobal("document", doc);
        globalStore.set(h.workspaceAtom, { oid: "w1", meta: {} });
        globalStore.set(h.clientAtom, { meta: {} });
    });

    afterEach(() => {
        I18nModel.getInstance().setLanguageSetting("");
        vi.unstubAllGlobals();
    });

    it("shows the default context in the interface language before any is stored", () => {
        setWindowTitleTab(tab);
        expect(doc.title).toBe("MoltenTerm — My workshop - Release");
    });

    it("follows a change of the interface language, the default context's name being the language's own text", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        setWindowTitleTab(tab);
        expect(doc.title).toBe("MoltenTerm — My workshop - Release");
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(doc.title).toBe("MoltenTerm — Mon atelier - Release");
        I18nModel.getInstance().setLanguageSetting("en");
        expect(doc.title).toBe("MoltenTerm — My workshop - Release");
    });

    it("names the context of the workspace on screen, and follows a rename and a switch", () => {
        globalStore.set(h.clientAtom, {
            meta: { "molten:contexts": [{ id: "a" }, { id: "df", name: "DiamondForge" }] },
        });
        globalStore.set(h.workspaceAtom, { oid: "w2", meta: { "molten:context": "df" } });
        setWindowTitleTab(tab);
        expect(doc.title).toBe("MoltenTerm — DiamondForge - Release");

        globalStore.set(h.clientAtom, {
            meta: { "molten:contexts": [{ id: "a" }, { id: "df", name: "Forge" }] },
        });
        expect(doc.title).toBe("MoltenTerm — Forge - Release");

        globalStore.set(h.workspaceAtom, { oid: "w3", meta: {} });
        expect(doc.title).toBe("MoltenTerm - Release");
    });
});
