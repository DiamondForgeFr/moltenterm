// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digest, feedPayloadNames, payloadNames, writeChecksums, writeMacEvidence } from "./release-inventory.mjs";

export const publicContext = {
    mode: "release",
    channel: "public",
    version: "1.2.3",
    sha: "a".repeat(40),
    runId: "42",
    runAttempt: "1",
    productName: "MoltenTerm",
    packageName: "moltenterm",
};
export async function releaseFixture(t, { context = publicContext, signed = false } = {}) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "mt-release-test-"));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const payloads = payloadNames(context);
    for (const name of payloads) await fs.writeFile(path.join(folder, name), `fixture ${name}`);
    for (const [feed, listed] of Object.entries(feedPayloadNames(context))) {
        // As electron-builder writes them: the AppImage before the .deb, and `path` on the first entry.
        const names = [...listed].sort((a, b) => Number(b.endsWith(".AppImage")) - Number(a.endsWith(".AppImage")));
        const files = [];
        for (const name of names) {
            const info = await digest(path.join(folder, name), "sha512", "base64");
            files.push({ url: name, sha512: info.hash, size: info.size });
        }
        await fs.writeFile(
            path.join(folder, feed),
            JSON.stringify({ version: context.version, files, path: files[0].url, sha512: files[0].sha512 })
        );
    }
    if (context.mode === "release" && context.channel === "public")
        await writeMacEvidence(folder, context, { teamId: "ABCDEFGHIJ" });
    await writeChecksums(folder, context, { macosSigning: "developer-id" });
    if (signed) {
        const names = ["SHA256SUMS.txt", ...payloads.filter((name) => /\.(AppImage|deb)$/.test(name))];
        for (const name of names) await fs.writeFile(path.join(folder, `${name}.asc`), `signature fixture ${name}`);
    }
    return folder;
}
