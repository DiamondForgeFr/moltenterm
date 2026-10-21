// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { embeddedInventory, finalizeArtifacts, hashFile, refreshMetadata, verifySigned } from "./artifacts.mjs";
import {
    appFixture,
    artifactFixture,
    fakeBlockMap,
    fakeEnv,
    inputs,
    jsonYaml,
    securityFixture,
    temporary,
    verificationFixture,
    version,
} from "./fixtures.mjs";
import { createHooks, readStage } from "./hooks.mjs";
import { APP_ID, SIGNING_INPUTS, binaryFormat, checkedSignature, signingInputs, signingMode } from "./policy.mjs";
import { withSigningSession } from "./session.mjs";

test("preflight rejects every missing or malformed input before command execution", async () => {
    for (const name of Object.keys(fakeEnv)) {
        const env = { ...fakeEnv };
        delete env[name];
        let invoked = false;
        await assert.rejects(
            withSigningSession(
                env,
                () => {
                    invoked = true;
                },
                {
                    platform: "darwin",
                    run: () => {
                        invoked = true;
                    },
                }
            ),
            /signing input/
        );
        assert.equal(invoked, false);
    }
    for (const identity of ["-", "", "Developer ID Application: Dummy", "A".repeat(40) + "\n"])
        assert.throws(() => signingInputs({ ...fakeEnv, MACOS_SIGNING_IDENTITY: identity }, "darwin"));
    assert.throws(() => signingInputs(fakeEnv, "linux"), /macOS runner/);
    assert.throws(() => signingInputs({ ...fakeEnv, MACOS_CERTIFICATE_P12_BASE64: "!!!" }, "darwin"), /base64/);
    assert.throws(
        () =>
            signingInputs({ ...fakeEnv, APPLE_API_KEY_BASE64: Buffer.from("not a key").toString("base64") }, "darwin"),
        /private-key container/
    );
    assert.throws(() => signingInputs({ ...fakeEnv, APPLE_API_ISSUER: "wrong" }, "darwin"), /issuer/);
});

test("signing mode is ad hoc with no input, Developer ID with all, and refuses a partial set", () => {
    assert.equal(signingMode({}), "adhoc");
    assert.equal(signingMode({ MACOS_SIGNING_IDENTITY: "" }), "adhoc");
    assert.equal(signingMode(fakeEnv), "developer-id");
    for (const name of SIGNING_INPUTS) {
        const env = { ...fakeEnv };
        delete env[name];
        assert.throws(
            () => signingMode(env),
            (error) => error.message.includes(name) && !error.message.includes(fakeEnv.MACOS_CERTIFICATE_PASSWORD)
        );
        assert.throws(() => signingMode({ [name]: fakeEnv[name] }), /Incomplete/);
    }
    assert.deepEqual([...SIGNING_INPUTS].sort(), Object.keys(fakeEnv).sort());
});

test("session scopes inputs, restricts permissions, and preserves preexisting and concurrently added keychains", async (t) => {
    const root = await temporary(t),
        fake = securityFixture();
    const env = { ...fakeEnv, CSC_LINK: "must-not-be-used", APPLE_ID: "must-not-be-used" };
    let owned;
    const result = await withSigningSession(
        env,
        async (session) => {
            owned = path.dirname(session.keychain);
            assert.equal((await fs.stat(owned)).mode & 0o777, 0o700);
            assert.equal((await fs.stat(session.apiKey)).mode & 0o777, 0o600);
            await assert.rejects(fs.stat(path.join(owned, "certificate.p12")), { code: "ENOENT" });
            for (const key of [
                "CSC_LINK",
                "APPLE_ID",
                "MACOS_CERTIFICATE_PASSWORD",
                "MACOS_CERTIFICATE_P12_BASE64",
                "APPLE_API_KEY_BASE64",
            ])
                assert.equal(session.env[key], undefined);
            assert.equal(session.env.CSC_KEYCHAIN, session.keychain);
            fake.addUnrelated("/unrelated/new.keychain-db");
            return "packaged";
        },
        { run: fake.run, platform: "darwin", tempRoot: root, signals: fake.signals }
    );
    assert.equal(result, "packaged");
    assert.deepEqual(fake.list, ["/unrelated/login.keychain-db", "/unrelated/new.keychain-db"]);
    assert.deepEqual(
        fake.calls.filter((call) => call.args[0] === "delete-keychain").map((call) => call.args[1]),
        [path.join(owned, "signing.keychain-db")]
    );
    assert.deepEqual(await fs.readdir(root), []);
    assert.equal(fake.signals.listenerCount("SIGINT"), 0);
});

test("each initialization failure redacts raw diagnostics and removes only owned inputs", async (t) => {
    for (let failAt = 0; failAt < 9; failAt++) {
        const root = await temporary(t),
            fake = securityFixture({ failAt });
        await assert.rejects(
            withSigningSession(
                fakeEnv,
                () => {
                    throw new Error("must not reach body");
                },
                { run: fake.run, platform: "darwin", tempRoot: root, signals: fake.signals }
            ),
            (error) => {
                assert.doesNotMatch(error.stack, /dummy-secret-password|DUMMY-ONLY/);
                return true;
            }
        );
        assert.deepEqual(await fs.readdir(root), []);
        assert.ok(fake.list.includes("/unrelated/login.keychain-db"));
        for (const call of fake.calls.filter((call) => call.args[0] === "delete-keychain"))
            assert.ok(call.args[1].startsWith(root + path.sep));
    }
});

test("body failure, interrupted body, and cleanup failure cannot return success or leak diagnostics", async (t) => {
    for (const mode of ["body", "signal", "cleanup"]) {
        const root = await temporary(t),
            fake = securityFixture();
        const run = async (file, args, options) => {
            if (mode === "cleanup" && args[0] === "delete-keychain")
                throw new Error(fakeEnv.MACOS_CERTIFICATE_PASSWORD);
            return fake.run(file, args, options);
        };
        await assert.rejects(
            withSigningSession(
                fakeEnv,
                async (session) => {
                    if (mode === "body") throw new Error(fakeEnv.MACOS_CERTIFICATE_PASSWORD);
                    if (mode === "signal") {
                        fake.signals.emit("SIGTERM");
                        assert.equal(session.signal.aborted, true);
                    }
                },
                { run, platform: "darwin", tempRoot: root, signals: fake.signals }
            ),
            (error) => {
                assert.doesNotMatch(error.stack, /dummy-secret-password/);
                return true;
            }
        );
        assert.deepEqual(await fs.readdir(root), []);
        assert.ok(fake.list.includes("/unrelated/login.keychain-db"));
    }
});

test("a symlinked temporary root yields a canonical private session", async (t) => {
    const root = await temporary(t),
        alias = path.join(root, "alias"),
        real = path.join(root, "real");
    await fs.mkdir(real);
    await fs.symlink(real, alias);
    const fake = securityFixture();
    await withSigningSession(
        fakeEnv,
        async (session) => {
            assert.ok(session.keychain.startsWith(real + path.sep));
            assert.equal(await fs.realpath(path.dirname(session.keychain)), path.dirname(session.keychain));
        },
        { run: fake.run, platform: "darwin", tempRoot: alias, signals: fake.signals }
    );
    assert.deepEqual(await fs.readdir(real), []);
});

test("format and inventory validation reject renamed foreign, stale, missing and linked executables", async (t) => {
    assert.equal(binaryFormat(Buffer.from("cffaedfe", "hex")), "macho");
    assert.equal(binaryFormat(Buffer.from("7f454c46", "hex")), "elf");
    assert.equal(binaryFormat(Buffer.from("4d5a", "hex")), "pe");
    for (const mode of ["foreign", "stale", "missing", "symlink", "missing-foreign"]) {
        const root = await temporary(t),
            app = await appFixture(root, "arm64");
        const target = path.join(app.bin, `wsh-${version}-darwin.arm64`);
        if (mode === "foreign") await fs.writeFile(target, Buffer.from("7f454c46", "hex"));
        if (mode === "stale") await fs.copyFile(target, path.join(app.bin, "wsh-0.0.0-darwin.arm64"));
        if (mode === "missing") await fs.unlink(target);
        if (mode === "missing-foreign") await fs.unlink(path.join(app.bin, `wsh-${version}-linux.x64`));
        if (mode === "symlink") {
            await fs.unlink(target);
            await fs.symlink("/bin/ls", target);
        }
        await assert.rejects(embeddedInventory(app.path, version, "arm64"));
    }
});

test("signature evidence rejects ad-hoc, wrong team, missing runtime/timestamp and dangerous entitlements", async () => {
    const good = `Identifier=${APP_ID}\nAuthority=Developer ID Application: Dummy\nTeamIdentifier=${inputs.teamId}\nCodeDirectory flags=0x10000(runtime)\nTimestamp=now\n`;
    checkedSignature(good, inputs, { app: true });
    for (const bad of [
        good.replace(inputs.teamId, "OTHERTEAM1"),
        good.replace("flags=0x10000(runtime)", "flags=0(adhoc)"),
        good.replace("Timestamp=now", ""),
        good.replace("Developer ID Application", "Apple Development"),
    ])
        assert.throws(() => checkedSignature(bad, inputs, { app: true }));
    for (const value of [true, "true", 1, "false"]) {
        const fake = verificationFixture({ entitlements: { "com.apple.security.get-task-allow": value } });
        await assert.rejects(verifySigned("dummy", inputs, { run: fake.run }), /entitlements/);
    }
    const fake = verificationFixture();
    await verifySigned("dummy", inputs, { run: fake.run });
    assert.match(
        fake.calls[0].args[fake.calls[0].args.indexOf("-R") + 1],
        /anchor apple generic.*100\.6\.1\.13.*TESTTEAM01/
    );
});

test("metadata is refreshed from final DMG bytes while ZIP and release information remain intact", async (t) => {
    const fixture = await artifactFixture(await temporary(t));
    const dmgs = fixture.artifacts.filter((file) => file.endsWith(".dmg"));
    for (const file of dmgs) await fs.appendFile(file, "|stapled-ticket|");
    await refreshMetadata(fixture.metadata, fixture.artifacts, dmgs, { yaml: jsonYaml, buildBlockMap: fakeBlockMap });
    for (const file of fixture.metadata) {
        const doc = jsonYaml.load(await fs.readFile(file, "utf8"));
        assert.equal(doc.releaseNotes, fixture.document.releaseNotes);
        assert.equal(doc.releaseDate, fixture.document.releaseDate);
        assert.equal(doc.path, fixture.document.path);
        assert.equal(doc.sha512, fixture.document.sha512);
        for (const entry of doc.files)
            assert.deepEqual(
                { sha512: entry.sha512, size: entry.size },
                await hashFile(path.join(fixture.outDir, entry.url))
            );
    }
    for (const file of dmgs)
        assert.match(
            await fs.readFile(`${file}.blockmap`, "utf8"),
            new RegExp((await hashFile(file)).sha512.replace(/[+]/g, "\\+"))
        );
});

test("metadata rejects remote/traversal/duplicate/unknown/stale ZIP and unsupported structures before replacing any channel", async (t) => {
    for (const mutate of [
        (doc) => {
            doc.files[0].url = "https://example.invalid/a.zip";
        },
        (doc) => {
            doc.files[0].url = "../a.zip";
        },
        (doc) => {
            doc.files.push(doc.files[0]);
        },
        (doc) => {
            doc.files[0].url = "unknown.zip";
        },
        (doc) => {
            doc.files[0].sha512 = "stale";
        },
        (doc) => {
            doc.files[0].blockMapSize = 123;
        },
        (doc) => {
            doc.packages = {};
        },
        (doc) => {
            doc.sha512 = "wrong legacy hash";
        },
        (doc) => {
            doc.files.pop();
        },
    ]) {
        const fixture = await artifactFixture(await temporary(t));
        const before = await fs.readFile(fixture.metadata[0], "utf8");
        const doc = jsonYaml.load(jsonYaml.dump(fixture.document));
        mutate(doc);
        await fs.writeFile(fixture.metadata[1], jsonYaml.dump(doc));
        await assert.rejects(
            refreshMetadata(
                fixture.metadata,
                fixture.artifacts,
                fixture.artifacts.filter((file) => file.endsWith(".dmg")),
                { yaml: jsonYaml, buildBlockMap: fakeBlockMap }
            )
        );
        assert.equal(await fs.readFile(fixture.metadata[0], "utf8"), before);
    }
});

test("DMG legacy fields are updated and stale blockmap-generator results are rejected", async (t) => {
    const fixture = await artifactFixture(await temporary(t)),
        dmgs = fixture.artifacts.filter((file) => file.endsWith(".dmg"));
    for (const file of fixture.metadata) {
        const doc = jsonYaml.load(jsonYaml.dump(fixture.document));
        doc.path = path.basename(dmgs[0]);
        doc.sha512 = doc.files.find((entry) => entry.url === doc.path).sha512;
        await fs.writeFile(file, jsonYaml.dump(doc));
    }
    await fs.appendFile(dmgs[0], "ticket");
    await assert.rejects(
        refreshMetadata(fixture.metadata, fixture.artifacts, dmgs, {
            yaml: jsonYaml,
            buildBlockMap: async (...args) => ({ ...(await fakeBlockMap(...args)), sha512: "before-stapling" }),
        }),
        /final artifact/
    );
    await refreshMetadata(fixture.metadata, fixture.artifacts, dmgs, { yaml: jsonYaml, buildBlockMap: fakeBlockMap });
    const doc = jsonYaml.load(await fs.readFile(fixture.metadata[0], "utf8"));
    assert.equal(doc.sha512, (await hashFile(dmgs[0])).sha512);
});

test("finalization validates both apps, notarizes final DMGs, then refreshes update hashes", async (t) => {
    const fixture = await artifactFixture(await temporary(t)),
        fake = verificationFixture(),
        submitted = [];
    await finalizeArtifacts(
        fixture,
        { ...inputs, keychain: "/owned/dummy.keychain" },
        {
            run: fake.run,
            yaml: jsonYaml,
            buildBlockMap: fakeBlockMap,
            notarize: async (file) => {
                submitted.push(file);
                await fs.appendFile(file, "|ticket|");
            },
        }
    );
    assert.deepEqual(
        submitted,
        fixture.artifacts.filter((file) => file.endsWith(".dmg"))
    );
    assert.equal(fake.calls.filter((call) => call.file.endsWith("spctl")).length, 4);
    const doc = jsonYaml.load(await fs.readFile(fixture.metadata[0], "utf8"));
    for (const file of submitted)
        assert.equal(
            doc.files.find((entry) => entry.url === path.basename(file)).sha512,
            (await hashFile(file)).sha512
        );
});

test("notary rejection, missing tickets and nested signature failures redact errors and do not finalize metadata", async (t) => {
    for (const mode of ["notary", "ticket", "signature"]) {
        const fixture = await artifactFixture(await temporary(t));
        const fake = verificationFixture({
            reject: (file, args) =>
                (mode === "ticket" && args[0] === "stapler") ||
                (mode === "signature" && file.endsWith("codesign") && args[0] === "--verify"),
        });
        const before = await fs.readFile(fixture.metadata[0], "utf8");
        await assert.rejects(
            finalizeArtifacts(fixture, inputs, {
                run: fake.run,
                yaml: jsonYaml,
                buildBlockMap: fakeBlockMap,
                notarize: async () => {
                    if (mode === "notary") throw new Error(fakeEnv.MACOS_CERTIFICATE_PASSWORD);
                },
            }),
            (error) => {
                assert.equal(
                    error.message,
                    `Final macOS artifact verification failed at: ${
                        {
                            notary: "disk image notarization",
                            ticket: "app verification (arm64)",
                            signature: "app verification (arm64)",
                        }[mode]
                    }`
                );
                assert.doesNotMatch(error.stack, /dummy-secret/);
                return true;
            }
        );
        assert.equal(await fs.readFile(fixture.metadata[0], "utf8"), before);
    }
});

test("real hook contract preserves Electron options, excludes foreign payloads and signs all five Go binaries", async (t) => {
    const root = await temporary(t),
        security = securityFixture(),
        app = await appFixture(root, "arm64"),
        verifier = verificationFixture();
    let calls = 0;
    await withSigningSession(
        fakeEnv,
        async (session) => {
            const env = { ...session.env, MOLTENTERM_MACOS_SIGNING: "developer-id" };
            const hooks = createHooks({
                env,
                run: verifier.run,
                platform: "darwin",
                tools: {
                    sign: async (options) => {
                        calls++;
                        assert.equal(options.identity, inputs.identity);
                        assert.equal(options.ignore(path.join(app.bin, `wsh-${version}-linux.x64`)), true);
                        assert.equal(options.ignore(path.join(app.bin, `wsh-${version}-windows.x64.exe`)), true);
                        assert.equal(options.ignore("existing-ignore"), true);
                        for (const binary of (await embeddedInventory(app.path, version, "arm64")).darwin) {
                            assert.match(options.optionsForFile(binary).entitlements, /go-entitlements\.plist$/);
                            assert.equal(options.ignore(binary), false);
                        }
                        assert.equal(options.optionsForFile("Electron").entitlements, "existing-electron.plist");
                        assert.equal(options.optionsForFile("Electron").requirements, "preserved");
                    },
                },
            });
            const packager = {
                info: { options: { publish: "never" } },
                appInfo: { version, productFilename: "MoltenTerm" },
                platformSpecificBuildOptions: {
                    identity: inputs.identity,
                    hardenedRuntime: true,
                    forceCodeSigning: true,
                },
            };
            const options = {
                app: app.path,
                identity: inputs.identity,
                keychain: session.keychain,
                ignore: (file) => file === "existing-ignore",
                optionsForFile: () => ({ entitlements: "existing-electron.plist", requirements: "preserved" }),
            };
            await hooks.sign(options, packager);
            await assert.rejects(hooks.sign(options, packager), /package signing failed/);
            const unused = {
                sign: async () => {
                    calls++;
                },
            };
            await assert.rejects(
                createHooks({ env: session.env, run: verifier.run, platform: "darwin", tools: unused }).sign(
                    options,
                    packager
                ),
                /package signing failed/
            );
            await assert.rejects(
                createHooks({ env, run: verifier.run, platform: "darwin", tools: unused }).sign(
                    { ...options, identity: "-" },
                    packager
                ),
                /package signing failed/
            );
            assert.equal(await readStage(session.keychain), "sign hook builder signing options");
            packager.info.options.publish = "always";
            await assert.rejects(
                createHooks({ env, run: verifier.run, platform: "darwin", tools: unused }).sign(options, packager),
                /package signing failed/
            );
            assert.equal(await readStage(session.keychain), "sign hook publishing check");
        },
        { run: security.run, platform: "darwin", tempRoot: root, signals: security.signals }
    );
    assert.equal(calls, 1);
});
