// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "electron-vite";
import { ViteImageOptimizer } from "vite-plugin-image-optimizer";
import svgr from "vite-plugin-svgr";
import tsconfigPaths from "vite-tsconfig-paths";
import { makeMoltentermBuildChanges, makeMoltentermBuildInfo } from "./frontend/moltenterm-shell/build/build-info"; // MOLTENTERM-PATCH (#55, #187)
import { moltentermCapRadius } from "./frontend/moltenterm-shell/build/cap-radius"; // MOLTENTERM-PATCH (#48)
import { moltentermEntryGuard } from "./frontend/moltenterm-shell/build/entry-guard"; // MOLTENTERM-PATCH (#453)

// from our electron build
const CHROME = "chrome140";
const NODE = "node22";

// for debugging
// target is like -- path.resolve(__dirname, "frontend/app/workspace/workspace-layout-model.ts");
function whoImportsTarget(target: string) {
    return {
        name: "who-imports-target",
        buildEnd() {
            // Build reverse graph: child -> [importers...]
            const parents = new Map<string, string[]>();
            for (const id of (this as any).getModuleIds()) {
                const info = (this as any).getModuleInfo(id);
                if (!info) continue;
                for (const child of [...info.importedIds, ...info.dynamicallyImportedIds]) {
                    const arr = parents.get(child) ?? [];
                    arr.push(id);
                    parents.set(child, arr);
                }
            }

            // Walk upward from TARGET and print paths to entries
            const entries = [...parents.keys()].filter((id) => {
                const m = (this as any).getModuleInfo(id);
                return m?.isEntry;
            });

            const seen = new Set<string>();
            const stack: string[] = [];
            const dfs = (node: string) => {
                if (seen.has(node)) return;
                seen.add(node);
                stack.push(node);
                const ps = parents.get(node) || [];
                if (ps.length === 0) {
                    // hit a root (likely main entry or plugin virtual)
                    console.log("\nImporter chain:");
                    stack
                        .slice()
                        .reverse()
                        .forEach((s) => console.log("  ↳", s));
                } else {
                    for (const p of ps) dfs(p);
                }
                stack.pop();
            };

            if (!parents.has(target)) {
                console.log(`[who-imports] TARGET not in MAIN graph: ${target}`);
            } else {
                dfs(target);
            }
        },
        async resolveId(id: any, importer: any) {
            const r = await (this as any).resolve(id, importer, { skipSelf: true });
            if (r?.id === target) {
                console.log(`[resolve] ${importer} -> ${id} -> ${r.id}`);
            }
            return null;
        },
    };
}

export default defineConfig({
    main: {
        root: ".",
        build: {
            target: NODE,
            rollupOptions: {
                input: {
                    index: "emain/emain.ts",
                },
            },
            outDir: "dist/main",
            externalizeDeps: false,
        },
        plugins: [tsconfigPaths()],
        resolve: {
            alias: {
                "@": "frontend",
            },
        },
        server: {
            open: false,
        },
        define: {
            "process.env.WS_NO_BUFFER_UTIL": "true",
            "process.env.WS_NO_UTF_8_VALIDATE": "true",
            // MOLTENTERM-PATCH (#191): the main process names the app after its channel (MoltenTerm Gold).
            __MOLTENTERM_CHANNEL__: JSON.stringify(makeMoltentermBuildInfo().channel),
        },
    },
    preload: {
        root: ".",
        build: {
            target: NODE,
            sourcemap: true,
            rollupOptions: {
                input: {
                    index: "emain/preload.ts",
                    "preload-webview": "emain/preload-webview.ts",
                },
                output: {
                    format: "cjs",
                },
            },
            outDir: "dist/preload",
            externalizeDeps: false,
        },
        server: {
            open: false,
        },
        plugins: [tsconfigPaths()],
    },
    renderer: {
        root: ".",
        // MOLTENTERM-PATCH (#55): the build facts the status bar shows; (#187) the changes the version history lists,
        // a define of their own so that only the history's lazy chunk carries them
        define: {
            __MOLTENTERM_BUILD__: JSON.stringify(makeMoltentermBuildInfo()),
            __MOLTENTERM_BUILD_CHANGES__: JSON.stringify(makeMoltentermBuildChanges()),
        },
        build: {
            target: CHROME,
            sourcemap: true,
            outDir: "dist/frontend",
            rollupOptions: {
                input: {
                    index: "index.html",
                },
                // MOLTENTERM-PATCH (#453): no manualChunks. Merging monaco, shiki, mermaid, cytoscape and katex into
                // named chunks made the entry import (and index.html modulepreload) about 30 MB that every tab view
                // evaluated; left to Rollup they stay on-demand chunks behind the views' dynamic imports.
            },
        },
        optimizeDeps: {
            include: ["monaco-yaml/yaml.worker.js"],
        },
        server: {
            open: false,
            watch: {
                ignored: [
                    "dist/**",
                    "**/*.go",
                    "**/go.mod",
                    "**/go.sum",
                    "**/*.md",
                    "**/*.mdx",
                    "**/*.json",
                    "**/emain/**",
                    "**/*.txt",
                    "**/*.log",
                ],
            },
        },
        css: {
            // MOLTENTERM-PATCH (#48): no corner above 3 px in the built CSS
            postcss: { plugins: [moltentermCapRadius()] },
            preprocessorOptions: {
                scss: {
                    silenceDeprecations: ["mixed-decls"],
                },
            },
        },
        plugins: [
            tsconfigPaths(),
            { ...ViteImageOptimizer(), apply: "build" },
            svgr({
                svgrOptions: { exportType: "default", ref: true, svgo: false, titleProp: true },
                include: "**/*.svg",
            }),
            react({}),
            tailwindcss(),
            moltentermEntryGuard(), // MOLTENTERM-PATCH (#453): fails the build when the entry pulls a heavy library
        ],
    },
});
