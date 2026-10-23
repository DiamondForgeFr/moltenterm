// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { embeddedInventory, verifyApp } from "./artifacts.mjs";
import { ARCHES, assertWithin, localArtifactName } from "./policy.mjs";
import { command } from "./session.mjs";

// Electron already locks this native extractor. Its internal API is deliberately version-bound, like the
// blockmap adapter: it validates archive paths before writing and creates contained symlinks after files.
export async function extractDeliveryZip(file, dir) {
    const url = import.meta.resolve("@electron-internal/extract-zip");
    const pkg = JSON.parse(await fs.readFile(new URL("package.json", url), "utf8"));
    if (pkg.version !== "1.0.5") throw new Error("Unsupported delivery ZIP extractor");
    const { extract } = await import(url);
    await extract(file, { dir });
}

// Do not follow links during enumeration. Framework links are legitimate, but must resolve inside this app.
async function auditTree(root) {
    async function walk(dir) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) assertWithin(root, await fs.realpath(file));
            else if (entry.isDirectory()) await walk(file);
            else if (!entry.isFile()) throw new Error("Unexpected delivery file type");
        }
    }
    await walk(root);
}

async function verifyPayload(root, arch, version, productName, inputs, run) {
    const app = path.join(root, `${productName}.app`);
    if (!(await fs.lstat(app)).isDirectory()) throw new Error("Missing regular delivery app directory");
    const names = await fs.readdir(root);
    if (names.filter((name) => name.endsWith(".app")).length !== 1) throw new Error("Unexpected delivery app");
    await auditTree(app);
    const executable = path.join(app, "Contents/MacOS", productName);
    if (!(await fs.lstat(executable)).isFile()) throw new Error("Missing regular app executable");
    const native = await run("/usr/bin/lipo", ["-archs", executable]);
    if (native.stdout.trim() !== (arch === "arm64" ? "arm64" : "x86_64"))
        throw new Error("Delivery app architecture mismatch");
    const inventory = await embeddedInventory(app, version, arch);
    for (const binary of inventory.darwin) {
        const output = await run("/usr/bin/lipo", ["-archs", binary]);
        if (output.stdout.trim() !== (path.basename(binary).endsWith("arm64") ? "arm64" : "x86_64"))
            throw new Error("Delivery helper architecture mismatch");
    }
    await verifyApp(app, inputs, { run });
}

// Verification only: no signing, notarization, metadata changes or credentials are needed here.
// Call only after final DMG stapling, before publishing. Local/RC packaging remains unchanged unless opted in.
export async function verifyDeliveryArtifacts(
    manifest,
    inputs,
    { run = command, extractZip = extractDeliveryZip, tempRoot = os.tmpdir(), productName = "MoltenTerm" } = {}
) {
    let owned,
        mounted,
        failure,
        stage = "layout";
    try {
        if (!/^[A-Za-z0-9]+$/.test(productName)) throw new Error("Invalid delivery product name");
        const root = await fs.realpath(manifest.outDir);
        const expected = ARCHES.flatMap((arch) =>
            ["zip", "dmg"].map((ext) => ({
                arch,
                ext,
                name: localArtifactName(`${productName}-darwin-${arch}-${manifest.version}.${ext}`),
            }))
        );
        if (manifest.artifacts.length !== expected.length) throw new Error("Missing delivery artifacts");
        const files = new Map();
        for (const file of manifest.artifacts) {
            if (!(await fs.lstat(file)).isFile()) throw new Error("Delivery artifact must be regular");
            const resolved = assertWithin(root, await fs.realpath(file));
            const name = path.basename(resolved);
            if (files.has(name) || !expected.some((item) => item.name === name))
                throw new Error("Unexpected delivery artifact");
            files.set(name, resolved);
        }
        owned = await fs.mkdtemp(path.join(await fs.realpath(tempRoot), "moltenterm-delivery-"));
        await fs.chmod(owned, 0o700);
        for (const { arch, ext, name } of expected) {
            stage = `${ext} (${arch})`;
            const dir = path.join(owned, `${ext}-${arch}`);
            await fs.mkdir(dir, { mode: 0o700 });
            if (ext === "zip") {
                await extractZip(files.get(name), dir);
                const names = await fs.readdir(dir);
                if (names.some((entry) => entry !== `${productName}.app` && entry !== "__MACOSX"))
                    throw new Error("Unexpected ZIP root payload");
                await auditTree(dir);
                await verifyPayload(dir, arch, manifest.version, productName, inputs, run);
            } else {
                // An unsuccessful attach may still have mounted the image. Attempt owned-point detach even then.
                mounted = dir;
                try {
                    await run("/usr/bin/hdiutil", [
                        "attach",
                        "-nobrowse",
                        "-noautoopen",
                        "-readonly",
                        "-mountpoint",
                        dir,
                        files.get(name),
                    ]);
                    await verifyPayload(dir, arch, manifest.version, productName, inputs, run);
                } finally {
                    await run("/usr/bin/hdiutil", ["detach", dir]);
                    mounted = undefined;
                }
            }
        }
    } catch {
        failure = new Error(`Final macOS delivery verification failed at: ${stage}`);
    } finally {
        // Never recursively remove a directory that might still be a mounted filesystem.
        if (mounted) failure = new Error("Final macOS delivery verification failed at: cleanup");
        else if (owned) {
            try {
                await fs.rm(owned, { recursive: true, force: true });
            } catch {
                failure = new Error("Final macOS delivery verification failed at: cleanup");
            }
        }
    }
    if (failure) throw failure;
}
