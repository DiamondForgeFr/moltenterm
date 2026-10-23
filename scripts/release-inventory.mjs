// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { contextFromEnv, releasePolicy, validateContext } from "./release-policy.mjs";

export const MAC_EVIDENCE = "macos-verification.json";
export const CHECKSUMS = "SHA256SUMS.txt";
export function payloadNames(context) {
    const { version, productName, packageName } = validateContext(context);
    const mac = ["arm64", "x64"].flatMap((arch) =>
        ["dmg", "zip", "dmg.blockmap", "zip.blockmap"].map((ext) => `${productName}-darwin-${arch}-${version}.${ext}`)
    );
    return [
        ...mac,
        ...["x86_64", "arm64"].map((arch) => `${packageName}-linux-${arch}-${version}.AppImage`),
        ...["amd64", "arm64"].map((arch) => `${packageName}-linux-${arch}-${version}.deb`),
        "latest-mac.yml",
        "latest-linux.yml",
        "latest-linux-arm64.yml",
    ].sort();
}
export function macPayloadNames(context) {
    return payloadNames(context).filter((name) => name.includes("-darwin-") || name === "latest-mac.yml");
}
export async function digest(file, algorithm = "sha256", encoding = "hex") {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || !stat.size) throw new Error("Release payloads must be nonempty regular files");
    const hash = createHash(algorithm);
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return { hash: hash.digest(encoding), size: stat.size };
}
async function records(folder, names) {
    const result = {};
    for (const name of names) result[name] = await digest(path.join(folder, name));
    return result;
}
export async function writeMacEvidence(folder, context, { teamId }) {
    validateContext(context);
    if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Expected verified Apple team identity");
    const evidence = {
        schema: 1,
        context,
        teamId,
        appId: "fr.diamondforge.moltenterm",
        signing: "developer-id",
        verification: { apps: true, dmgs: true, notarized: true, stapled: true },
        files: await records(folder, macPayloadNames(context)),
    };
    await fs.writeFile(path.join(folder, MAC_EVIDENCE), `${JSON.stringify(evidence, null, 4)}\n`, { flag: "wx" });
    return evidence;
}
export async function verifyMacEvidence(folder, context) {
    await digest(path.join(folder, MAC_EVIDENCE));
    const evidence = JSON.parse(await fs.readFile(path.join(folder, MAC_EVIDENCE), "utf8"));
    if (
        evidence.schema !== 1 ||
        evidence.signing !== "developer-id" ||
        evidence.appId !== "fr.diamondforge.moltenterm" ||
        !/^[A-Z0-9]{10}$/.test(evidence.teamId ?? "") ||
        JSON.stringify(evidence.verification) !==
            JSON.stringify({ apps: true, dmgs: true, notarized: true, stapled: true }) ||
        Object.keys(context).some((key) => evidence.context?.[key] !== context[key]) ||
        Object.keys(evidence.context ?? {}).length !== Object.keys(context).length ||
        JSON.stringify(evidence.files) !== JSON.stringify(await records(folder, macPayloadNames(context)))
    )
        throw new Error("macOS verification evidence does not match this release and its final payloads");
}
async function verifyFeeds(folder, context) {
    const expected = {
        "latest-mac.yml": macPayloadNames(context).filter((name) => /\.(dmg|zip)$/.test(name)),
        "latest-linux.yml": payloadNames(context).filter((name) => /-x86_64-.*\.AppImage$/.test(name)),
        "latest-linux-arm64.yml": payloadNames(context).filter((name) => /-arm64-.*\.AppImage$/.test(name)),
    };
    for (const [feed, names] of Object.entries(expected)) {
        const doc = parse(await fs.readFile(path.join(folder, feed), "utf8"), { uniqueKeys: true });
        if (
            !doc ||
            doc.version !== context.version ||
            !Array.isArray(doc.files) ||
            doc.files.length !== names.length ||
            "packages" in doc ||
            "sha2" in doc
        )
            throw new Error("Invalid release update metadata");
        const seen = new Set();
        for (const entry of doc.files) {
            if (!entry || !names.includes(entry.url) || seen.has(entry.url))
                throw new Error("Unknown or duplicate update metadata payload");
            seen.add(entry.url);
            const actual = await digest(path.join(folder, entry.url), "sha512", "base64");
            if (entry.sha512 !== actual.hash || (entry.size != null && entry.size !== actual.size))
                throw new Error("Update metadata does not describe the final payload bytes");
            if ("blockMapSize" in entry) {
                // The pinned builder appends AppImage blockmaps followed by a four-byte big-endian length.
                // macOS uses separate sidecars instead; its metadata must never claim an embedded map.
                if (
                    !entry.url.endsWith(".AppImage") ||
                    !Number.isSafeInteger(entry.blockMapSize) ||
                    entry.blockMapSize <= 0 ||
                    entry.blockMapSize > 0xffffffff ||
                    entry.blockMapSize + 4 >= actual.size
                )
                    throw new Error("Invalid embedded update blockmap size");
                const handle = await fs.open(path.join(folder, entry.url), "r");
                try {
                    const trailer = Buffer.alloc(4);
                    const { bytesRead } = await handle.read(trailer, 0, 4, actual.size - 4);
                    if (bytesRead !== 4 || trailer.readUInt32BE(0) !== entry.blockMapSize)
                        throw new Error("Embedded update blockmap size does not match the final payload");
                } finally {
                    await handle.close();
                }
            }
        }
        const legacy = doc.files.find((entry) => entry.url === doc.path);
        if (!legacy || legacy.sha512 !== doc.sha512) throw new Error("Inconsistent legacy update metadata");
    }
}
export async function validateInventory(folder, context, { signed = false, checksums = false, macosSigning } = {}) {
    const policy = releasePolicy(context);
    if (policy.requireDeveloperId && macosSigning !== "developer-id")
        throw new Error("Public publication requires verified Developer ID output");
    const names = payloadNames(context);
    const entries = await fs.readdir(folder);
    const evidence = entries.includes(MAC_EVIDENCE);
    if (evidence) names.push(MAC_EVIDENCE);
    if (policy.requireDeveloperId && !evidence)
        throw new Error("Public publication requires final macOS verification evidence");
    if (signed) {
        names.push(
            `${CHECKSUMS}.asc`,
            ...payloadNames(context)
                .filter((name) => /\.(AppImage|deb)$/.test(name))
                .map((name) => `${name}.asc`)
        );
    }
    if (checksums) names.push(CHECKSUMS);
    if (entries.length !== names.length || entries.some((name) => !names.includes(name)))
        throw new Error("Missing or unexpected release inventory entry");
    for (const name of names) await digest(path.join(folder, name));
    await verifyFeeds(folder, context);
    if (evidence) await verifyMacEvidence(folder, context);
    return names.sort();
}
export async function writeChecksums(folder, context, options = {}) {
    const entries = await fs.readdir(folder);
    const names = (
        await validateInventory(folder, context, {
            ...options,
            signed: entries.includes(`${CHECKSUMS}.asc`),
            checksums: entries.includes(CHECKSUMS),
        })
    ).filter((name) => name !== CHECKSUMS && !name.endsWith(".asc"));
    const lines = [];
    for (const name of names) lines.push(`${(await digest(path.join(folder, name))).hash}  ${name}\n`);
    await fs.writeFile(path.join(folder, CHECKSUMS), lines.join(""));
}
export async function verifyChecksums(folder, context, options) {
    const names = await validateInventory(folder, context, { ...options, checksums: true });
    const covered = names.filter((name) => name !== CHECKSUMS && !name.endsWith(".asc"));
    let expected = "";
    for (const name of covered) expected += `${(await digest(path.join(folder, name))).hash}  ${name}\n`;
    if ((await fs.readFile(path.join(folder, CHECKSUMS), "utf8")) !== expected)
        throw new Error("Checksum coverage or final release bytes do not match");
    return names;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await writeChecksums(process.argv[2], await contextFromEnv(process.env, { allowLocal: true }), {
            macosSigning: process.env.MACOS_SIGNING,
        });
    } catch (error) {
        console.error(`::error::${error.message}`);
        process.exitCode = 1;
    }
}
