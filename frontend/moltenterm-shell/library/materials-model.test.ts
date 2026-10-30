// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import {
    filterMaterials,
    findOpenPanel,
    groupMaterials,
    Material,
    materialFolderPath,
    materialForm,
    materialKeepOffer,
    materialLinkedFiles,
    materialOpenPlan,
    materialOriginKey,
    materialSizeText,
    materialVersion,
    newMaterialsCount,
    recoveredParts,
} from "./materials-model";

function lookup(dict: any, key: string): unknown {
    return key.split(".").reduce((node, part) => node?.[part], dict);
}

const Now = new Date(2026, 9, 30, 15, 0).getTime();
const Hour = 3600 * 1000;

function mat(over: Partial<Material>): Material {
    return {
        id: "m1",
        project: "p",
        title: "Thème Coulée",
        kind: "page",
        source: "published",
        created: Now - Hour,
        updated: Now - Hour,
        ...over,
    };
}

const Kept = {
    copy: "kept",
    versions: [{ n: 1, at: Now, size: 10, files: 12 }],
    copypath: "/data/m1/v1/proposal.html",
};

describe("materials list (FR-MAT-002)", () => {
    it("puts pinned materials on top, then days, newest first", () => {
        const groups = groupMaterials(
            [
                mat({ id: "old", created: Now - 5 * 24 * Hour }),
                mat({ id: "y", created: Now - 24 * Hour }),
                // Renamed just now: `updated` moves, its place does not.
                mat({ id: "t1", created: Now - 2 * Hour, updated: Now }),
                mat({ id: "t2", created: Now - 3 * Hour, versions: [{ n: 2, at: Now - Hour, size: 1 }] }),
                mat({ id: "pin", created: Now - 10 * 24 * Hour, pinned: true }),
            ],
            Now,
            "en-US"
        );
        expect(groups.map((g) => g.labelKey ?? "date")).toEqual(["pinned", "today", "yesterday", "date"]);
        expect(groups[1].items.map((m) => m.id)).toEqual(["t2", "t1"]);
        expect(groups[0].timeOnly).toBe(false);
        expect(groups[3].label).toContain("October");
    });

    it("searches title, original name, agent, subject, ticket and host, accents and case aside", () => {
        const list = [
            mat({ id: "a", title: "Thème Coulée", agent: "Adrien", ticket: 1318, link: "https://example.com/x" }),
            mat({ id: "b", title: "Plan", originalname: "plan-1301.md", subject: "Découpage" }),
        ];
        expect(filterMaterials(list, "coulee THEME").map((m) => m.id)).toEqual(["a"]);
        expect(filterMaterials(list, "#1318").map((m) => m.id)).toEqual(["a"]);
        expect(filterMaterials(list, "example.com").map((m) => m.id)).toEqual(["a"]);
        expect(filterMaterials(list, "plan-1301").map((m) => m.id)).toEqual(["b"]);
        expect(filterMaterials(list, "decoupage").map((m) => m.id)).toEqual(["b"]);
        expect(filterMaterials(list, "").length).toBe(2);
    });

    it("says the form in words, never the provider", () => {
        expect(materialForm(mat({ ...Kept, link: "https://example.com/a" }))).toEqual({ key: "linkCopy", warn: false });
        expect(materialForm(mat({ ...Kept }))).toEqual({ key: "copy", warn: false });
        expect(materialForm(mat({ kind: "link", link: "https://example.com/a" }))).toEqual({
            key: "link",
            warn: false,
        });
        expect(materialForm(mat({ kind: "video", copy: "toolarge", size: 48e6 })).warn).toBe(true);
    });

    it("says where it comes from when it is not a publication", () => {
        expect(materialOriginKey(mat({}))).toBeNull();
        expect(materialOriginKey(mat({ source: "named", agent: "Adrien" }))).toBe("namedBy");
        expect(materialOriginKey(mat({ source: "declared" }))).toBe("declared");
        expect(materialOriginKey(mat({ source: "brought" }))).toBe("brought");
    });

    it("reads the version and the linked files of the current version", () => {
        const m = mat({
            copy: "kept",
            versions: [
                { n: 1, at: 1, size: 1, files: 3 },
                { n: 2, at: 2, size: 1, files: 49 },
            ],
        });
        expect(materialVersion(m)).toBe(2);
        expect(materialLinkedFiles(m)).toBe(49);
    });

    it("opens each kind its way", () => {
        expect(materialOpenPlan(mat({ kind: "link", link: "https://x.test/a" }))).toEqual({
            how: "browser",
            url: "https://x.test/a",
        });
        expect(materialOpenPlan(mat({ ...Kept, link: "https://x.test/p" }))).toEqual({
            how: "browser",
            url: "https://x.test/p",
        });
        expect(materialOpenPlan(mat({ ...Kept }))).toEqual({ how: "folder", path: Kept.copypath });
        expect(materialOpenPlan(mat({ ...Kept, kind: "image", copypath: "/c/a.png" }))).toEqual({
            how: "preview",
            path: "/c/a.png",
        });
        expect(materialOpenPlan(mat({ kind: "text", original: "/tmp/plan.md" }))).toEqual({
            how: "preview",
            path: "/tmp/plan.md",
        });
        expect(materialOpenPlan(mat({ kind: "text", original: "/tmp/plan.md", originalgone: true }))).toBeNull();
        expect(materialOpenPlan(mat({ ...Kept, kind: "document", copypath: "/c/a.docx" }))).toEqual({
            how: "native",
            path: "/c/a.docx",
        });
    });

    it("shows the kept copy in its folder, else the original while it exists", () => {
        expect(materialFolderPath(mat({ ...Kept, original: "/tmp/p.html" }))).toBe(Kept.copypath);
        expect(materialFolderPath(mat({ original: "/tmp/p.html" }))).toBe("/tmp/p.html");
        expect(materialFolderPath(mat({ original: "/tmp/p.html", originalgone: true }))).toBeNull();
    });

    it("finds the panel already showing it", () => {
        const panels = [
            { blockId: "b1", tabId: "t", view: "molten-browser", urls: ["https://x.test/p/"] },
            { blockId: "b2", tabId: "t", view: "preview", file: "/c/a.png" },
        ];
        expect(findOpenPanel(panels, mat({ link: "https://x.test/p" }))?.blockId).toBe("b1");
        expect(findOpenPanel(panels, mat({ kind: "image", copypath: "/c/a.png" }))?.blockId).toBe("b2");
        expect(findOpenPanel(panels, mat({ link: "https://x.test/other" }))).toBeNull();
    });

    it("counts what arrived since the last visit", () => {
        const list = [mat({ id: "a", created: 100 }), mat({ id: "b", created: 300 })];
        expect(newMaterialsCount(list, 200)).toBe(1);
        expect(newMaterialsCount(list, 0)).toBe(2);
        expect(newMaterialsCount(list, 400)).toBe(0);
    });

    it("offers Keep a copy on a reference and Keep anyway on a held-back one", () => {
        expect(materialKeepOffer(mat({ kind: "video", copy: "toolarge", size: 48e6, original: "/v.mov" }))).toBe(
            "keep"
        );
        expect(materialKeepOffer(mat({ kind: "text", copy: "secret", original: "/a.md" }))).toBe("keepanyway");
        expect(materialKeepOffer(mat({ kind: "video", copy: "toolarge", size: 900e6, original: "/v.mov" }))).toBeNull();
        expect(materialKeepOffer(mat({ ...Kept, original: "/a" }))).toBeNull();
    });

    it("writes sizes in the interface's language", () => {
        expect(materialSizeText(11e6, "en-US")).toBe("11 MB");
        expect(materialSizeText(0, "en-US")).toBe("");
    });

    it("has every word it composes in both languages", () => {
        const keys = [
            ...["page", "link", "pdf", "image", "video", "text", "document"].map((k) => `library.materials.kind.${k}`),
            ...["linkCopy", "copy", "link", "linkNotCopied", "notCopied"].map((k) => `library.materials.form.${k}`),
            ...["named", "namedBy", "declared", "declaredBy", "brought"].map((k) => `library.materials.origin.${k}`),
            ...["pinned", "today", "yesterday"].map((k) => `library.materials.day.${k}`),
        ];
        for (const key of keys) {
            expect(typeof lookup(en, key), key).toBe("string");
            expect(typeof lookup(fr, key), key).toBe("string");
        }
    });
});

describe("search past sessions (FR-MAT-008)", () => {
    const Done = { sessions: 3, found: 14, new: 12, kept: 11, gone: 3, notcopied: 0 };

    it("reports what it found, then the erased sources and those not copied", () => {
        expect(recoveredParts(Done)).toEqual([
            { key: "library.materials.recover.found", count: 14 },
            { key: "library.materials.recover.gone", count: 3 },
        ]);
        expect(recoveredParts({ ...Done, gone: 0, notcopied: 2 })).toEqual([
            { key: "library.materials.recover.found", count: 14 },
            { key: "library.materials.recover.notCopied", count: 2 },
        ]);
        expect(recoveredParts({ ...Done, found: 0 })).toEqual([{ key: "library.materials.recover.none" }]);
        expect(recoveredParts({ ...Done, sessions: 0, found: 0 })).toEqual([
            { key: "library.materials.recover.noSessions" },
        ]);
        expect(recoveredParts(null)).toEqual([]);
    });

    it("has its words in both languages, the counts in both plural forms", () => {
        for (const key of ["found", "gone", "notCopied"]) {
            for (const dict of [en, fr]) {
                const node = lookup(dict, `library.materials.recover.${key}`) as Record<string, string>;
                expect(node?.one, key).toContain("{count}");
                expect(node?.other, key).toContain("{count}");
            }
        }
        expect(lookup(fr, "library.materials.recover.button")).toBe("Chercher dans les sessions passées");
        expect((lookup(fr, "library.materials.recover.found") as any).other).toBe("{count} matériaux retrouvés");
        expect((lookup(fr, "library.materials.recover.gone") as any).other).toBe("{count} sources déjà effacées");
    });
});
