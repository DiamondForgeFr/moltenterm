// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { checkedIdentity, signingInputs } from "./policy.mjs";

// Never return raw subprocess errors: security argv and notary diagnostics can contain credentials.
export function command(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { input, ...execOptions } = options;
        const child = execFile(file, args, { maxBuffer: 8 * 1024 * 1024, ...execOptions }, (error, stdout, stderr) => {
            if (error) reject(new Error(`Signing command failed: ${path.basename(file)}`));
            else resolve({ stdout, stderr });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input);
    });
}

function keychains(output) {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            if (!/^"[^"\r\n]+"$/.test(line)) throw new Error("Unrecognized keychain-list output");
            return line.slice(1, -1);
        });
}

export async function withSigningSession(
    env,
    body,
    { run = command, platform = process.platform, tempRoot = os.tmpdir(), signals = process } = {}
) {
    const inputs = signingInputs(env, platform);
    const owned = await fs.mkdtemp(path.join(await fs.realpath(tempRoot), "moltenterm-signing-"));
    const certificate = path.join(owned, "certificate.p12");
    const apiKey = path.join(owned, "AuthKey.p8");
    const keychain = path.join(owned, "signing.keychain-db");
    const password = randomBytes(32).toString("base64");
    let initial = [],
        searchChanged = false,
        keychainStarted = false,
        interrupted = false;
    const controller = new globalThis.AbortController();
    let cleaning;
    const security = async (args, isCleanup = false) => {
        try {
            return await run("/usr/bin/security", args, isCleanup ? {} : { signal: controller.signal });
        } catch {
            throw new Error("Signing keychain command failed");
        }
    };
    const cleanup = () =>
        (cleaning ??= (async () => {
            let failed = false;
            if (searchChanged) {
                try {
                    const current = keychains((await security(["list-keychains", "-d", "user"], true)).stdout);
                    const remaining = [...new Set([...current.filter((item) => item !== keychain), ...initial])];
                    await security(["list-keychains", "-d", "user", "-s", ...remaining], true);
                } catch {
                    failed = true;
                }
            }
            if (keychainStarted) {
                try {
                    await security(["delete-keychain", keychain], true);
                } catch {
                    failed = true;
                }
            }
            try {
                await fs.rm(owned, { recursive: true, force: true });
            } catch {
                failed = true;
            }
            if (failed) throw new Error("Signing session cleanup failed");
        })());
    const onSignal = () => {
        interrupted = true;
        controller.abort();
    };
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);
    try {
        await fs.chmod(owned, 0o700);
        await fs.writeFile(certificate, inputs.certificate, { mode: 0o600 });
        await fs.writeFile(apiKey, inputs.apiKey, { mode: 0o600 });
        initial = keychains((await security(["list-keychains", "-d", "user"])).stdout);
        keychainStarted = true;
        await security(["create-keychain", "-p", password, keychain]);
        await security(["unlock-keychain", "-p", password, keychain]);
        await security(["set-keychain-settings", "-lut", "21600", keychain]);
        searchChanged = true;
        await security(["list-keychains", "-d", "user", "-s", keychain, ...initial]);
        await security(["import", certificate, "-k", keychain, "-P", inputs.password, "-T", "/usr/bin/codesign"]);
        await security(["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain]);
        checkedIdentity((await security(["find-identity", "-v", "-p", "codesigning", keychain])).stdout, inputs);
        await fs.unlink(certificate);
        // `security create-keychain` leaves the file world-readable (0644), which the sign hook rightly refuses (#880).
        await fs.chmod(keychain, 0o600);
        if (interrupted) throw new Error("Signing session interrupted");
        // Inputs are scoped to the packaging child, never exported to install/build steps.
        const childEnv = {
            ...env,
            CSC_KEYCHAIN: keychain,
            CSC_NAME: inputs.identity,
            CSC_IDENTITY_AUTO_DISCOVERY: "false",
            APPLE_API_KEY: apiKey,
        };
        for (const key of [
            "CSC_LINK",
            "CSC_KEY_PASSWORD",
            "CSC_INSTALLER_LINK",
            "CSC_INSTALLER_KEY_PASSWORD",
            "APPLE_ID",
            "APPLE_APP_SPECIFIC_PASSWORD",
            "APPLE_KEYCHAIN",
            "APPLE_KEYCHAIN_PROFILE",
            "MACOS_CERTIFICATE_P12_BASE64",
            "MACOS_CERTIFICATE_PASSWORD",
            "APPLE_API_KEY_BASE64",
        ])
            delete childEnv[key];
        const result = await body({ env: childEnv, inputs, keychain, apiKey, signal: controller.signal });
        if (interrupted) throw new Error("Signing session interrupted");
        return result;
    } catch {
        throw new Error(interrupted ? "Signing session interrupted" : "Signing session failed");
    } finally {
        try {
            await cleanup();
        } finally {
            signals.removeListener("SIGINT", onSignal);
            signals.removeListener("SIGTERM", onSignal);
        }
    }
}
