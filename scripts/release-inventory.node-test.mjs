// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { publicContext, releaseFixture } from "./release-fixtures.mjs";
import {
    CHECKSUMS,
    MAC_EVIDENCE,
    payloadNames,
    validateInventory,
    verifyChecksums,
    verifyMacEvidence,
    writeChecksums,
} from "./release-inventory.mjs";

test("checksums bind every payload, update feed, blockmap and macOS evidence", async (t) => {
    const folder = await releaseFixture(t);
    const names = await verifyChecksums(folder, publicContext, { macosSigning: "developer-id" });
    const sums = await fs.readFile(path.join(folder, CHECKSUMS), "utf8");
    for (const name of [...payloadNames(publicContext), MAC_EVIDENCE]) assert.ok(sums.includes(`  ${name}\n`));
    assert.equal(names.length, 17);
    await writeChecksums(folder, publicContext, { macosSigning: "developer-id" });
    assert.equal(await fs.readFile(path.join(folder, CHECKSUMS), "utf8"), sums);
    await assert.rejects(verifyChecksums(folder, publicContext, { macosSigning: "adhoc" }), /Developer ID/);
});

test("pinned builder AppImage metadata and Linux architecture names pass final inventory validation", async (t) => {
    const require = createRequire(import.meta.url);
    const builderRoot = path.dirname(require.resolve("app-builder-lib/package.json"));
    assert.equal(require(path.join(builderRoot, "package.json")).version, "26.17.0");
    const { appendBlockmap } = require(path.join(builderRoot, "out/targets/differentialUpdateInfoBuilder.js"));
    const { createUpdateInfoTasks, writeUpdateInfoFiles } = require(
        path.join(builderRoot, "out/publish/updateInfoBuilder.js")
    );
    const { Platform } = require(path.join(builderRoot, "out/core.js"));
    const { Arch, getArtifactArchName } = require("builder-util");
    const folder = await releaseFixture(t);
    const packager = {
        appInfo: { version: publicContext.version },
        platform: Platform.LINUX,
        config: {},
        platformSpecificBuildOptions: {},
        info: { metadata: { dependencies: { "electron-updater": "6.8.9" } } },
        getResource: async () => null,
        emitArtifactCreated: async () => {},
    };
    for (const arch of [Arch.x64, Arch.arm64]) {
        for (const ext of ["AppImage", "deb"])
            assert.ok(
                payloadNames(publicContext).includes(
                    `${publicContext.packageName}-linux-${getArtifactArchName(arch, ext)}-${publicContext.version}.${ext}`
                )
            );
        const name = `${publicContext.packageName}-linux-${getArtifactArchName(arch, "AppImage")}-${publicContext.version}.AppImage`;
        const file = path.join(folder, name);
        await fs.writeFile(file, Buffer.alloc(4096, 0x61));
        const updateInfo = await appendBlockmap(file);
        const tasks = await createUpdateInfoTasks(
            {
                file,
                arch,
                updateInfo,
                packager,
                target: { outDir: folder },
            },
            [{ provider: "github", owner: "fixture", repo: "fixture" }]
        );
        await writeUpdateInfoFiles(tasks, packager);
        const feed = parse(await fs.readFile(tasks[0].file, "utf8"));
        assert.equal(feed.files[0].blockMapSize, updateInfo.blockMapSize);
        assert.ok(updateInfo.blockMapSize > 0);
    }
    await writeChecksums(folder, publicContext, { macosSigning: "developer-id" });
    await verifyChecksums(folder, publicContext, { macosSigning: "developer-id" });
});

test("embedded blockmap metadata rejects unsafe sizes, inconsistent trailers and macOS entries", async (t) => {
    for (const size of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER, 0x100000000, 1, "mac"]) {
        const folder = await releaseFixture(t);
        const file = path.join(folder, size === "mac" ? "latest-mac.yml" : "latest-linux.yml");
        const feed = JSON.parse(await fs.readFile(file, "utf8"));
        feed.files[0].blockMapSize = size === "mac" ? 1 : size;
        await fs.writeFile(file, JSON.stringify(feed));
        await assert.rejects(verifyChecksums(folder, publicContext, { macosSigning: "developer-id" }), /blockmap/);
    }
});
test("same-extension substitution, extra files, symlinks and missing blockmaps fail", async (t) => {
    for (const corruption of ["substitution", "extra", "symlink", "blockmap"]) {
        const folder = await releaseFixture(t);
        const name = payloadNames(publicContext).find((name) => name.endsWith(".deb"));
        if (corruption === "substitution")
            await fs.rename(path.join(folder, name), path.join(folder, name.replace("1.2.3", "9.9.9")));
        if (corruption === "extra") await fs.writeFile(path.join(folder, "unexpected.zip"), "fixture");
        if (corruption === "symlink") {
            await fs.rm(path.join(folder, name));
            await fs.symlink(CHECKSUMS, path.join(folder, name));
        }
        if (corruption === "blockmap")
            await fs.rm(
                path.join(
                    folder,
                    payloadNames(publicContext).find((name) => name.endsWith(".blockmap"))
                )
            );
        await assert.rejects(verifyChecksums(folder, publicContext, { macosSigning: "developer-id" }));
    }
});
test("evidence binds final files, version, commit, run and attempt", async (t) => {
    const folder = await releaseFixture(t);
    for (const context of [
        { ...publicContext, sha: "b".repeat(40) },
        { ...publicContext, runId: "43" },
        { ...publicContext, runAttempt: "2" },
        { ...publicContext, version: "1.2.4" },
    ])
        await assert.rejects(verifyMacEvidence(folder, context));
    await fs.appendFile(
        path.join(
            folder,
            payloadNames(publicContext).find((name) => name.endsWith(".dmg"))
        ),
        "tampered"
    );
    await assert.rejects(verifyMacEvidence(folder, publicContext), /does not match/);
});
test("metadata hashes, architecture URLs and exact checksum coverage are enforced", async (t) => {
    for (const corruption of ["feed", "hash", "coverage", "evidence"]) {
        const folder = await releaseFixture(t);
        if (corruption === "feed") {
            const file = path.join(folder, "latest-linux.yml"),
                doc = JSON.parse(await fs.readFile(file));
            doc.files[0].url = "https://untrusted.invalid/payload.AppImage";
            await fs.writeFile(file, JSON.stringify(doc));
        }
        if (corruption === "hash")
            await fs.appendFile(
                path.join(
                    folder,
                    payloadNames(publicContext).find((name) => name.endsWith(".AppImage"))
                ),
                "tampered"
            );
        if (corruption === "coverage") await fs.appendFile(path.join(folder, CHECKSUMS), "unexpected coverage\n");
        if (corruption === "evidence") await fs.rm(path.join(folder, MAC_EVIDENCE));
        await assert.rejects(verifyChecksums(folder, publicContext, { macosSigning: "developer-id" }));
    }
});
test("unsigned rehearsal and candidate inventories remain admitted", async (t) => {
    for (const context of [
        { ...publicContext, mode: "rehearsal" },
        { ...publicContext, channel: "rc", version: "1.2.3-1" },
    ]) {
        const folder = await releaseFixture(t, { context });
        assert.ok((await verifyChecksums(folder, context, { macosSigning: "adhoc" })).includes(CHECKSUMS));
        await assert.rejects(validateInventory(folder, { ...context, channel: "unknown" }));
    }
});
