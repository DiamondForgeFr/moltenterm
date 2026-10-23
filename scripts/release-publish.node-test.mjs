// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { publicContext, releaseFixture } from "./release-fixtures.mjs";
import { MAC_EVIDENCE } from "./release-inventory.mjs";
import { githubRemote, publishRelease, validatePublication } from "./release-publish.mjs";

async function fixture(t) {
    const folder = await releaseFixture(t, { signed: true });
    const publicKey = path.join(folder, "..", `${path.basename(folder)}.asc`);
    await fs.writeFile(publicKey, "fixture public key");
    t.after(() => fs.rm(publicKey, { force: true }));
    const writes = [],
        reads = [];
    let state = null,
        existing = folder;
    const remote = {
        inspect: async () => {
            reads.push("inspect");
            return state;
        },
        download: async () => {
            reads.push("download");
            return existing;
        },
        create: async (names) => writes.push(["create", names]),
    };
    const options = {
        folder,
        context: publicContext,
        publicKey,
        macosSigning: "developer-id",
        remote,
        verify: async () => {},
    };
    return {
        options,
        writes,
        reads,
        setState: (value) => {
            state = value;
        },
        setExisting: (value) => {
            existing = value;
        },
    };
}
test("all local gates run before publication mutations", async (t) => {
    for (const corruption of ["unsigned", "adhoc", "evidence", "signature", "feed", "mode"]) {
        const f = await fixture(t),
            { options } = f;
        if (corruption === "unsigned") await fs.rm(path.join(options.folder, "SHA256SUMS.txt.asc"));
        if (corruption === "adhoc") options.macosSigning = "adhoc";
        if (corruption === "evidence") await fs.rm(path.join(options.folder, MAC_EVIDENCE));
        if (corruption === "signature")
            options.verify = async () => {
                throw new Error("bad signature");
            };
        if (corruption === "feed") await fs.appendFile(path.join(options.folder, "latest-mac.yml"), "tampered");
        if (corruption === "mode") options.context = { ...publicContext, mode: "rehearsal" };
        await assert.rejects(publishRelease(options));
        assert.deepEqual(f.writes, []);
        assert.deepEqual(f.reads, []);
    }
});
test("complete validated output may create a new release but never repair an existing draft", async (t) => {
    const f = await fixture(t);
    const first = await publishRelease(f.options);
    assert.equal(first.action, "created");
    assert.deepEqual(f.writes, [["create", first.names]]);
    f.writes.length = 0;
    f.setState({ draft: true, names: first.names.slice(0, 2) });
    await assert.rejects(publishRelease(f.options), /incomplete.*repair it explicitly/);
    assert.deepEqual(f.writes, []);
    f.setState({ draft: true, names: [...first.names, "stale.deb"] });
    await assert.rejects(publishRelease(f.options), /unexpected assets/);
    assert.deepEqual(f.writes, []);
});
test("draft and published reruns verify every remote byte before making zero mutations", async (t) => {
    for (const draft of [true, false]) {
        const f = await fixture(t),
            names = await fs.readdir(f.options.folder);
        f.setState({ draft, names });
        assert.equal((await publishRelease(f.options)).action, "unchanged");
        assert.deepEqual(f.writes, []);
        f.setState({ draft, names: names.slice(1) });
        await assert.rejects(publishRelease(f.options), /incomplete/);
        f.setState({ draft, names });
        const remoteFolder = await releaseFixture(t, { signed: true });
        f.setExisting(remoteFolder);
        await fs.appendFile(path.join(remoteFolder, names[0]), "changed remote byte");
        await assert.rejects(publishRelease(f.options), /bytes differ/);
        assert.deepEqual(f.writes, []);
    }
});
test("optional candidate and rehearsal validation cannot bypass existing-key verification", async (t) => {
    const context = { ...publicContext, channel: "rc", version: "1.2.3-1" };
    const folder = await releaseFixture(t, { context });
    await validatePublication(folder, context, { macosSigning: "adhoc" });
    await assert.rejects(
        validatePublication(folder, context, { macosSigning: "adhoc", publicKey: path.join(folder, "SHA256SUMS.txt") }),
        /both be present/
    );
});
test("remote inspection failures never become permission to create", async () => {
    const remote = await githubRemote({
        folder: "fixture",
        context: publicContext,
        notes: "fixture",
        repo: "owner/repo",
        run: async () => {
            const error = new Error("network");
            error.stderr = "network unavailable";
            throw error;
        },
    });
    await assert.rejects(remote.inspect(), /refusing publication/);
});
