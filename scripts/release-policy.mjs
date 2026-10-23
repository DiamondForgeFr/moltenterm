// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import console from "node:console";
import fs from "node:fs/promises";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

export function releasePolicy({ mode, channel }) {
    if (!["check", "rehearsal", "release"].includes(mode) || !["rc", "public"].includes(channel))
        throw new Error("Explicit release mode (check, rehearsal, release) and channel (rc, public) are required");
    const required = mode === "release" && channel === "public";
    return { mode, channel, requireDeveloperId: required, requireChecksumSignature: required };
}

export function assertMacosPolicy(context, signing) {
    const policy = releasePolicy(context);
    if (!["adhoc", "developer-id"].includes(signing)) throw new Error("Unknown macOS signing mode");
    if (policy.mode !== "release" && signing !== "adhoc")
        throw new Error("Rehearsals and checks must not receive macOS signing secrets");
    if (policy.requireDeveloperId && signing !== "developer-id")
        throw new Error("Public releases require Developer ID signing, notarization and stapling");
    return policy;
}

export function assertChecksumInputs(context, { publicKey, privateKey, passphrase }) {
    const policy = releasePolicy(context);
    const present = [publicKey, privateKey, passphrase].map(Boolean);
    if (present.every((value) => !value) && !policy.requireChecksumSignature) return false;
    if (!present.every(Boolean))
        throw new Error("Release checksum signing requires the committed public key, private key and passphrase");
    return true;
}

export function validateContext(context) {
    releasePolicy(context);
    if (
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[1-9]\d*)?$/.test(context.version ?? "") ||
        !/^[a-f0-9]{40}$/.test(context.sha ?? "") ||
        !/^[1-9]\d*$/.test(context.runId ?? "") ||
        !/^[1-9]\d*$/.test(context.runAttempt ?? "") ||
        !/^[A-Za-z0-9]+$/.test(context.productName ?? "") ||
        !/^[a-z0-9][a-z0-9-]*$/.test(context.packageName ?? "")
    )
        throw new Error("Invalid release version, commit, run identity or product names");
    if (context.mode === "release" && (context.channel === "rc") !== context.version.includes("-"))
        throw new Error("Release version does not match its channel");
    return context;
}

export async function contextFromEnv(env = process.env, { allowLocal = false } = {}) {
    const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
    const fields = [
        "RELEASE_MODE",
        "RELEASE_CHANNEL",
        "RELEASE_VERSION",
        "RELEASE_SHA",
        "RELEASE_RUN_ID",
        "RELEASE_RUN_ATTEMPT",
    ];
    if (allowLocal && fields.every((field) => env[field] == null)) {
        return validateContext({
            mode: "rehearsal",
            channel: "rc",
            version: pkg.version,
            sha: "0".repeat(40),
            runId: "1",
            runAttempt: "1",
            productName: pkg.productName,
            packageName: pkg.name,
        });
    }
    return validateContext({
        mode: env.RELEASE_MODE,
        channel: env.RELEASE_CHANNEL,
        version: env.RELEASE_VERSION,
        sha: env.RELEASE_SHA,
        runId: env.RELEASE_RUN_ID,
        runAttempt: env.RELEASE_RUN_ATTEMPT,
        productName: pkg.productName,
        packageName: pkg.name,
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const local = process.env.RELEASE_MODE == null && process.env.RELEASE_CHANNEL == null;
        const policy = releasePolicy({
            mode: local ? "rehearsal" : process.env.RELEASE_MODE,
            channel: local ? "rc" : process.env.RELEASE_CHANNEL,
        });
        if (process.argv[2] === "checksum-inputs") {
            const publicKey = await fs
                .stat(
                    process.env.MOLTENTERM_RELEASE_PUBLIC_KEY || new URL("../release-signing-key.asc", import.meta.url)
                )
                .then(
                    (s) => s.isFile(),
                    () => false
                );
            assertChecksumInputs(policy, {
                publicKey,
                privateKey: process.env.RELEASE_GPG_PRIVATE_KEY?.trim(),
                passphrase: process.env.RELEASE_GPG_PASSPHRASE,
            });
        } else if (process.argv[2] === "macos") {
            assertMacosPolicy(policy, process.argv[3]);
        } else throw new Error("usage: release-policy.mjs checksum-inputs | macos <signing-mode>");
    } catch (error) {
        console.error(`::error::${error.message}`);
        process.exitCode = 1;
    }
}
