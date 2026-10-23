// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import console from "node:console";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import { CHECKSUMS, digest, verifyChecksums } from "./release-inventory.mjs";
import { contextFromEnv, releasePolicy } from "./release-policy.mjs";

const exec = promisify(execFile);
export async function verifySignatures(folder, names, publicKey, { run = exec } = {}) {
    publicKey = publicKey instanceof URL ? fileURLToPath(publicKey) : publicKey;
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "mt-verify-"));
    try {
        await fs.chmod(temporary, 0o700);
        const common = ["--homedir", temporary, "--batch", "--no-options"];
        const shown = await run("gpg", [
            ...common,
            "--with-colons",
            "--import-options",
            "show-only",
            "--import",
            publicKey,
        ]);
        if (shown.stdout.split("\n").filter((line) => line.startsWith("pub:")).length !== 1)
            throw new Error("Expected exactly one committed release public key");
        const keyring = path.join(temporary, "public.gpg");
        await run("gpg", [...common, "--dearmor", "--output", keyring, publicKey]);
        for (const name of names.filter((name) => name.endsWith(".asc"))) {
            await run("gpgv", [
                "--homedir",
                temporary,
                "--keyring",
                keyring,
                path.join(folder, name),
                path.join(folder, name.slice(0, -4)),
            ]);
        }
    } catch {
        throw new Error("Final release signatures do not verify against the committed release key");
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

export async function validatePublication(
    folder,
    context,
    { macosSigning, publicKey, verify = verifySignatures } = {}
) {
    const policy = releasePolicy(context);
    const signed = (await fs.readdir(folder)).includes(`${CHECKSUMS}.asc`);
    if (policy.requireChecksumSignature && !signed)
        throw new Error("Public releases require verified checksum signatures");
    const keyExists =
        publicKey &&
        (await fs.stat(publicKey).then(
            (stat) => stat.isFile(),
            () => false
        ));
    if (Boolean(keyExists) !== signed)
        throw new Error("Release signatures and the committed public key must both be present");
    const names = await verifyChecksums(folder, context, { signed, macosSigning });
    if (signed) await verify(folder, names, publicKey);
    return names;
}

// A draft can become public during a run. Never mutate any existing release, including its signatures.
export async function publishRelease({ folder, context, publicKey, macosSigning, remote, verify }) {
    if (context.mode !== "release") throw new Error("Only release mode may publish");
    const names = await validatePublication(folder, context, { publicKey, macosSigning, verify });
    const state = await remote.inspect();
    if (state) {
        if (
            !Array.isArray(state.names) ||
            new Set(state.names).size !== state.names.length ||
            state.names.some((name) => !names.includes(name))
        )
            throw new Error("Existing release contains duplicate or unexpected assets; repair it explicitly");
        if (state.names.length !== names.length)
            throw new Error("Existing release is incomplete; repair it explicitly");
        const existing = await remote.download();
        const actualNames = await fs.readdir(existing);
        if (actualNames.length !== names.length || actualNames.some((name) => !names.includes(name)))
            throw new Error("Downloaded existing inventory differs from release assets; repair it explicitly");
        for (const name of names) {
            const local = await digest(path.join(folder, name)),
                old = await digest(path.join(existing, name));
            if (local.hash !== old.hash || local.size !== old.size)
                throw new Error(
                    "Existing release bytes differ from this run; repair it explicitly; refusing every mutation"
                );
        }
        return { action: "unchanged", names };
    }
    await remote.create(names);
    return { action: "created", names };
}

export async function githubRemote({ folder, context, notes, repo, run = exec }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? ""))
        throw new Error("Explicit release repository is required");
    const tag = `v${context.version}`,
        base = ["--repo", repo];
    let downloadDir;
    return {
        async inspect() {
            try {
                const result = await run("gh", ["release", "view", tag, ...base, "--json", "isDraft,assets"]);
                const state = JSON.parse(result.stdout);
                return { draft: state.isDraft, names: state.assets.map((asset) => asset.name) };
            } catch (error) {
                if (/^release not found\s*$/i.test(error.stderr?.trim() ?? "")) return null;
                throw new Error("Cannot determine existing release state; refusing publication");
            }
        },
        async download() {
            downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "mt-published-"));
            await run("gh", ["release", "download", tag, ...base, "--dir", downloadDir]);
            return downloadDir;
        },
        async create(names) {
            await run("gh", [
                "release",
                "create",
                tag,
                ...base,
                ...names.map((name) => path.join(folder, name)),
                "--verify-tag",
                "--title",
                `MoltenTerm ${tag}`,
                "--notes-file",
                notes,
                ...(context.channel === "rc" ? ["--prerelease", "--latest=false"] : ["--draft"]),
            ]);
        },
        async cleanup() {
            if (downloadDir) await fs.rm(downloadDir, { recursive: true, force: true });
        },
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let remote;
    try {
        if (process.argv[2] === "verify-signatures") {
            const folder = process.argv[3],
                publicKey = process.argv[4];
            if (!folder || !publicKey)
                throw new Error("usage: release-publish.mjs verify-signatures <folder> <public-key>");
            const names = await fs.readdir(folder);
            if (!names.includes(`${CHECKSUMS}.asc`)) throw new Error("Checksum signature is missing");
            await verifySignatures(folder, names, publicKey);
            console.log("Release signatures verified");
        } else {
            const folder = process.argv[2],
                notes = process.argv[3],
                context = await contextFromEnv();
            if (!folder || !notes) throw new Error("usage: release-publish.mjs <folder> <notes-file>");
            remote = await githubRemote({ folder, context, notes, repo: process.env.GH_REPO });
            const result = await publishRelease({
                folder,
                context,
                remote,
                macosSigning: process.env.MACOS_SIGNING,
                publicKey:
                    process.env.MOLTENTERM_RELEASE_PUBLIC_KEY || new URL("../release-signing-key.asc", import.meta.url),
            });
            console.log(`Release publication: ${result.action}`);
        }
    } catch (error) {
        // gh and gpg diagnostics are not part of the public error surface.
        console.error(
            `::error::${error.message.startsWith("Command failed:") ? "Release publication command failed" : error.message}`
        );
        process.exitCode = 1;
    } finally {
        await remote?.cleanup();
    }
}
