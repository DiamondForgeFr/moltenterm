// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { assertForeignUnchanged, embeddedInventory, verifySigned } from "./artifacts.mjs";
import { BUILDER_VERSION, MODE_DEVELOPER_ID, signingIdentifiers } from "./policy.mjs";
import { command } from "./session.mjs";

export function loadToolchain(projectDir = fileURLToPath(new URL("../../", import.meta.url))) {
    const require = createRequire(path.join(projectDir, "package.json"));
    if (
        require("electron-builder/package.json").version !== BUILDER_VERSION ||
        require("app-builder-lib/package.json").version !== BUILDER_VERSION
    ) {
        throw new Error(`Signing integration requires locked electron-builder ${BUILDER_VERSION}`);
    }
    const yaml = require("js-yaml");
    return {
        sign: require("@electron/osx-sign").signAsync,
        notarize: require("@electron/notarize").notarize,
        buildBlockMap: require("app-builder-lib/out/targets/blockmap/blockmap").buildBlockMap,
        yaml: {
            load: (text) => yaml.load(text, { schema: yaml.JSON_SCHEMA }),
            dump: (doc) => yaml.dump(doc, { noRefs: true }),
        },
    };
}

export async function sessionContext(env) {
    const identifiers = signingIdentifiers(env);
    const keychain = env.CSC_KEYCHAIN,
        apiKey = env.APPLE_API_KEY;
    if (
        typeof keychain !== "string" ||
        typeof apiKey !== "string" ||
        !path.isAbsolute(keychain) ||
        !path.isAbsolute(apiKey) ||
        path.dirname(keychain) !== path.dirname(apiKey) ||
        path.basename(keychain) !== "signing.keychain-db" ||
        path.basename(apiKey) !== "AuthKey.p8" ||
        !path.basename(path.dirname(keychain)).startsWith("moltenterm-signing-") ||
        env.CSC_LINK ||
        env.APPLE_ID ||
        env.APPLE_KEYCHAIN_PROFILE
    ) {
        throw new Error("Expected a dedicated signing session without fallback credentials");
    }
    const directory = path.dirname(keychain);
    if ((await fs.realpath(directory)) !== directory || (await fs.stat(directory)).mode & 0o077)
        throw new Error("Signing session directory is not private");
    for (const file of [keychain, apiKey]) {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.mode & 0o077) throw new Error("Signing inputs must be private regular files");
    }
    return { ...identifiers, keychain, appleApiKey: apiKey };
}

// The builder's output is never shown, so the hook leaves the name of the check that failed (a fixed label, never a
// value) in the session's own directory, where package.mjs reads it before the session is cleaned up.
export function stageFile(keychain) {
    if (typeof keychain !== "string" || !path.isAbsolute(keychain)) return null;
    const directory = path.dirname(keychain);
    if (!path.basename(directory).startsWith("moltenterm-signing-")) return null;
    return path.join(directory, "failed-stage");
}

async function recordStage(keychain, stage) {
    const file = stageFile(keychain);
    if (!file) return;
    try {
        await fs.writeFile(file, stage, { mode: 0o600 });
    } catch {
        // Best effort: the failure itself is still reported.
    }
}

export async function readStage(keychain) {
    const file = stageFile(keychain);
    if (!file) return null;
    try {
        const stage = (await fs.readFile(file, "utf8")).trim();
        return /^[a-z0-9 ()-]{1,80}$/.test(stage) ? stage : null;
    } catch {
        return null;
    }
}

export function createHooks({ env = process.env, run = command, tools, platform = process.platform } = {}) {
    const signed = new Map();
    const toolchain = () => (tools ??= loadToolchain());
    return {
        async sign(options, packager) {
            let stage = "publishing check";
            try {
                if (
                    platform !== "darwin" ||
                    env.MOLTENTERM_MACOS_SIGNING !== MODE_DEVELOPER_ID ||
                    packager.info.options.publish !== "never"
                )
                    throw new Error("Builder publishing must be disabled");
                stage = "session context";
                const inputs = await sessionContext(env);
                stage = "builder signing options";
                const config = packager.platformSpecificBuildOptions;
                if (
                    config.identity !== inputs.identity ||
                    config.hardenedRuntime !== true ||
                    config.forceCodeSigning !== true ||
                    config.notarize === false ||
                    options.identity !== inputs.identity ||
                    options.keychain !== inputs.keychain ||
                    !options.optionsForFile
                )
                    throw new Error("Unsafe builder signing options");
                stage = "app identity and architecture";
                const app = await fs.realpath(options.app);
                if (signed.has(app)) throw new Error("App signed more than once");
                const version = packager.appInfo.version,
                    productName = packager.appInfo.productFilename;
                const native = await run("/usr/bin/lipo", ["-archs", path.join(app, "Contents/MacOS", productName)]);
                const arch =
                    native.stdout.trim() === "arm64" ? "arm64" : native.stdout.trim() === "x86_64" ? "x64" : null;
                stage = `embedded inventory (${arch})`;
                const inventory = await embeddedInventory(app, version, arch);
                stage = `upstream signing (${arch})`;
                const goFiles = new Set(inventory.darwin),
                    foreignFiles = new Set(inventory.foreign.keys());
                const goEntitlements = fileURLToPath(new URL("./go-entitlements.plist", import.meta.url));
                const optionsForFile = options.optionsForFile,
                    ignore = options.ignore;
                await toolchain().sign({
                    ...options,
                    ignore: (file) => foreignFiles.has(file) || (ignore ? ignore(file) : false),
                    optionsForFile: (file) => ({
                        ...optionsForFile(file),
                        ...(goFiles.has(file) ? { entitlements: goEntitlements } : {}),
                        hardenedRuntime: true,
                    }),
                });
                stage = `foreign payloads unchanged (${arch})`;
                await assertForeignUnchanged(inventory);
                stage = `helper signature evidence (${arch})`;
                // Verify the certificate chain requirement, not only a matching certificate display name.
                for (const file of inventory.darwin) await verifySigned(file, inputs, { run });
                signed.set(app, { arch, version, productName, inventory });
            } catch {
                await recordStage(env.CSC_KEYCHAIN, `sign hook ${stage}`);
                throw new Error("macOS package signing failed");
            }
        },
    };
}
