// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultContextEmblem, FallbackContextEmblem } from "./context-model";
import { EmblemCatalog } from "./emblem-catalog";
import { SuggestedEmblems } from "./emblem-model";

const Root = resolve(__dirname, "../../..");
const Source = readFileSync(resolve(__dirname, "emblem-catalog.ts"), "utf8");
const Names = Object.keys(EmblemCatalog);

// FR-SHELL-158: the emblems are Lucide's icons, a selection of them.
describe("the emblem catalog", () => {
    it("has an icon file in Lucide for every name, and imports that file", () => {
        const missing = Names.filter((name) => !existsSync(resolve(Root, `node_modules/lucide-react/dist/esm/icons/${name}.js`)));
        expect(missing).toEqual([]);
        const wrong = Names.filter((name) => !Source.includes(`"${name}": () => import("lucide-react/dist/esm/icons/${name}.js")`));
        expect(wrong).toEqual([]);
    });

    it("names icons the way the server accepts them: lower case words joined by hyphens", () => {
        expect(Names.filter((name) => !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || name.length > 60)).toEqual([]);
    });

    it("holds the default and the fallback emblem, and every suggestion the picker opens on", () => {
        expect(Names).toContain(DefaultContextEmblem);
        expect(Names).toContain(FallbackContextEmblem);
        expect(SuggestedEmblems.filter((name) => !Names.includes(name))).toEqual([]);
    });

    it("lists each name once and offers a real choice", () => {
        expect(new Set(Names).size).toBe(Names.length);
        expect(Names.length).toBeGreaterThan(300);
    });

    it("loads an icon's drawing", async () => {
        const node = (await EmblemCatalog[FallbackContextEmblem]()).__iconNode;
        expect(Array.isArray(node)).toBe(true);
        expect(node.length).toBeGreaterThan(0);
    });
});
