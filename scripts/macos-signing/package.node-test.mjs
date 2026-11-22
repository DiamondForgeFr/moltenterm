// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { hashFile } from "./artifacts.mjs";
import {
    fakeBlockMap,
    fakeBuilder,
    fakeEnv,
    inputs,
    jsonYaml,
    projectFixture,
    securityFixture,
    verificationFixture,
} from "./fixtures.mjs";
import {
    builderArgs,
    classifyBuilderFailure,
    FAILURE_AGREEMENT,
    FAILURE_AUTH,
    FAILURE_PACKAGING,
    FAILURE_REJECTED,
    FAILURE_UNKNOWN,
    FAILURE_UNREACHABLE,
    packageRelease,
} from "./package.mjs";
import { withSigningSession } from "./session.mjs";

// Every command of one run, in order: security (session), the builder process, then Apple tools (finalization).
function recorder(events) {
    const security = securityFixture(),
        verifier = verificationFixture();
    const run = async (file, args, options) => {
        events.push(`${path.basename(file)} ${args[0]}`);
        return file.endsWith("security") ? security.run(file, args, options) : verifier.run(file, args, options);
    };
    return { security, verifier, run };
}

async function release(
    projectDir,
    {
        events = [],
        builder,
        notarize,
        env = fakeEnv,
        extraArgs = [],
        verifyDelivery,
        writeEvidence,
        log = () => {},
    } = {}
) {
    const { security, run } = recorder(events);
    builder ??= fakeBuilder(projectDir, { events });
    const tools = {
        yaml: jsonYaml,
        buildBlockMap: fakeBlockMap,
        notarize:
            notarize ??
            (async (options) => {
                events.push(`notarize ${path.basename(options.appPath)}`);
                await fs.appendFile(options.appPath, "|ticket|");
            }),
    };
    const promise = packageRelease({
        env,
        extraArgs,
        projectDir,
        run,
        tools,
        builderCli: "/dummy/electron-builder/cli.js",
        verifyDelivery,
        writeEvidence,
        log,
        runProcess: builder.runProcess,
        session: (sessionEnv, body) =>
            withSigningSession(sessionEnv, body, {
                run,
                platform: "darwin",
                tempRoot: projectDir,
                signals: security.signals,
            }),
    });
    return { promise, security, builder, events };
}

test("builder arguments force -p never and accept only the update-file provider", () => {
    const args = builderArgs([
        "-c.publish.provider=github",
        "-c.publish.owner=DiamondForgeFr",
        "-c.publish.repo=moltenterm",
    ]);
    assert.deepEqual(args.slice(0, 4), ["-c", "electron-builder.config.cjs", "-p", "never"]);
    assert.ok(args.includes("--arm64") && args.includes("--x64") && args.includes("dmg") && args.includes("zip"));
    for (const bad of [
        "-p",
        "always",
        "--publish=always",
        "-c.mac.identity=-",
        "-c.mac.sign=null",
        "-c",
        "other.cjs",
        "-c.publish.owner=a;b",
        "--config=x",
    ]) {
        assert.throws(() => builderArgs([bad]), /Only -c\.publish/);
    }
});

test("public packaging records evidence only after finalization and delivered-app verification", async (t) => {
    for (const failDelivery of [false, true]) {
        const projectDir = await projectFixture(t);
        const pkg = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf8"));
        // Public context and package version must agree, as on a tagged checkout.
        pkg.version = "1.0.0";
        await fs.writeFile(path.join(projectDir, "package.json"), JSON.stringify(pkg));
        const events = [];
        const env = {
            ...fakeEnv,
            RELEASE_MODE: "release",
            RELEASE_CHANNEL: "public",
            RELEASE_VERSION: pkg.version,
            RELEASE_SHA: "a".repeat(40),
            RELEASE_RUN_ID: "123",
            RELEASE_RUN_ATTEMPT: "1",
        };
        const { promise } = await release(projectDir, {
            env,
            events,
            verifyDelivery: async (manifest, verified) => {
                assert.equal(verified.teamId, inputs.teamId);
                assert.ok(events.some((event) => event.startsWith("notarize")));
                for (const metadata of manifest.metadata) {
                    const doc = jsonYaml.load(await fs.readFile(metadata, "utf8"));
                    for (const entry of doc.files)
                        assert.equal(entry.sha512, (await hashFile(path.join(manifest.outDir, entry.url))).sha512);
                }
                events.push("delivery");
                if (failDelivery) throw new Error("rejected delivery");
            },
            writeEvidence: async (folder, context, verified) => {
                assert.equal(context.version, pkg.version);
                assert.equal(verified.teamId, inputs.teamId);
                assert.equal(events.at(-1), "delivery");
                events.push("evidence");
            },
        });
        if (failDelivery) await assert.rejects(promise, /Signing session failed/);
        else await promise;
        assert.equal(events.includes("evidence"), !failDelivery);
        assert.equal(events.at(-1), "security delete-keychain");
    }
});

test("commands run in order: keychain session, builder, final verification and notarization, then cleanup", async (t) => {
    const projectDir = await projectFixture(t);
    const { promise, security, builder, events } = await release(projectDir, {
        extraArgs: ["-c.publish.provider=github"],
    });
    const manifest = await promise;
    const index = (name) => {
        const at = events.findIndex((event) => event.startsWith(name));
        assert.notEqual(at, -1, `${name} ran`);
        return at;
    };
    assert.ok(index("security create-keychain") < index("security import"));
    assert.ok(index("security find-identity") < index("builder"));
    assert.ok(index("builder") < index("lipo"));
    assert.ok(index("lipo") < index("codesign --force"));
    assert.ok(index("codesign --force") < index("notarize"));
    // The apps' tickets (stapled by the builder) are checked first, then each DMG's after its own submission.
    assert.ok(index("xcrun stapler") < index("codesign --force"));
    assert.ok(events.indexOf("xcrun stapler", index("notarize")) > index("notarize"));
    assert.ok(
        events.lastIndexOf("security delete-keychain") > events.findLastIndex((event) => event.startsWith("spctl"))
    );
    const [call] = builder.calls;
    assert.equal(call.args[0], "/dummy/electron-builder/cli.js");
    assert.ok(call.args.includes("never") && call.args.includes("-c.publish.provider=github"));
    assert.equal(call.options.cwd, projectDir);
    assert.equal(call.options.env.MOLTENTERM_MACOS_SIGNING, "developer-id");
    assert.equal(call.options.env.CSC_NAME, inputs.identity);
    assert.equal(call.options.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
    for (const secret of ["MACOS_CERTIFICATE_P12_BASE64", "MACOS_CERTIFICATE_PASSWORD", "APPLE_API_KEY_BASE64"])
        assert.equal(call.options.env[secret], undefined);
    for (const file of manifest.metadata) {
        const doc = jsonYaml.load(await fs.readFile(file, "utf8"));
        for (const entry of doc.files)
            assert.deepEqual(
                { sha512: entry.sha512, size: entry.size },
                await hashFile(path.join(manifest.outDir, entry.url))
            );
    }
    assert.deepEqual(
        (await fs.readdir(projectDir)).filter((name) => name.startsWith("moltenterm-signing-")),
        []
    );
    assert.equal(security.signals.listenerCount("SIGTERM"), 0);
});

test("a failed builder, a notary rejection or a missing app stop before success and still clean up", async (t) => {
    for (const mode of ["builder", "notary", "missing-app"]) {
        const projectDir = await projectFixture(t),
            events = [];
        const builder = fakeBuilder(projectDir, {
            events,
            exitCode: mode === "builder" ? 1 : 0,
            sign:
                mode === "missing-app"
                    ? async (app) => {
                          if (app.arch === "x64") await fs.rm(app.path, { recursive: true });
                      }
                    : undefined,
        });
        const notarize =
            mode === "notary"
                ? async () => {
                      throw new Error(`rejected ${fakeEnv.MACOS_CERTIFICATE_PASSWORD}`);
                  }
                : undefined;
        const { promise } = await release(projectDir, { events, builder, notarize });
        await assert.rejects(promise, (error) => {
            assert.equal(error.message, "Signing session failed");
            assert.doesNotMatch(error.stack, /dummy-secret-password|DUMMY-ONLY/);
            return true;
        });
        if (mode === "builder")
            assert.equal(
                events.some((event) => event.startsWith("notarize") || event.startsWith("codesign")),
                false
            );
        assert.equal(events.at(-1), "security delete-keychain");
        const before = await fs.readFile(path.join(projectDir, "make", "latest-mac.yml"), "utf8");
        assert.match(before, /"files"/);
    }
});

test("partial secrets, leftover output and unsupported arguments are refused before any keychain command", async (t) => {
    const projectDir = await projectFixture(t);
    const partial = { ...fakeEnv };
    delete partial.APPLE_API_ISSUER;
    for (const [env, extraArgs, setup, pattern] of [
        [partial, [], null, /Incomplete macOS signing inputs, missing: APPLE_API_ISSUER/],
        [{}, [], null, /needs every signing input/],
        [fakeEnv, ["-c.mac.identity=-"], null, /Only -c\.publish/],
        [
            fakeEnv,
            [],
            async () => {
                await fs.mkdir(path.join(projectDir, "make", "mac-arm64"), { recursive: true });
            },
            /task clean/,
        ],
    ]) {
        await setup?.();
        const events = [];
        const { promise } = await release(projectDir, { env, extraArgs, events });
        await assert.rejects(promise, pattern);
        assert.deepEqual(events, []);
    }
});

test("stale delivery evidence is refused before signing or building", async (t) => {
    const projectDir = await projectFixture(t);
    await fs.mkdir(path.join(projectDir, "make"));
    await fs.writeFile(path.join(projectDir, "make/macos-verification.json"), "stale evidence");
    const events = [];
    const { promise } = await release(projectDir, { events });
    await assert.rejects(promise, /run task clean/);
    assert.deepEqual(events, []);
});

const Secret = "dummy-secret-password";
const ArbitraryLine = "/Users/runner/work/private-path TEAMID1234 arbitrary builder text";

// A builder that fails the way the real one does: a generic error whose captured output rides on it, not enumerable.
function failingBuilder(output) {
    const calls = [];
    return {
        calls,
        async runProcess(file, args, options) {
            calls.push({ file, args, options });
            const error = new Error("Signing packaging failed");
            Object.defineProperty(error, "output", { value: output, enumerable: false, configurable: true });
            throw error;
        },
    };
}

const FailureCases = [
    ["packaging", `Error: Electron download failed: ENOENT ${ArbitraryLine}`, FAILURE_PACKAGING],
    [
        "agreement",
        `Failed to notarize via notarytool. Error: HTTP status code: 403. A required agreement is missing or has expired. ${Secret}`,
        FAILURE_AGREEMENT,
    ],
    ["auth", `notarytool: Error: HTTP status code: 401. Invalid credentials. ${ArbitraryLine}`, FAILURE_AUTH],
    ["rejected", `Failed to notarize via notarytool: status: Invalid ${Secret}`, FAILURE_REJECTED],
    ["unreachable", `notarytool submit: ETIMEDOUT ${ArbitraryLine}`, FAILURE_UNREACHABLE],
    ["unknown", `something odd happened ${Secret} ${ArbitraryLine}`, FAILURE_UNKNOWN],
    ["unknown notary", `notarytool exploded in a new way ${Secret}`, FAILURE_UNKNOWN],
];

test("a builder failure outside the sign hook is named with one fixed label and nothing else", async (t) => {
    for (const [name, output, label] of FailureCases) {
        const projectDir = await projectFixture(t);
        const logs = [];
        const { promise } = await release(projectDir, {
            builder: failingBuilder(output),
            log: (message) => logs.push(message),
        });
        await assert.rejects(promise, (error) => {
            assert.equal(error.message, "Signing session failed", name);
            assert.doesNotMatch(String(error.stack), /dummy-secret-password|private-path|TEAMID1234/);
            assert.equal(Object.hasOwn(error, "output"), false);
            return true;
        });
        const failure = logs.filter((line) => line.startsWith("::error::The builder failed"));
        assert.deepEqual(failure, [`::error::The builder failed outside the sign hook: ${label}`], name);
        const everything = logs.join("\n");
        assert.doesNotMatch(everything, /dummy-secret-password|private-path|TEAMID1234|arbitrary|HTTP status|ENOENT/);
    }
});

test("a hook stage keeps priority and the captured text is still dropped", async (t) => {
    const projectDir = await projectFixture(t);
    const logs = [];
    const builder = failingBuilder(`notarytool HTTP status code: 403 ${Secret}`);
    const { promise } = await release(projectDir, { builder, log: (message) => logs.push(message) });
    await assert.rejects(promise, /Signing session failed/);
    assert.equal(builder.calls[0].options.capture, true);
    assert.equal(logs.filter((line) => line.includes("builder failed")).length, 1);
    assert.doesNotMatch(logs.join("\n"), new RegExp(Secret));
});

test("the builder is run with capture so its output can be classified in memory", async (t) => {
    const projectDir = await projectFixture(t);
    const { promise, builder } = await release(projectDir);
    await promise;
    assert.equal(builder.calls[0].options.capture, true);
});

test("classification never returns text taken from the output", () => {
    const labels = new Set([
        FAILURE_PACKAGING,
        FAILURE_AGREEMENT,
        FAILURE_AUTH,
        FAILURE_REJECTED,
        FAILURE_UNREACHABLE,
        FAILURE_UNKNOWN,
    ]);
    for (const output of [undefined, null, "", 42, ...FailureCases.map(([, text]) => text)])
        assert.ok(labels.has(classifyBuilderFailure(output)));
    assert.equal(classifyBuilderFailure(undefined), FAILURE_UNKNOWN);
    // A network error with no notarization in it is a packaging problem (an Electron download), not the notary's.
    assert.equal(classifyBuilderFailure("download electron zip ETIMEDOUT"), FAILURE_PACKAGING);
});
