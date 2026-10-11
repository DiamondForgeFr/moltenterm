// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Lean renderer bundle (FR-PERF-007, DS-PERF-006): every tab view, including the hot spare, parses and evaluates the
// entry chunk and everything it imports statically (index.html modulepreloads exactly that set). The heavy libraries
// below must stay behind a dynamic import at the view that needs them; one static import from the entry graph pulls
// megabytes back into every tab view, so the renderer build fails instead of shipping it.

export const HeavyPackages = [
    "monaco-editor",
    "monaco-yaml",
    "@monaco-editor",
    "shiki",
    "@shiki",
    "mermaid",
    "@mermaid-js",
    "katex",
    "cytoscape",
    "streamdown",
];

const HeavyChunkNameRegex = /^(monaco|shiki|mermaid|katex|cytoscape|streamdown)[-._]/;

export type GuardChunk = {
    type: "chunk";
    fileName: string;
    isEntry: boolean;
    imports: string[];
    moduleIds: string[];
};

export type GuardAsset = { type: "asset"; fileName: string };

export type HeavyHit = { chunk: string; pkg: string; moduleId: string };

export function heavyPackageOf(moduleId: string): string {
    const p = moduleId.replace(/\\/g, "/");
    const idx = p.lastIndexOf("/node_modules/");
    if (idx === -1) {
        return null;
    }
    const rest = p.slice(idx + "/node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    for (const heavy of HeavyPackages) {
        if (name === heavy || name.startsWith(heavy + "/") || name.startsWith(heavy + "-")) {
            return heavy;
        }
    }
    return null;
}

// The chunks every page loading the entry evaluates: the entries and their static imports, transitively.
export function entryStaticChunks(bundle: Record<string, GuardChunk | GuardAsset>): GuardChunk[] {
    const seen = new Set<string>();
    const queue = Object.values(bundle)
        .filter((c): c is GuardChunk => c.type === "chunk" && c.isEntry)
        .map((c) => c.fileName);
    const out: GuardChunk[] = [];
    while (queue.length > 0) {
        const name = queue.shift();
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        const chunk = bundle[name];
        if (chunk?.type !== "chunk") {
            continue;
        }
        out.push(chunk);
        queue.push(...chunk.imports);
    }
    return out;
}

export function findHeavyInEntryGraph(bundle: Record<string, GuardChunk | GuardAsset>): HeavyHit[] {
    const hits = new Map<string, HeavyHit>();
    for (const chunk of entryStaticChunks(bundle)) {
        for (const moduleId of chunk.moduleIds) {
            const pkg = heavyPackageOf(moduleId);
            if (pkg && !hits.has(`${chunk.fileName}|${pkg}`)) {
                hits.set(`${chunk.fileName}|${pkg}`, { chunk: chunk.fileName, pkg, moduleId });
            }
        }
    }
    return [...hits.values()];
}

// The built index.html must not modulepreload a chunk named after a heavy library (FR-PERF-007-AC4).
export function heavyModulePreloads(html: string): string[] {
    const out: string[] = [];
    for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) {
        const file = m[1].split("/").pop();
        if (HeavyChunkNameRegex.test(file)) {
            out.push(m[1]);
        }
    }
    return out;
}

type RollupOutputChunk = {
    type: "chunk";
    fileName: string;
    isEntry: boolean;
    imports: string[];
    modules: Record<string, unknown>;
};
type RollupOutputAsset = { type: "asset"; fileName: string; source: string | Uint8Array };

// Vite plugin for the renderer build. In dev (no bundle) it does nothing.
export function moltentermEntryGuard() {
    return {
        name: "moltenterm-entry-guard",
        apply: "build" as const,
        enforce: "post" as const,
        generateBundle(_options: unknown, bundle: Record<string, RollupOutputChunk | RollupOutputAsset>) {
            const view: Record<string, GuardChunk | GuardAsset> = {};
            for (const [name, item] of Object.entries(bundle)) {
                view[name] =
                    item.type === "chunk"
                        ? {
                              type: "chunk",
                              fileName: item.fileName,
                              isEntry: item.isEntry,
                              imports: item.imports,
                              moduleIds: Object.keys(item.modules),
                          }
                        : { type: "asset", fileName: item.fileName };
            }
            const problems = findHeavyInEntryGraph(view).map(
                (h) => `${h.pkg} is in ${h.chunk}, statically imported by the entry (first module: ${h.moduleId})`
            );
            for (const item of Object.values(bundle)) {
                if (item.type === "asset" && item.fileName.endsWith(".html")) {
                    const html = typeof item.source === "string" ? item.source : new TextDecoder().decode(item.source);
                    for (const href of heavyModulePreloads(html)) {
                        problems.push(`${item.fileName} modulepreloads ${href}`);
                    }
                }
            }
            if (problems.length > 0) {
                (this as { error: (msg: string) => never }).error(
                    "FR-PERF-007: heavy libraries must load on demand (dynamic import at the view boundary):\n  " +
                        problems.join("\n  ")
                );
            }
        },
    };
}
