// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    bundledPackagesOf,
    GraphDir,
    manifestOf,
    moltentermBundledPackages,
    packageOfModule,
    resetBundledPackages,
    type GraphAsset,
    type GraphChunk,
} from "./bundled-packages";

const Root = "/repo";

function chunk(modules: Record<string, number>): GraphChunk {
    return {
        type: "chunk",
        modules: Object.fromEntries(Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }])),
    };
}

describe("packageOfModule", () => {
    it.each([
        ["/repo/node_modules/react/index.js", "react", "node_modules/react"],
        ["/repo/node_modules/@floating-ui/react/dist/index.mjs", "@floating-ui/react", "node_modules/@floating-ui/react"],
        [
            "/repo/node_modules/electron-updater/node_modules/fs-extra/lib/index.js",
            "fs-extra",
            "node_modules/electron-updater/node_modules/fs-extra",
        ],
    ])("%s -> %s", (id, name, dir) => {
        expect(packageOfModule(id, Root)).toEqual({ name, dir });
    });

    it("reads a Windows path", () => {
        expect(packageOfModule("C:\\repo\\node_modules\\jotai\\esm\\index.mjs", "C:/repo")).toEqual({
            name: "jotai",
            dir: "node_modules/jotai",
        });
    });

    it("reads the path behind a plugin's wrapper", () => {
        expect(packageOfModule("\0/repo/node_modules/debug/src/browser.js?commonjs-module", Root)).toEqual({
            name: "debug",
            dir: "node_modules/debug",
        });
        expect(packageOfModule("\0commonjs-proxy:/repo/node_modules/ms/index.js", Root)).toEqual({
            name: "ms",
            dir: "node_modules/ms",
        });
    });

    it("attributes the preload helper to Vite, whose code it is", () => {
        expect(packageOfModule("\0vite/preload-helper.js", Root)).toEqual({ name: "vite", dir: "node_modules/vite" });
    });

    it("has no package for the project's own files", () => {
        expect(packageOfModule("/repo/frontend/app/app.tsx", Root)).toBeNull();
        expect(packageOfModule("\0virtual:something", Root)).toBeNull();
    });
});

describe("bundledPackagesOf", () => {
    it("lists a package once, whatever the number of its modules and chunks", () => {
        const bundle: Record<string, GraphChunk | GraphAsset> = {
            "index.js": chunk({
                "/repo/node_modules/react/index.js": 400,
                "/repo/node_modules/react/jsx-runtime.js": 100,
                "/repo/frontend/app/app.tsx": 900,
            }),
            "view.js": chunk({ "/repo/node_modules/react/index.js": 0, "/repo/node_modules/clsx/dist/clsx.mjs": 80 }),
            "style.css": { type: "asset" },
        };
        expect([...bundledPackagesOf(bundle, Root).keys()].sort()).toEqual(["node_modules/clsx", "node_modules/react"]);
    });

    it("leaves out a package whose code was all tree-shaken away", () => {
        const bundle = { "index.js": chunk({ "/repo/node_modules/unused/index.js": 0, "/repo/node_modules/used/i.js": 10 }) };
        expect([...bundledPackagesOf(bundle, Root).keys()]).toEqual(["node_modules/used"]);
    });

    it("keeps a package whose style sheet or font is emitted apart from the code", () => {
        const bundle = {
            "index.js": chunk({
                "/repo/node_modules/@xterm/xterm/css/xterm.css": 0,
                "/repo/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2": 0,
                "/repo/node_modules/dev-only/index.js": 0,
            }),
        };
        expect([...bundledPackagesOf(bundle, Root).keys()].sort()).toEqual([
            "node_modules/@xterm/xterm",
            "node_modules/katex",
        ]);
    });
});

describe("manifestOf", () => {
    it("sorts by folder and keeps one entry per folder", () => {
        const manifest = manifestOf("renderer", [
            { name: "b", dir: "node_modules/b" },
            { name: "a", dir: "node_modules/a" },
            { name: "b", dir: "node_modules/b" },
        ]);
        expect(manifest).toEqual({
            target: "renderer",
            packages: [
                { name: "a", dir: "node_modules/a" },
                { name: "b", dir: "node_modules/b" },
            ],
        });
    });
});

describe("moltentermBundledPackages", () => {
    let root: string;
    beforeEach(() => {
        resetBundledPackages();
        root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-bundled-"));
    });
    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const manifestFile = (target: string) => path.join(root, GraphDir, `${target}.json`);
    const run = (target: string, modules: Record<string, number>, options?: { root?: string }) => {
        const plugin = moltentermBundledPackages(target, options);
        plugin.configResolved({ root });
        plugin.generateBundle(null, { "index.js": chunk(modules) });
    };

    it("writes the manifest of its target under the repository root", () => {
        run("main", { [`${root}/node_modules/ws/index.js`]: 10 });
        expect(JSON.parse(fs.readFileSync(manifestFile("main"), "utf8"))).toEqual({
            target: "main",
            packages: [{ name: "ws", dir: "node_modules/ws" }],
        });
    });

    it("merges the bundles of one target, the renderer and its workers each having a plugin of their own", () => {
        run("renderer", { [`${root}/node_modules/react/index.js`]: 10 });
        run("renderer", { [`${root}/node_modules/monaco-editor/esm/vs/editor/editor.worker.js`]: 10 });
        expect(JSON.parse(fs.readFileSync(manifestFile("renderer"), "utf8")).packages.map((p: { name: string }) => p.name)).toEqual([
            "monaco-editor",
            "react",
        ]);
    });

    it("writes the same bytes for the same bundle", () => {
        run("preload", { [`${root}/node_modules/debug/src/browser.js`]: 10, [`${root}/node_modules/ms/index.js`]: 10 });
        const first = fs.readFileSync(manifestFile("preload"), "utf8");
        resetBundledPackages();
        run("preload", { [`${root}/node_modules/ms/index.js`]: 10, [`${root}/node_modules/debug/src/browser.js`]: 10 });
        expect(fs.readFileSync(manifestFile("preload"), "utf8")).toBe(first);
    });

    it("measures its folders from the repository root it is given when the build sits in a subfolder", () => {
        const nested = path.join(root, "tsunami", "frontend");
        const plugin = moltentermBundledPackages("tsunami", { root });
        plugin.configResolved({ root: nested });
        plugin.generateBundle(null, { "index.js": chunk({ [`${root}/node_modules/recharts/es6/index.js`]: 10 }) });
        expect(JSON.parse(fs.readFileSync(manifestFile("tsunami"), "utf8")).packages).toEqual([
            { name: "recharts", dir: "node_modules/recharts" },
        ]);
    });

    it("applies to builds only, never to the dev server", () => {
        expect(moltentermBundledPackages("main").apply).toBe("build");
    });
});
