// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    entryStaticChunks,
    findHeavyInEntryGraph,
    heavyModulePreloads,
    heavyPackageOf,
    moltentermEntryGuard,
    type GuardAsset,
    type GuardChunk,
} from "./entry-guard";

function chunk(fileName: string, imports: string[], moduleIds: string[], isEntry = false): GuardChunk {
    return { type: "chunk", fileName, isEntry, imports, moduleIds };
}

const App = "/repo/frontend/app/view/term/term.tsx";
const Monaco = "/repo/node_modules/monaco-editor/esm/vs/editor/editor.api.js";
const Mermaid = "/repo/node_modules/mermaid/dist/mermaid.core.mjs";

describe("heavyPackageOf", () => {
    it.each([
        [Monaco, "monaco-editor"],
        ["/repo/node_modules/@shiki/core/dist/index.mjs", "@shiki"],
        ["/repo/node_modules/shiki/dist/bundle-web.mjs", "shiki"],
        ["/repo/node_modules/cytoscape-cose-bilkent/cytoscape-cose-bilkent.js", "cytoscape"],
        ["/repo/node_modules/@mermaid-js/parser/dist/mermaid-parser.core.mjs", "@mermaid-js"],
        ["C:\\repo\\node_modules\\katex\\dist\\katex.mjs", "katex"],
        ["/repo/node_modules/streamdown/dist/index.js", "streamdown"],
        ["/repo/node_modules/react/index.js", null],
        ["/repo/node_modules/shikimori/index.js", null],
        [App, null],
    ])("%s -> %s", (id, pkg) => {
        expect(heavyPackageOf(id)).toBe(pkg);
    });
});

describe("findHeavyInEntryGraph", () => {
    it("accepts a heavy library reached only through a dynamic import", () => {
        const bundle = {
            "index.js": chunk("index.js", ["vendor.js"], [App], true),
            "vendor.js": chunk("vendor.js", [], ["/repo/node_modules/react/index.js"]),
            "editor.js": chunk("editor.js", ["vendor.js"], [Monaco]),
        };
        expect(entryStaticChunks(bundle).map((c) => c.fileName)).toEqual(["index.js", "vendor.js"]);
        expect(findHeavyInEntryGraph(bundle)).toEqual([]);
    });

    it("reports a heavy library in the entry or in a chunk the entry imports statically", () => {
        const bundle: Record<string, GuardChunk | GuardAsset> = {
            "index.js": chunk("index.js", ["a.js"], [App, Mermaid], true),
            "a.js": chunk("a.js", ["b.js"], []),
            "b.js": chunk("b.js", [], [Monaco, "/repo/node_modules/monaco-editor/esm/vs/base/common/uri.js"]),
            "style.css": { type: "asset", fileName: "style.css" },
        };
        expect(findHeavyInEntryGraph(bundle)).toEqual([
            { chunk: "index.js", pkg: "mermaid", moduleId: Mermaid },
            { chunk: "b.js", pkg: "monaco-editor", moduleId: Monaco },
        ]);
    });
});

describe("heavyModulePreloads", () => {
    it("lists modulepreloads of heavy chunks only", () => {
        const html = [
            '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
            '<link rel="modulepreload" crossorigin href="./assets/vendor-123.js">',
            '<link rel="modulepreload" crossorigin href="./assets/shiki-BfBl.js">',
            '<link rel="modulepreload" crossorigin href="./assets/monaco-Yh.js">',
        ].join("\n");
        expect(heavyModulePreloads(html)).toEqual(["./assets/shiki-BfBl.js", "./assets/monaco-Yh.js"]);
    });
});

describe("moltentermEntryGuard", () => {
    function run(bundle: Record<string, unknown>) {
        const plugin = moltentermEntryGuard();
        const ctx = {
            error: (msg: string) => {
                throw new Error(msg);
            },
        };
        return () => plugin.generateBundle.call(ctx, {}, bundle as never);
    }

    it("fails the build when the entry imports a heavy library statically", () => {
        const bundle = {
            "index.js": { type: "chunk", fileName: "index.js", isEntry: true, imports: [], modules: { [Monaco]: {} } },
        };
        expect(run(bundle)).toThrow(/monaco-editor is in index.js/);
    });

    it("fails the build when index.html modulepreloads a heavy chunk", () => {
        const bundle = {
            "index.js": { type: "chunk", fileName: "index.js", isEntry: true, imports: [], modules: { [App]: {} } },
            "index.html": {
                type: "asset",
                fileName: "index.html",
                source: '<link rel="modulepreload" crossorigin href="./assets/mermaid-x.js">',
            },
        };
        expect(run(bundle)).toThrow(/modulepreloads \.\/assets\/mermaid-x\.js/);
    });

    it("passes a lean bundle", () => {
        const bundle = {
            "index.js": { type: "chunk", fileName: "index.js", isEntry: true, imports: [], modules: { [App]: {} } },
            "editor.js": { type: "chunk", fileName: "editor.js", isEntry: false, imports: [], modules: { [Monaco]: {} } },
        };
        expect(run(bundle)).not.toThrow();
    });
});
