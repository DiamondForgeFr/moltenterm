// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digest, macPayloadNames, payloadNames, writeChecksums, writeMacEvidence } from "./release-inventory.mjs";

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
    const feeds = {
        "latest-mac.yml": macPayloadNames(context).filter((name) => /\.(dmg|zip)$/.test(name)),
        "latest-linux.yml": payloads.filter((name) => name.includes("-x86_64-") && name.endsWith(".AppImage")),
        "latest-linux-arm64.yml": payloads.filter((name) => name.includes("-arm64-") && name.endsWith(".AppImage")),
    };
    for (const [feed, names] of Object.entries(feeds)) {
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
