// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { extractDeliveryZip, verifyDeliveryArtifacts } from "./delivery.mjs";
import { artifactFixture, inputs, temporary, verificationFixture } from "./fixtures.mjs";

async function setup(t, { fail = "", mutate = async () => {} } = {}) {
    const root = await temporary(t);
    const manifest = await artifactFixture(path.join(root, "make"));
    const verifier = verificationFixture();
    const events = [];
    const populate = async (file, dir) => {
        const arch = path.basename(file).includes("-arm64-") ? "arm64" : "x64";
        await fs.cp(manifest.apps.find((app) => app.arch === arch).path, path.join(dir, "MoltenTerm.app"), {
            recursive: true,
        });
        await mutate(dir, arch, file);
    };
    const run = async (file, args, options) => {
        events.push({ file, args });
        if (file.endsWith("hdiutil")) {
            if (args[0] === "attach") {
                assert.ok(args.includes("-readonly") && args.includes("-nobrowse") && args.includes("-noautoopen"));
                await populate(args.at(-1), args[args.indexOf("-mountpoint") + 1]);
                if (fail === "attach") throw new Error("dummy-sensitive-diagnostic");
            }
            if (args[0] === "detach" && fail === "detach") throw new Error("dummy-sensitive-diagnostic");
            return { stdout: "", stderr: "" };
        }
        if (file.endsWith("lipo")) {
            const target = args.at(-1);
            const arch = target.endsWith("/MoltenTerm")
                ? target.includes("-x64/")
                    ? "x86_64"
                    : "arm64"
                : target.endsWith("x64")
                  ? "x86_64"
                  : "arm64";
            return { stdout: fail === "architecture" ? "unexpected" : arch, stderr: "" };
        }
        if ((fail === "ticket" && args[0] === "stapler") || (fail === "signature" && file.endsWith("codesign")))
            throw new Error("dummy-sensitive-diagnostic");
        return verifier.run(file, args, options);
    };
    const extractZip = async (file, dir) => {
        events.push({ file: "extract", args: [file, dir] });
        if (fail === "extract") throw new Error("dummy-sensitive-diagnostic");
        await populate(file, dir);
    };
    return { root, manifest, events, options: { run, extractZip, tempRoot: root } };
}

async function ownedDirs(root) {
    return (await fs.readdir(root)).filter((name) => name.startsWith("moltenterm-delivery-"));
}

test("delivery checks both final formats and architectures and detaches read-only images", async (t) => {
    const fixture = await setup(t);
    await verifyDeliveryArtifacts(fixture.manifest, inputs, fixture.options);
    assert.equal(fixture.events.filter(({ file }) => file === "extract").length, 2);
    const disks = fixture.events.filter(({ file }) => file.endsWith("hdiutil"));
    assert.deepEqual(
        disks.map(({ args }) => args[0]),
        ["attach", "detach", "attach", "detach"]
    );
    assert.equal(fixture.events.filter(({ file }) => file.endsWith("spctl")).length, 4);
    assert.equal(fixture.events.filter(({ file }) => file.endsWith("lipo")).length, 24);
    assert.deepEqual(await ownedDirs(fixture.root), []);
});

test("delivery failures redact raw diagnostics and clean owned extraction directories", async (t) => {
    for (const fail of ["extract", "architecture", "ticket", "signature", "attach"]) {
        const fixture = await setup(t, { fail });
        await assert.rejects(verifyDeliveryArtifacts(fixture.manifest, inputs, fixture.options), (error) => {
            assert.match(error.message, /^Final macOS delivery verification failed at: (zip|dmg) \(arm64\)$/);
            assert.doesNotMatch(error.stack, /dummy-sensitive/);
            return true;
        });
        if (fail === "attach") assert.equal(fixture.events.filter(({ args }) => args[0] === "detach").length, 1);
        assert.deepEqual(await ownedDirs(fixture.root), []);
    }
});

test("detach failure blocks success and never recursively removes a possibly mounted directory", async (t) => {
    const fixture = await setup(t, { fail: "detach" });
    await assert.rejects(verifyDeliveryArtifacts(fixture.manifest, inputs, fixture.options), /failed at: cleanup/);
    const [owned] = await ownedDirs(fixture.root);
    assert.ok(owned);
    assert.ok((await fs.stat(path.join(fixture.root, owned, "dmg-arm64", "MoltenTerm.app"))).isDirectory());
});

test("an app verification failure still detaches its mounted image", async (t) => {
    const fixture = await setup(t, {
        mutate: async (dir, arch, file) => {
            if (file.endsWith(".dmg")) await fs.rm(path.join(dir, "MoltenTerm.app"), { recursive: true });
        },
    });
    await assert.rejects(verifyDeliveryArtifacts(fixture.manifest, inputs, fixture.options), /dmg \(arm64\)/);
    assert.equal(fixture.events.filter(({ args }) => args[0] === "detach").length, 1);
    assert.deepEqual(await ownedDirs(fixture.root), []);
});

test("missing artifacts, duplicate artifacts and linked artifacts fail before extraction", async (t) => {
    for (const mode of ["missing", "duplicate", "linked"]) {
        const fixture = await setup(t);
        if (mode === "missing") fixture.manifest.artifacts.pop();
        if (mode === "duplicate") fixture.manifest.artifacts[1] = fixture.manifest.artifacts[0];
        if (mode === "linked") {
            const file = fixture.manifest.artifacts[0];
            await fs.rename(file, `${file}.original`);
            await fs.symlink(`${file}.original`, file);
        }
        await assert.rejects(verifyDeliveryArtifacts(fixture.manifest, inputs, fixture.options), /failed at: layout/);
        assert.deepEqual(fixture.events, []);
        assert.deepEqual(await ownedDirs(fixture.root), []);
    }
});

test("payload audit rejects escaped links, linked apps, extra payloads and missing helpers", async (t) => {
    for (const mode of ["link", "app-link", "extra", "helper"]) {
        const fixture = await setup(t, {
            mutate: async (dir) => {
                const app = path.join(dir, "MoltenTerm.app");
                if (mode === "link") await fs.symlink(dir, path.join(app, "escape"));
                if (mode === "app-link") {
                    await fs.rename(app, `${app}.real`);
                    await fs.symlink(`${app}.real`, app);
                }
                if (mode === "extra") await fs.writeFile(path.join(dir, "extra"), "unexpected");
                if (mode === "helper")
                    await fs.unlink(path.join(app, "Contents/Resources/app.asar.unpacked/dist/bin/wavesrv.arm64"));
            },
        });
        await assert.rejects(verifyDeliveryArtifacts(fixture.manifest, inputs, fixture.options), /zip \(arm64\)/);
        assert.deepEqual(await ownedDirs(fixture.root), []);
    }
});

// Stored ZIP fixtures exercise the real locked extractor, with no external tool or Apple service.
function zipBytes(entries) {
    const local = [],
        central = [];
    let offset = 0;
    for (const { name, data = "", mode = 0o100644 } of entries) {
        const filename = Buffer.from(name),
            bytes = Buffer.from(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt32LE(crc32(bytes), 14);
        header.writeUInt32LE(bytes.length, 18);
        header.writeUInt32LE(bytes.length, 22);
        header.writeUInt16LE(filename.length, 26);
        local.push(header, filename, bytes);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(0x0314, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt32LE(crc32(bytes), 16);
        record.writeUInt32LE(bytes.length, 20);
        record.writeUInt32LE(bytes.length, 24);
        record.writeUInt16LE(filename.length, 28);
        record.writeUInt32LE((mode << 16) >>> 0, 38);
        record.writeUInt32LE(offset, 42);
        central.push(record, filename);
        offset += header.length + filename.length + bytes.length;
    }
    const index = Buffer.concat(central),
        end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(index.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, index, end]);
}

test("locked ZIP extractor preserves executable modes and contained framework symlinks", async (t) => {
    const root = await temporary(t),
        dir = path.join(root, "out"),
        file = path.join(root, "safe.zip");
    await fs.mkdir(dir);
    await fs.writeFile(
        file,
        zipBytes([
            { name: "Framework/Versions/A/binary", data: "payload", mode: 0o100755 },
            { name: "Framework/Versions/Current", data: "A", mode: 0o120777 },
        ])
    );
    await extractDeliveryZip(file, dir);
    assert.equal(await fs.readFile(path.join(dir, "Framework/Versions/Current/binary"), "utf8"), "payload");
    assert.ok((await fs.stat(path.join(dir, "Framework/Versions/A/binary"))).mode & 0o111);
});

test("locked ZIP extractor contains absolute paths and rejects traversal and escaping symlinks", async (t) => {
    const root = await temporary(t),
        outside = path.join(root, "outside");
    await fs.writeFile(outside, "sentinel");
    for (const [index, entries] of [
        [{ name: "../outside", data: "overwritten" }],
        [{ name: outside, data: "overwritten" }],
        [{ name: "escape", data: "../outside", mode: 0o120777 }],
        [
            { name: "escape", data: "..", mode: 0o120777 },
            { name: "escape/outside", data: "overwritten" },
        ],
    ].entries()) {
        const dir = path.join(root, `out-${index}`),
            file = path.join(root, `${index}.zip`);
        await fs.mkdir(dir);
        await fs.writeFile(file, zipBytes(entries));
        // The upstream extractor rebases an absolute member inside dir; traversal and escaped links fail.
        if (index === 1) await extractDeliveryZip(file, dir);
        else await assert.rejects(extractDeliveryZip(file, dir), `Unsafe ZIP fixture ${index} must fail`);
        assert.equal(await fs.readFile(outside, "utf8"), "sentinel");
    }
});
