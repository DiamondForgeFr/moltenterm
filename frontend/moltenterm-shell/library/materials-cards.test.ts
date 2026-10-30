// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import {
    CardRect,
    filterMaterials,
    gridNeighbor,
    looksLikeId,
    Material,
    materialTitleIsHost,
    materialDisplayTitle,
    materialPlaceText,
    materialStateChip,
    materialThumbnail,
    materialVisual,
    readableLink,
} from "./materials-model";

function lookup(dict: any, key: string): unknown {
    return key.split(".").reduce((node, part) => node?.[part], dict);
}

function mat(over: Partial<Material>): Material {
    return { id: "m1", project: "p", title: "Thème Coulée", kind: "page", source: "published", created: 1, updated: 1, ...over };
}

describe("material cards (#1546)", () => {
    it("makes a raw address readable without loading it", () => {
        expect(readableLink("https://www.example.com/docs/getting%20started/")).toBe("example.com · getting started");
        expect(readableLink("https://example.com")).toBe("example.com");
        expect(readableLink("not a url")).toBe("not a url");
        const raw = mat({ kind: "link", title: "https://github.com/acme/app/pull/42", link: "https://github.com/acme/app/pull/42" });
        expect(materialDisplayTitle(raw)).toBe("github.com · pull");
        expect(materialDisplayTitle(mat({ kind: "link", title: "", link: "https://acme.dev/report" }))).toBe("acme.dev · report");
        expect(materialDisplayTitle(mat({ title: "Thème Coulée", link: "https://claude.ai/x" }))).toBe("Thème Coulée");
    });

    it("skips a segment that is an identifier", () => {
        expect(looksLikeId("9f1e2d3c-aaaa-4bbb-8ccc-1234567890ab")).toBe(true);
        expect(looksLikeId("Nsoo26jhabxfARV9iFx3in")).toBe(true);
        expect(looksLikeId("4f9a0c3e1b2d7e8f")).toBe(true);
        expect(looksLikeId("12345")).toBe(true);
        expect(looksLikeId("getting-started-guide")).toBe(false);
        expect(looksLikeId("internationalization")).toBe(false);
        expect(readableLink("https://claude.ai/public/artifacts/9f1e2d3c-aaaa-4bbb-8ccc-1234567890ab")).toBe(
            "claude.ai · artifacts"
        );
        expect(readableLink("https://claude.ai/artifact/Nsoo26jhabxfARV9iFx3in")).toBe("claude.ai · artifact");
        expect(readableLink("https://acme.dev/docs/getting-started-guide")).toBe("acme.dev · getting-started-guide");
        expect(readableLink("https://example.com/issues/12345")).toBe("example.com · issues");
        const bare = mat({ kind: "link", title: "", link: "https://claude.ai/Nsoo26jhabxfARV9iFx3in" });
        expect(materialDisplayTitle(bare)).toBe("claude.ai");
        expect(materialTitleIsHost(bare)).toBe(true);
        expect(materialTitleIsHost(mat({ kind: "link", title: "", link: "https://acme.dev/report" }))).toBe(false);
        expect(materialTitleIsHost(mat({ title: "Thème Coulée" }))).toBe(false);
    });

    it("finds a raw-address material by its readable title", () => {
        const raw = mat({ kind: "link", title: "https://acme.dev/quarterly-report", link: "https://acme.dev/quarterly-report" });
        expect(filterMaterials([raw], "quarterly report")).toHaveLength(1);
    });

    it("says where a material lives", () => {
        const m = mat({});
        expect(materialPlaceText(m, { workspace: "MoltenTerm", view: "Cadrage" }, "ws-1")).toEqual({
            key: "library.materials.place.open",
            vars: { place: "MoltenTerm · Cadrage" },
            live: true,
        });
        expect(materialPlaceText(m, null, "ws-1").key).toBe("library.materials.place.never");
        const here = mat({ lastopened: { workspaceid: "ws-1", workspace: "MoltenTerm", tabid: "t1", view: "Cadrage" } });
        expect(materialPlaceText(here, null, "ws-1")).toEqual({
            key: "library.materials.place.closed",
            vars: { view: "Cadrage" },
        });
        expect(materialPlaceText(here, null, "ws-2")).toEqual({
            key: "library.materials.place.lastOpen",
            vars: { place: "MoltenTerm · Cadrage" },
        });
        const shown = (name: string) => (name === "Starter workspace" ? "Espace de départ" : name);
        expect(materialPlaceText(m, { workspace: "Starter workspace", view: "Terminal" }, "ws-1", shown).vars).toEqual({
            place: "Espace de départ · Terminal",
        });
    });

    it("shows one state chip, none for a plain link", () => {
        expect(materialStateChip(mat({ kind: "link", link: "https://a.b/c" }))).toBeNull();
        expect(materialStateChip(mat({ kind: "page", link: "https://a.b/c" }))).toEqual({ key: "linkNotCopied", warn: true });
        expect(
            materialStateChip(
                mat({ link: "https://a.b/c", copy: "kept", versions: [{ n: 1, at: 1, size: 3 }] })
            )
        ).toEqual({ key: "linkCopy", warn: false });
    });

    it("fills the visual from local files only", () => {
        expect(materialThumbnail("m1")).toBeNull();
        expect(materialVisual(mat({ kind: "image", thumbpath: "/d/items/m1/thumb.png" }))).toEqual({
            path: "/d/items/m1/thumb.png",
        });
        expect(
            materialVisual(mat({ kind: "image", copy: "kept", copypath: "/d/v1/a.png", versions: [{ n: 1, at: 1, size: 3 }] }))
        ).toEqual({ path: "/d/v1/a.png" });
        expect(materialVisual(mat({ kind: "page", link: "https://claude.ai/x" }))).toEqual({});
    });

    it("moves through the grid with the arrow keys", () => {
        // Two rows of three, then a day heading, then one card.
        const card = (col: number, top: number): CardRect => ({ left: col * 230, top, width: 220, height: 200 });
        const rects = [card(0, 0), card(1, 0), card(2, 0), card(0, 210), card(1, 210), card(2, 210), card(0, 460)];
        expect(gridNeighbor(rects, 0, "right")).toBe(1);
        expect(gridNeighbor(rects, 2, "right")).toBe(3);
        expect(gridNeighbor(rects, 0, "left")).toBe(0);
        expect(gridNeighbor(rects, 1, "down")).toBe(4);
        expect(gridNeighbor(rects, 5, "down")).toBe(6);
        expect(gridNeighbor(rects, 6, "up")).toBe(3);
        expect(gridNeighbor(rects, 1, "up")).toBe(1);
        expect(gridNeighbor(rects, 6, "down")).toBe(6);
    });

    it("has every place string in both languages with the same placeholders", () => {
        for (const key of ["open", "closed", "lastOpen", "never"]) {
            const e = lookup(en, `library.materials.place.${key}`) as string;
            const f = lookup(fr, `library.materials.place.${key}`) as string;
            expect(typeof e).toBe("string");
            expect(typeof f).toBe("string");
            expect(f.match(/\{\w+\}/g) ?? []).toEqual(e.match(/\{\w+\}/g) ?? []);
        }
    });
});
