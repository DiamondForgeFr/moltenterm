// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agent note's texts (FR-I18N-001, #2008): every one goes through a key, in English and in French with the same
// placeholders, and the menu follows the language when it opens.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/contextmenu", () => ({ ContextMenuModel: { getInstance: () => ({}) } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { I18nModel } from "../i18n/i18n";
import { placeholders, resolveKey, shippedDictionary, translate } from "../i18n/i18n-core";
import { agentNoteMenuItems, type NoteSubject } from "./agent-note-ui";

const Keys = [
    "sidebar.agents.note.add",
    "sidebar.agents.note.edit",
    "sidebar.agents.note.remove",
    "sidebar.agents.note.field",
];

const subject: NoteSubject = { kind: "agent", at: "row:b1", workspaceId: "ws1", key: "b1", name: "Arthur" };

afterEach(() => {
    I18nModel.getInstance().setLanguageSetting("");
});

describe("the note's keys", () => {
    const en = shippedDictionary("en");
    const fr = shippedDictionary("fr");

    it.each(Keys)("%s is in English and in French, with the same placeholders", (key) => {
        const english = resolveKey(en, key);
        const french = resolveKey(fr, key);
        expect(typeof english).toBe("string");
        expect(typeof french).toBe("string");
        expect(placeholders(french as string)).toEqual(placeholders(english as string));
    });

    it.each(Keys)("%s is translated, not copied from English", (key) => {
        expect(resolveKey(fr, key)).not.toBe(resolveKey(en, key));
    });

    it("names the agent in the field's label", () => {
        expect(translate("en", "sidebar.agents.note.field", { name: "Léa" })).toBe("Note for Léa");
        expect(translate("fr", "sidebar.agents.note.field", { name: "Léa" })).toBe("Note pour Léa");
    });

    it("names no machine and no system", () => {
        for (const key of Keys) {
            for (const dict of [en, fr]) {
                expect(resolveKey(dict, key)).not.toMatch(/\b(mac|macos|finder|windows|linux|explorer)\b/i);
            }
        }
    });
});

describe("the menu", () => {
    const labels = (hasNote: boolean) => agentNoteMenuItems(subject, hasNote).map((item) => item.label);

    it("is in English", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        expect(labels(false)).toEqual(["Add a note…"]);
        expect(labels(true)).toEqual(["Edit note", "Remove note"]);
    });

    it("is in French when the language is French, resolved each time it opens", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(labels(false)).toEqual(["Ajouter une note…"]);
        expect(labels(true)).toEqual(["Modifier la note", "Retirer la note"]);
        I18nModel.getInstance().setLanguageSetting("en");
        expect(labels(false)).toEqual(["Add a note…"]);
    });
});

describe("the components", () => {
    const ui = fs.readFileSync(path.resolve(__dirname, "agent-note-ui.tsx"), "utf8");

    it("carry no literal text: the field and the menu take theirs from keys", () => {
        expect(ui).not.toMatch(/(label|title|placeholder|aria-label)[:=]\s*\{?\s*["'][A-Za-z]/);
        for (const key of Keys) {
            expect(ui).toContain(`"${key}"`);
        }
    });
});
