// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { hashFile } from "./artifacts.mjs";
import {
    fakeBuilder,
    fakeEnv,
    inputs,
    projectFixture,
    securityFixture,
    temporary,
    verificationFixture,
} from "./fixtures.mjs";
import { createHooks, loadToolchain } from "./hooks.mjs";
import { packageRelease } from "./package.mjs";
import { withSigningSession } from "./session.mjs";

const toolchain = loadToolchain();

test("locked upstream builder generates a real sidecar for the final bytes", async (t) => {
    const root = await temporary(t),
        file = path.join(root, "fixture.dmg");
    const bytes = Buffer.alloc(120000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await fs.writeFile(file, bytes);
    const before = await toolchain.buildBlockMap(file, "gzip", `${file}.blockmap`);
    const oldMap = await fs.readFile(`${file}.blockmap`);
    await fs.appendFile(file, "dummy-stapled-ticket");
    const final = await toolchain.buildBlockMap(file, "gzip", `${file}.blockmap`);
    assert.notEqual(before.sha512, final.sha512);
    assert.deepEqual(final, await hashFile(file));
    assert.equal("blockMapSize" in final, false);
    assert.notDeepEqual(await fs.readFile(`${file}.blockmap`), oldMap);
    const map = JSON.parse(gunzipSync(await fs.readFile(`${file}.blockmap`)).toString("utf8"));
    assert.equal(map.version, "2");
    assert.equal(
        map.files[0].sizes.reduce((a, b) => a + b, 0),
        final.size
    );
    assert.equal(map.files[0].sizes.length, map.files[0].checksums.length);
});

test("complete two-architecture packaging uses the real hook, YAML and blockmap adapters without Apple commands", async (t) => {
    const projectDir = await projectFixture(t),
        security = securityFixture(),
        verifier = verificationFixture();
    let signCalls = 0,
        notaryCalls = 0,
        apiKey;
    const tools = {
        ...toolchain,
        sign: async () => {
            signCalls++;
        },
        notarize: async (options) => {
            notaryCalls++;
            assert.equal(options.tool, "notarytool");
            assert.equal(options.appleApiKey, apiKey);
            assert.equal(options.appleApiKeyId, inputs.keyId);
            assert.equal(options.appleApiIssuer, inputs.issuer);
            await fs.appendFile(options.appPath, "dummy-ticket");
        },
    };
    // The builder calls the real sign hook with its own process environment, as electron-builder does.
    const builder = fakeBuilder(projectDir, {
        sign: async (app, env) => {
            apiKey = env.APPLE_API_KEY;
            await createHooks({ env, run: verifier.run, tools, platform: "darwin" }).sign(
                {
                    app: app.path,
                    identity: inputs.identity,
                    keychain: env.CSC_KEYCHAIN,
                    optionsForFile: () => ({ entitlements: "Electron.plist" }),
                },
                {
                    info: { options: { publish: "never" } },
                    appInfo: { version: "1.0.0-4", productFilename: "MoltenTerm" },
                    platformSpecificBuildOptions: {
                        identity: env.CSC_NAME,
                        hardenedRuntime: true,
                        forceCodeSigning: true,
                        notarize: true,
                    },
                }
            );
        },
    });
    const manifest = await packageRelease({
        env: fakeEnv,
        projectDir,
        run: verifier.run,
        tools,
        builderCli: "/dummy/cli.js",
        log: () => {},
        runProcess: builder.runProcess,
        session: (env, body) =>
            withSigningSession(env, body, {
                run: security.run,
                platform: "darwin",
                tempRoot: projectDir,
                signals: security.signals,
            }),
    });
    assert.equal(signCalls, 2);
    assert.equal(notaryCalls, 2);
    for (const file of manifest.metadata) {
        const metadata = toolchain.yaml.load(await fs.readFile(file, "utf8"));
        for (const entry of metadata.files)
            assert.deepEqual(
                { sha512: entry.sha512, size: entry.size },
                await hashFile(path.join(manifest.outDir, entry.url))
            );
    }
    assert.equal(security.calls.filter((call) => call.args[0] === "delete-keychain").length, 1);
    assert.ok((await fs.readdir(projectDir)).every((name) => !name.startsWith("moltenterm-signing-")));
});
