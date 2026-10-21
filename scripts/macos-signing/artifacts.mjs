// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
    ARCHES,
    appleRequirement,
    assertWithin,
    binaryFormat,
    checkedSignature,
    embeddedKind,
    embeddedNames,
    localArtifactName,
} from "./policy.mjs";
import { command } from "./session.mjs";

export async function hashFile(file) {
    const hash = createHash("sha512");
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return { sha512: hash.digest("base64"), size: (await fs.stat(file)).size };
}

export async function formatOf(file) {
    const handle = await fs.open(file, "r");
    try {
        const header = Buffer.alloc(4);
        const { bytesRead } = await handle.read(header, 0, 4, 0);
        return binaryFormat(header.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
}

export async function embeddedInventory(app, version, arch) {
    if (!ARCHES.includes(arch)) throw new Error("Unsupported app architecture");
    const root = await fs.realpath(app);
    const bin = assertWithin(root, await fs.realpath(path.join(root, "Contents/Resources/app.asar.unpacked/dist/bin")));
    const darwin = [],
        foreign = new Map();
    const names = await fs.readdir(bin),
        expected = new Set(embeddedNames(version, arch));
    if (names.length !== expected.size || names.some((name) => !expected.has(name)))
        throw new Error("Missing or unexpected embedded executable payload");
    for (const name of names) {
        const file = path.join(bin, name);
        if (!(await fs.lstat(file)).isFile()) throw new Error("Embedded binaries must be regular files");
        const kind = embeddedKind(file, version, arch);
        if ((await formatOf(file)) !== (kind === "darwin" ? "macho" : kind))
            throw new Error("Embedded executable format does not match its target");
        if (kind === "darwin") {
            if (!((await fs.stat(file)).mode & 0o111)) throw new Error("Embedded Darwin helper is not executable");
            darwin.push(file);
        } else foreign.set(file, await hashFile(file));
    }
    if (darwin.length !== 5) throw new Error("Expected wavesrv and both Darwin architectures of wsh and molten");
    return { darwin, foreign };
}

export async function assertForeignUnchanged(inventory) {
    for (const [file, before] of inventory.foreign) {
        const after = await hashFile(file);
        if (before.sha512 !== after.sha512 || before.size !== after.size)
            throw new Error("Foreign executable payload changed while signing");
    }
}

async function machFiles(app) {
    const root = await fs.realpath(app),
        files = [];
    async function walk(dir) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                assertWithin(root, await fs.realpath(file));
            } else if (entry.isDirectory()) await walk(file);
            else if (entry.isFile() && (await formatOf(file)) === "macho") files.push(file);
        }
    }
    await walk(root);
    return files;
}

export async function verifySigned(file, inputs, { run = command, runtime = true, app = false } = {}) {
    await run("/usr/bin/codesign", ["--verify", "--strict", "-R", appleRequirement(inputs.teamId), file]);
    const display = await run("/usr/bin/codesign", ["--display", "--verbose=4", file]);
    checkedSignature(`${display.stdout}\n${display.stderr}\n`, inputs, { runtime, app });
    if (runtime) {
        const raw = await run("/usr/bin/codesign", ["--display", "--entitlements", ":-", file]);
        const parsed = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: raw.stdout });
        const entitlements = JSON.parse(parsed.stdout);
        if (
            !entitlements ||
            Array.isArray(entitlements) ||
            typeof entitlements !== "object" ||
            ("com.apple.security.get-task-allow" in entitlements &&
                entitlements["com.apple.security.get-task-allow"] !== false) ||
            entitlements["com.apple.security.app-sandbox"] ||
            entitlements["com.apple.security.cs.allow-dyld-environment-variables"]
        ) {
            throw new Error("Unsafe distribution entitlements");
        }
    }
}

export async function verifyApp(app, inputs, { run = command } = {}) {
    for (const file of await machFiles(app)) await verifySigned(file, inputs, { run });
    await verifySigned(app, inputs, { run, app: true });
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    await run("/usr/bin/xcrun", ["stapler", "validate", app]);
    await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
}

// Update only local entries whose bytes changed. Leave the builder's ZIP ordering and release fields intact.
export async function refreshMetadata(files, artifacts, changed, { yaml, buildBlockMap }) {
    const expected = new Map(artifacts.map((file) => [localArtifactName(path.basename(file)), file]));
    if (expected.size !== artifacts.length) throw new Error("Duplicate artifact basenames");
    const hashes = new Map();
    for (const [name, file] of expected) hashes.set(name, await hashFile(file));
    for (const file of changed) {
        const name = path.basename(file);
        if (expected.get(name) !== file || !name.endsWith(".dmg")) throw new Error("Unexpected changed artifact");
        const info = await buildBlockMap(file, "gzip", `${file}.blockmap`);
        const actual = hashes.get(name);
        if (
            info.sha512 !== actual.sha512 ||
            info.size !== actual.size ||
            "blockMapSize" in info ||
            !(await fs.stat(`${file}.blockmap`)).size
        ) {
            throw new Error("Blockmap generator did not describe the final artifact");
        }
    }
    const changedNames = new Set(changed.map((file) => path.basename(file))),
        referenced = new Set(),
        writes = [];
    for (const file of files) {
        const doc = yaml.load(await fs.readFile(file, "utf8"));
        if (
            !doc ||
            typeof doc !== "object" ||
            !Array.isArray(doc.files) ||
            !doc.files.length ||
            "packages" in doc ||
            "sha2" in doc
        )
            throw new Error("Unsupported macOS update metadata");
        const seen = new Set();
        for (const entry of doc.files) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid update entry");
            const name = localArtifactName(entry.url),
                actual = hashes.get(name);
            if (!actual || seen.has(name) || "blockMapSize" in entry)
                throw new Error("Unknown, duplicated or unsupported update entry");
            seen.add(name);
            referenced.add(name);
            if (changedNames.has(name)) Object.assign(entry, actual);
            if (entry.sha512 !== actual.sha512 || ("size" in entry && entry.size !== actual.size))
                throw new Error("Update metadata does not match final bytes");
        }
        const legacyName = localArtifactName(doc.path),
            legacy = doc.files.find((entry) => entry.url === legacyName);
        if (seen.size !== expected.size) throw new Error("A release channel is missing an expected artifact");
        if (!legacy) throw new Error("Legacy update path is missing from files");
        if (changedNames.has(legacyName)) doc.sha512 = legacy.sha512;
        if (doc.sha512 !== legacy.sha512) throw new Error("Legacy update hash is inconsistent");
        writes.push([file, yaml.dump(doc)]);
    }
    if (referenced.size !== expected.size) throw new Error("An expected artifact is missing from update metadata");
    // Validate all channels before replacing any. Publication must wait for the enclosing finalizer.
    for (const [file, content] of writes) await fs.writeFile(file, content);
}

export async function finalizeArtifacts(manifest, inputs, { run = command, notarize, yaml, buildBlockMap }) {
    // A fixed label for the failure message: the builder's and Apple's own errors are never shown.
    let stage = "artifact layout";
    try {
        const root = await fs.realpath(manifest.outDir);
        const resolveOwned = async (file) => assertWithin(root, await fs.realpath(file));
        const files = await Promise.all(manifest.artifacts.map(resolveOwned));
        const metadata = await Promise.all(manifest.metadata.map(resolveOwned));
        if (files.length !== 4 || metadata.length === 0 || new Set(files).size !== 4)
            throw new Error("Expected both release formats and architectures");
        for (const arch of ARCHES) {
            if (manifest.apps.filter((app) => app.arch === arch).length !== 1)
                throw new Error("Missing release app architecture");
            const app = manifest.apps.find((app) => app.arch === arch);
            const appPath = await resolveOwned(app.path);
            stage = `embedded inventory (${arch})`;
            const inventory = await embeddedInventory(appPath, manifest.version, arch);
            for (const binary of inventory.darwin) {
                const expectedArch = path.basename(binary).endsWith("arm64") ? "arm64" : "x86_64";
                const output = await run("/usr/bin/lipo", ["-archs", binary]);
                if (output.stdout.trim() !== expectedArch) throw new Error("Embedded helper architecture mismatch");
            }
            stage = `app verification (${arch})`;
            await verifyApp(appPath, inputs, { run });
        }
        stage = "artifact layout";
        if (manifest.apps.length !== 2) throw new Error("Unexpected extra release app");
        const dmgs = files.filter((file) => file.endsWith(".dmg"));
        if (dmgs.length !== 2 || files.filter((file) => file.endsWith(".zip")).length !== 2)
            throw new Error("Unexpected release formats");
        for (const file of dmgs) {
            stage = "disk image signing";
            // Explicit secure timestamp; builder's optional DMG signing alone is insufficient evidence.
            await run("/usr/bin/codesign", [
                "--force",
                "--sign",
                inputs.identity,
                "--keychain",
                inputs.keychain,
                "--timestamp",
                file,
            ]);
            await verifySigned(file, inputs, { run, runtime: false });
            stage = "disk image notarization";
            await notarize(file);
            stage = "disk image ticket";
            await run("/usr/bin/xcrun", ["stapler", "validate", file]);
            await verifySigned(file, inputs, { run, runtime: false });
            stage = "disk image gatekeeper";
            await run("/usr/sbin/spctl", [
                "--assess",
                "--type",
                "open",
                "--context",
                "context:primary-signature",
                "--verbose=4",
                file,
            ]);
        }
        stage = "update metadata";
        await refreshMetadata(metadata, files, dmgs, { yaml, buildBlockMap });
    } catch {
        throw new Error(`Final macOS artifact verification failed at: ${stage}`);
    }
}
