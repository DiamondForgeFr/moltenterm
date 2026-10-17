// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { inputs } from "./fixtures.mjs";

const configPath = path.join(fileURLToPath(new URL("../../", import.meta.url)), "electron-builder.config.cjs");

function loadConfig(env) {
    const require = createRequire(configPath);
    const saved = { ...process.env };
    try {
        delete process.env.MOLTENTERM_MACOS_SIGNING;
        Object.assign(process.env, env);
        delete require.cache[configPath];
        return require(configPath);
    } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
        delete require.cache[configPath];
    }
}

test("the project's builder config is unchanged without the session flag and Developer ID with it", () => {
    const plain = loadConfig({});
    for (const key of ["identity", "sign", "forceCodeSigning", "notarize", "hardenedRuntime"]) {
        assert.equal(key in plain.mac, false, key);
    }
    assert.equal(plain.afterAllArtifactBuild, undefined);
    const signed = loadConfig({ MOLTENTERM_MACOS_SIGNING: "developer-id", CSC_NAME: inputs.identity });
    assert.equal(signed.mac.identity, inputs.identity);
    assert.equal(signed.mac.sign, "./scripts/macos-signing/builder-hooks.cjs");
    assert.equal(signed.mac.forceCodeSigning, true);
    assert.equal(signed.mac.hardenedRuntime, true);
    assert.equal(signed.mac.notarize, true);
    assert.equal(signed.mac.entitlements, plain.mac.entitlements);
    assert.deepEqual(signed.mac.target, plain.mac.target);
    assert.equal(signed.artifactName, "${productName}-${platform}-${arch}-${version}.${ext}");
    assert.equal(signed.directories.output, "make");
});

test("the sign hook path resolves to the bridge, which loads nothing until called", () => {
    const signed = loadConfig({ MOLTENTERM_MACOS_SIGNING: "developer-id", CSC_NAME: inputs.identity });
    const bridge = createRequire(configPath)(path.resolve(path.dirname(configPath), signed.mac.sign));
    assert.deepEqual(Object.keys(bridge), ["sign"]);
    assert.equal(typeof bridge.sign, "function");
});
