// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashFile } from "./artifacts.mjs";
import { APP_ID, ARCHES, embeddedNames, signingInputs } from "./policy.mjs";

// These deliberately invalid private-key/certificate bytes are never passed to Apple tools.
export const fakeEnv = {
    MACOS_SIGNING_IDENTITY: "A".repeat(40),
    APPLE_TEAM_ID: "TESTTEAM01",
    APPLE_API_KEY_ID: "KEY0000001",
    APPLE_API_ISSUER: "11111111-2222-3333-4444-555555555555",
    MACOS_CERTIFICATE_PASSWORD: "dummy-secret-password",
    MACOS_CERTIFICATE_P12_BASE64: Buffer.from("not-a-real-certificate").toString("base64"),
    APPLE_API_KEY_BASE64: Buffer.from("-----BEGIN PRIVATE KEY-----\nDUMMY-ONLY\n-----END PRIVATE KEY-----\n").toString(
        "base64"
    ),
};
export const inputs = signingInputs(fakeEnv, "darwin");
export const version = "1.0.0-4";
export const jsonYaml = { load: JSON.parse, dump: (value) => JSON.stringify(value, null, 2) };

export async function temporary(t) {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "mt507-fixture-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

export function securityFixture({ failAt = -1 } = {}) {
    const calls = [];
    let list = ["/unrelated/login.keychain-db"],
        count = 0;
    return {
        calls,
        signals: new EventEmitter(),
        addUnrelated(file) {
            list.push(file);
        },
        get list() {
            return list;
        },
        async run(file, args) {
            calls.push({ file, args });
            if (count++ === failAt)
                throw new Error(
                    `Dummy raw failure ${fakeEnv.MACOS_CERTIFICATE_PASSWORD} ${fakeEnv.APPLE_API_KEY_BASE64}`
                );
            if (args[0] === "list-keychains" && args.length === 3)
                return { stdout: list.map((file) => `    "${file}"`).join("\n"), stderr: "" };
            if (args[0] === "list-keychains") list = args.slice(4);
            if (args[0] === "create-keychain") await fs.writeFile(args.at(-1), "dummy-keychain", { mode: 0o600 });
            if (args[0] === "find-identity")
                return {
                    stdout: `1) ${inputs.identity} "Developer ID Application: Dummy (${inputs.teamId})"\n  1 valid identities found`,
                    stderr: "",
                };
            return { stdout: "", stderr: "" };
        },
    };
}

export async function appFixture(root, arch) {
    // The builder's own folder names: "mac" for x64, "mac-arm64" for arm64.
    const app = path.join(root, arch === "x64" ? "mac" : `mac-${arch}`, "MoltenTerm.app");
    const bin = path.join(app, "Contents/Resources/app.asar.unpacked/dist/bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
    const macho = Buffer.from("cffaedfe00000000", "hex");
    await fs.writeFile(path.join(app, "Contents/MacOS/MoltenTerm"), macho, { mode: 0o755 });
    const names = [
        `wavesrv.${arch}`,
        ...ARCHES.flatMap((a) => [`wsh-${version}-darwin.${a}`, `molten-${version}-darwin.${a}`]),
    ];
    for (const name of names) await fs.writeFile(path.join(bin, name), macho, { mode: 0o755 });
    for (const name of embeddedNames(version, arch).filter((name) => !names.includes(name))) {
        await fs.writeFile(
            path.join(bin, name),
            Buffer.from(name.includes("windows") ? "4d5a000102030405" : "7f454c4600010203", "hex")
        );
    }
    return { path: app, arch, bin };
}

export async function artifactFixture(root) {
    const apps = await Promise.all(ARCHES.map((arch) => appFixture(root, arch)));
    const artifacts = ARCHES.flatMap((arch) =>
        ["zip", "dmg"].map((ext) => path.join(root, `MoltenTerm-darwin-${arch}-${version}.${ext}`))
    );
    for (const file of artifacts) await fs.writeFile(file, `dummy artifact ${path.basename(file)}`);
    const files = await Promise.all(
        artifacts.map(async (file) => ({ url: path.basename(file), ...(await hashFile(file)) }))
    );
    const document = {
        version,
        files,
        path: files[0].url,
        sha512: files[0].sha512,
        releaseDate: "2026-10-17T12:00:00.000Z",
        releaseNotes: "Keep this release information",
    };
    const metadata = [path.join(root, "latest-mac.yml"), path.join(root, "beta-mac.yml")];
    for (const file of metadata) await fs.writeFile(file, jsonYaml.dump(document));
    return { outDir: root, version, apps, artifacts, metadata, document };
}

export function verificationFixture({ reject = () => false, entitlements = {}, signature } = {}) {
    const calls = [];
    return {
        calls,
        async run(file, args, options) {
            calls.push({ file, args, options });
            if (reject(file, args)) throw new Error(`Sensitive raw failure ${fakeEnv.MACOS_CERTIFICATE_PASSWORD}`);
            let stdout = "",
                stderr = "";
            if (file.endsWith("lipo")) {
                const target = args.at(-1);
                const x64 = target.endsWith("/MoltenTerm")
                    ? target.includes(`${path.sep}mac${path.sep}`)
                    : target.endsWith("x64");
                stdout = x64 ? "x86_64\n" : "arm64\n";
            }
            if (file.endsWith("codesign") && args.includes("--verbose=4"))
                stderr =
                    signature ??
                    `Identifier=${APP_ID}\nAuthority=Developer ID Application: Dummy (${inputs.teamId})\nTeamIdentifier=${inputs.teamId}\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1\nTimestamp=Oct 17, 2026\n`;
            if (file.endsWith("codesign") && args.includes(":-")) stdout = "<plist><dict/></plist>";
            if (file.endsWith("plutil")) stdout = JSON.stringify(entitlements);
            return { stdout, stderr };
        },
    };
}

// A project folder with only what package.mjs reads: package.json and the builder config's naming.
export async function projectFixture(t) {
    const root = await temporary(t);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ productName: "MoltenTerm", version }));
    await fs.writeFile(
        path.join(root, "electron-builder.config.cjs"),
        `module.exports = { artifactName: "\${productName}-\${platform}-\${arch}-\${version}.\${ext}", directories: { output: "make" } };\n`
    );
    return root;
}

// Stands for the electron-builder process: calls the sign hook for both apps, then writes the artifacts and the
// update files the way the builder does, with DMG hashes taken before notarization.
export function fakeBuilder(projectDir, { sign, exitCode = 0, events = [] } = {}) {
    const calls = [];
    return {
        calls,
        async runProcess(file, args, options) {
            calls.push({ file, args, options });
            events.push("builder");
            if (options.signal?.aborted) throw new Error("Signing packaging interrupted");
            const fixture = await artifactFixture(path.join(projectDir, "make"));
            for (const app of fixture.apps) await sign?.(app, options.env);
            if (exitCode !== 0) throw new Error("Signing packaging failed");
            return fixture;
        },
    };
}

export async function fakeBlockMap(file, format, sidecar) {
    if (format !== "gzip") throw new Error("Unexpected blockmap format");
    await fs.writeFile(sidecar, `dummy-blockmap:${(await hashFile(file)).sha512}`);
    return hashFile(file);
}
