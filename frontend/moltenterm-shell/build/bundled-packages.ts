// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The npm packages a build really ships (#2126). The licence of a package travels with the code that ships, so the
// notices follow the bundler's module graph: a package is listed when one of its modules has rendered code in an output
// chunk. Packages the lockfile holds for development, and modules tree-shaken away, never appear. The build writes one
// manifest per target (dist/licenses/graph/<target>.json); scripts/moltenterm-notices.mjs reads them next to the Go
// modules, finds each package's licence and writes THIRD-PARTY-NOTICES.txt.

import fs from "node:fs";
import path from "node:path";

export type BundledPackage = {
    name: string;
    // The package folder, from the repository root, with forward slashes.
    dir: string;
};

export type GraphManifest = {
    target: string;
    packages: BundledPackage[];
};

export type GraphModule = { renderedLength: number };
export type GraphChunk = { type: "chunk"; modules: Record<string, GraphModule> };
export type GraphAsset = { type: "asset" };

export const GraphDir = "dist/licenses/graph";

const NodeModules = "/node_modules/";
// Stylesheets and other files a module stands for: their content is emitted as an asset, so the module itself renders nothing.
const AssetExtensions = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot)$/i;
// Rollup's virtual modules carry the code of the bundler that wrote them (the preload helper is Vite's, MIT).
const VirtualPackages: Array<[string, string]> = [["\0vite/", "vite"]];

export type PackageRef = { name: string; dir: string };

// The package a module id belongs to, or null for the project's own files. `root` is the repository root, in forward slashes.
export function packageOfModule(moduleId: string, root: string): PackageRef {
    for (const [prefix, name] of VirtualPackages) {
        if (moduleId.startsWith(prefix)) {
            return { name, dir: `node_modules/${name}` };
        }
    }
    // Plugins wrap a file's id: "\0<path>?commonjs-module", "\0commonjs-proxy:<path>". The path is what counts.
    const p = moduleId
        .replace(/\\/g, "/")
        .replace(/\0/g, "")
        .replace(/^[a-z][a-z-]+:(?=\/)/, "");
    const idx = p.lastIndexOf(NodeModules);
    if (idx === -1) {
        return null;
    }
    const rest = p.slice(idx + NodeModules.length).split("/");
    const scoped = rest[0].startsWith("@");
    const name = (scoped ? `${rest[0]}/${rest[1] ?? ""}` : rest[0]).replace(/\?.*$/, "");
    if (name === "" || name.endsWith("/")) {
        return null;
    }
    const folder = p.slice(0, idx + NodeModules.length) + name;
    const rooted = root.endsWith("/") ? root : `${root}/`;
    const dir = folder.startsWith(rooted) ? folder.slice(rooted.length) : folder;
    return { name, dir };
}

// Whether the module contributes to what ships: code that survived tree-shaking, or a file whose content is emitted apart.
function ships(moduleId: string, module: GraphModule): boolean {
    if (module.renderedLength > 0) {
        return true;
    }
    return AssetExtensions.test(moduleId.replace(/\?.*$/, ""));
}

export function bundledPackagesOf(
    bundle: Record<string, GraphChunk | GraphAsset>,
    root: string
): Map<string, BundledPackage> {
    const found = new Map<string, BundledPackage>();
    for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") {
            continue;
        }
        for (const [moduleId, module] of Object.entries(item.modules)) {
            if (!ships(moduleId, module)) {
                continue;
            }
            const pkg = packageOfModule(moduleId, root);
            if (pkg != null && !found.has(pkg.dir)) {
                found.set(pkg.dir, pkg);
            }
        }
    }
    return found;
}

export function manifestOf(target: string, packages: Iterable<BundledPackage>): GraphManifest {
    const byDir = new Map<string, BundledPackage>();
    for (const pkg of packages) {
        byDir.set(pkg.dir, { name: pkg.name, dir: pkg.dir });
    }
    return {
        target,
        packages: [...byDir.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)),
    };
}

// A target is built by several bundles when it has workers (Vite bundles each worker apart, with its own plugin
// instance): the instances of one target share what they found, and each one writes the union.
const FoundByTarget = new Map<string, Map<string, BundledPackage>>();

export function resetBundledPackages() {
    FoundByTarget.clear();
}

type OutputBundle = Record<string, GraphChunk | GraphAsset>;

// Rollup plugin for a build of Electron main, the preload, the renderer or the tsunami scaffold. It only records. The
// folders are from the repository root, which is the build's root unless the build sits in a folder of the repository
// (the scaffold's) and says where the root is.
export function moltentermBundledPackages(target: string, options: { root?: string } = {}) {
    let root = options.root ?? process.cwd();
    return {
        name: "moltenterm-bundled-packages",
        apply: "build" as const,
        enforce: "post" as const,
        configResolved(config: { root: string }) {
            root = options.root ?? config.root;
        },
        generateBundle(_options: unknown, bundle: OutputBundle) {
            const known = FoundByTarget.get(target) ?? new Map<string, BundledPackage>();
            FoundByTarget.set(target, known);
            for (const [dir, pkg] of bundledPackagesOf(bundle, root.replace(/\\/g, "/"))) {
                known.set(dir, pkg);
            }
            const outDir = path.join(root, GraphDir);
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(
                path.join(outDir, `${target}.json`),
                JSON.stringify(manifestOf(target, known.values()), null, 2) + "\n"
            );
        },
    };
}
