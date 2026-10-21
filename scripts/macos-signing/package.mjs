#!/usr/bin/env node
// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

// Developer ID packaging entry point (#507). Runs electron-builder inside an ephemeral signing session, then finalizes
// the DMGs and the update metadata once the builder has exited, before anything can be uploaded.
//
//   node scripts/macos-signing/package.mjs mode                      prints adhoc or developer-id, fails on a partial set
//   node scripts/macos-signing/package.mjs package [-c.publish.*=…]  builds, signs, notarizes and verifies both arches

/* global console */

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { finalizeArtifacts } from "./artifacts.mjs";
import { loadToolchain, readStage, sessionContext } from "./hooks.mjs";
import { ARCHES, MODE_DEVELOPER_ID, signingMode } from "./policy.mjs";
import { runOwnedProcess } from "./process.mjs";
import { command, withSigningSession } from "./session.mjs";

export const OUT_DIR = "make";
export const BUILDER_TARGETS = ["--mac", "zip", "dmg", "--arm64", "--x64"];
const ArtifactTemplate = "${productName}-${platform}-${arch}-${version}.${ext}";
const PublishArg = /^-c\.publish\.(?:provider|owner|repo)=[A-Za-z0-9._-]+$/;
const MetadataName = /^[a-zA-Z0-9_-]+-mac\.yml$/;
// The builder names the x64 app folder "mac" and the arm64 one "mac-arm64" (computeAppOutDir, getArchSuffix).
const AppFolders = { arm64: "mac-arm64", x64: "mac" };

const defaultProjectDir = fileURLToPath(new URL("../../", import.meta.url));

// Only the update-file provider may be chosen: the publish policy, identity and hooks come from the config file.
export function builderArgs(extra) {
    for (const arg of extra) {
        if (!PublishArg.test(arg))
            throw new Error(
                "Only -c.publish.provider, -c.publish.owner and -c.publish.repo may be passed to the signed packaging"
            );
    }
    return ["-c", "electron-builder.config.cjs", "-p", "never", ...BUILDER_TARGETS, ...extra];
}

export async function releaseLayout(projectDir) {
    const pkg = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf8"));
    const config = createRequire(path.join(projectDir, "package.json"))(
        path.join(projectDir, "electron-builder.config.cjs")
    );
    if (config.artifactName !== ArtifactTemplate || config.directories?.output !== OUT_DIR)
        throw new Error("Unsupported artifact naming or output folder");
    if (
        typeof pkg.version !== "string" ||
        typeof pkg.productName !== "string" ||
        !/^[A-Za-z0-9]+$/.test(pkg.productName)
    )
        throw new Error("Unsupported product name or version");
    return { version: pkg.version, productName: pkg.productName, outDir: path.join(projectDir, OUT_DIR) };
}

async function leftovers(outDir) {
    let names;
    try {
        names = await fs.readdir(outDir);
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
    return names.filter(
        (name) => MetadataName.test(name) || /-darwin-.*\.(?:dmg|zip|blockmap)$/.test(name) || /^mac(?:-|$)/.test(name)
    );
}

export async function collectRelease({ outDir, version, productName }, { run = command } = {}) {
    const root = await fs.realpath(outDir);
    const names = await fs.readdir(root);
    const apps = [];
    for (const arch of ARCHES) {
        const app = path.join(root, AppFolders[arch], `${productName}.app`);
        const native = await run("/usr/bin/lipo", ["-archs", path.join(app, "Contents/MacOS", productName)]);
        if (native.stdout.trim() !== (arch === "arm64" ? "arm64" : "x86_64"))
            throw new Error("Release app architecture mismatch");
        apps.push({ path: app, arch });
    }
    if (names.some((name) => /^mac-/.test(name) && !Object.values(AppFolders).includes(name)))
        throw new Error("Unexpected app build folder");
    const artifacts = ARCHES.flatMap((arch) =>
        ["zip", "dmg"].map((ext) => path.join(root, `${productName}-darwin-${arch}-${version}.${ext}`))
    );
    const metadata = names.filter((name) => MetadataName.test(name)).map((name) => path.join(root, name));
    if (!metadata.some((file) => path.basename(file) === "latest-mac.yml"))
        throw new Error("The builder wrote no latest-mac.yml");
    return { outDir: root, version, apps, artifacts, metadata };
}

export async function packageRelease({
    env = process.env,
    extraArgs = [],
    projectDir = defaultProjectDir,
    session = withSigningSession,
    sessionOptions = {},
    runProcess = runOwnedProcess,
    run = command,
    tools,
    builderCli,
    log = (message) => console.log(message),
} = {}) {
    if (signingMode(env) !== MODE_DEVELOPER_ID) throw new Error("Developer ID packaging needs every signing input");
    const args = builderArgs(extraArgs);
    const layout = await releaseLayout(projectDir);
    if ((await leftovers(layout.outDir)).length)
        throw new Error(`Earlier macOS build output is in ${OUT_DIR}/: run task clean first`);
    const toolchain = () => (tools ??= loadToolchain(projectDir));
    const cli = builderCli ?? createRequire(path.join(projectDir, "package.json")).resolve("electron-builder/cli.js");
    return session(
        env,
        async ({ env: scoped, signal }) => {
            const builderEnv = { ...scoped, MOLTENTERM_MACOS_SIGNING: MODE_DEVELOPER_ID };
            log(
                "Packaging and signing both macOS architectures (builder output is not shown: it can hold credentials)"
            );
            // The session reports any failure as "Signing session failed": name the stage first, with fixed labels only.
            try {
                await runProcess(process.execPath, [cli, ...args], { env: builderEnv, cwd: projectDir, signal });
            } catch (error) {
                const hookStage = await readStage(scoped.CSC_KEYCHAIN);
                log(
                    hookStage
                        ? `::error::The builder failed in the ${hookStage}`
                        : "::error::The builder failed outside the sign hook (packaging, or its notarization of an app)"
                );
                throw error;
            }
            log("Verifying the apps, notarizing the disk images and refreshing the update files");
            let stage = "collecting the built apps";
            try {
                const manifest = await collectRelease(layout, { run });
                stage = "checking the signing session";
                const inputs = await sessionContext(builderEnv);
                const t = toolchain();
                stage = "finalizing";
                await finalizeArtifacts(manifest, inputs, {
                    run,
                    yaml: t.yaml,
                    buildBlockMap: t.buildBlockMap,
                    notarize: (file) =>
                        t.notarize({
                            appPath: file,
                            tool: "notarytool",
                            appleApiKey: inputs.appleApiKey,
                            appleApiKeyId: inputs.keyId,
                            appleApiIssuer: inputs.issuer,
                        }),
                });
                log("Developer ID signed, notarized and stapled: both apps and disk images verified");
                return manifest;
            } catch (error) {
                const own = /^Final macOS artifact verification failed at: [a-z0-9 ()-]+$/.test(error.message);
                log(`::error::Developer ID packaging failed ${own ? `(${error.message})` : `while ${stage}`}`);
                throw error;
            }
        },
        sessionOptions
    );
}

async function main(argv) {
    const [action, ...rest] = argv;
    if (action === "mode") {
        console.log(signingMode(process.env));
        return;
    }
    if (action === "package") {
        await packageRelease({ extraArgs: rest });
        return;
    }
    throw new Error("usage: package.mjs mode | package [-c.publish.provider=… -c.publish.owner=… -c.publish.repo=…]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch((error) => {
        // Only this module's own fixed messages: wrapped upstream errors never reach the log.
        console.error(`::error::${error.message}`);
        process.exitCode = 1;
    });
}
