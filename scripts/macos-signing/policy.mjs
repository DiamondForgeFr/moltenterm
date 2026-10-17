// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import path from "node:path";
import process from "node:process";

export const BUILDER_VERSION = "26.17.0";
export const APP_ID = "fr.diamondforge.moltenterm";
export const ARCHES = ["arm64", "x64"];
export const SIGNING_INPUTS = [
    "MACOS_CERTIFICATE_P12_BASE64",
    "MACOS_CERTIFICATE_PASSWORD",
    "MACOS_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "APPLE_API_KEY_BASE64",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
];
export const MODE_ADHOC = "adhoc";
export const MODE_DEVELOPER_ID = "developer-id";

// None set keeps the ad-hoc build until the certificates exist; a partial set is a configuration mistake and must
// never fall back to an unsigned public build.
export function signingMode(env) {
    const present = SIGNING_INPUTS.filter((name) => typeof env[name] === "string" && env[name] !== "");
    if (present.length === 0) return MODE_ADHOC;
    if (present.length !== SIGNING_INPUTS.length) {
        throw new Error(
            `Incomplete macOS signing inputs, missing: ${SIGNING_INPUTS.filter((name) => !present.includes(name)).join(", ")}`
        );
    }
    return MODE_DEVELOPER_ID;
}

function required(env, name) {
    const value = env[name];
    if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
        throw new Error(`Missing or invalid signing input: ${name}`);
    }
    return value;
}

function decode(env, name) {
    const encoded = required(env, name);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error(`Invalid base64 signing input: ${name}`);
    }
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length) throw new Error(`Empty signing input: ${name}`);
    return bytes;
}

export function signingIdentifiers(env) {
    const identity = required(env, "MACOS_SIGNING_IDENTITY");
    const teamId = required(env, "APPLE_TEAM_ID");
    const keyId = required(env, "APPLE_API_KEY_ID");
    const issuer = required(env, "APPLE_API_ISSUER");
    if (!/^[A-Fa-f0-9]{40}$/.test(identity)) throw new Error("Expected an explicit signing certificate fingerprint");
    if (!/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId))
        throw new Error("Invalid Apple team or key identifier");
    if (!/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(issuer))
        throw new Error("Invalid Apple API issuer");
    return { identity: identity.toUpperCase(), teamId, keyId, issuer };
}

export function signingInputs(env, platform = process.platform) {
    if (platform !== "darwin") throw new Error("Developer ID packaging requires a macOS runner");
    const identifiers = signingIdentifiers(env);
    const certificate = decode(env, "MACOS_CERTIFICATE_P12_BASE64");
    const password = required(env, "MACOS_CERTIFICATE_PASSWORD");
    const apiKey = decode(env, "APPLE_API_KEY_BASE64");
    if (!/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\s*$/.test(apiKey.toString("utf8"))) {
        throw new Error("Invalid Apple API private-key container");
    }
    return { ...identifiers, certificate, password, apiKey };
}

export function checkedIdentity(output, inputs) {
    const identities = [...output.matchAll(/\b([A-Fa-f0-9]{40})\s+"([^"\r\n]+)"/g)];
    if (
        identities.length !== 1 ||
        identities[0][1].toUpperCase() !== inputs.identity ||
        !identities[0][2].startsWith("Developer ID Application: ") ||
        !identities[0][2].endsWith(`(${inputs.teamId})`)
    ) {
        throw new Error("The owned keychain must contain exactly the expected Developer ID Application identity");
    }
}

export function appleRequirement(teamId) {
    if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Invalid Apple team identifier");
    return `anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
}

export function binaryFormat(header) {
    const magic = header.subarray(0, 4).toString("hex");
    if (
        ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic)
    )
        return "macho";
    if (magic === "7f454c46") return "elf";
    if (header[0] === 0x4d && header[1] === 0x5a) return "pe";
    return "other";
}

export function embeddedKind(file, version, appArch) {
    const name = path.basename(file);
    if (
        name === `wavesrv.${appArch}` ||
        ARCHES.some((arch) => name === `wsh-${version}-darwin.${arch}` || name === `molten-${version}-darwin.${arch}`)
    )
        return "darwin";
    if (
        new RegExp(`^(?:wsh|molten)-${escapeRegExp(version)}-linux\\.(?:arm64|x64|mips|mipsle|mips64|mips64le)$`).test(
            name
        )
    )
        return "elf";
    if (new RegExp(`^wsh-${escapeRegExp(version)}-windows\\.(?:arm64|x64)\\.exe$`).test(name)) return "pe";
    throw new Error("Unexpected embedded executable name or version");
}

// Keep in step with Taskfile.yml build:wsh. Remote provisioning needs the foreign payloads too.
export function embeddedNames(version, appArch) {
    return [
        `wavesrv.${appArch}`,
        ...ARCHES.flatMap((arch) => [`wsh-${version}-darwin.${arch}`, `molten-${version}-darwin.${arch}`]),
        ...["arm64", "x64", "mips", "mips64"].map((arch) => `wsh-${version}-linux.${arch}`),
        ...ARCHES.map((arch) => `wsh-${version}-windows.${arch}.exe`),
        ...ARCHES.map((arch) => `molten-${version}-linux.${arch}`),
    ];
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function localArtifactName(value) {
    if (
        typeof value !== "string" ||
        !value ||
        value === "." ||
        value === ".." ||
        /[/\\?#%\r\n\0]/.test(value) ||
        path.basename(value) !== value
    ) {
        throw new Error("Expected an unambiguous local artifact basename");
    }
    return value;
}

export function assertWithin(root, file) {
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
        throw new Error("Artifact escapes its owned output directory");
    return file;
}

export function checkedSignature(output, inputs, { runtime = true, app = false } = {}) {
    if (
        !output.includes(`TeamIdentifier=${inputs.teamId}`) ||
        !/^Authority=Developer ID Application: /m.test(output) ||
        /^Signature=adhoc$/m.test(output) ||
        !/^Timestamp=.+/m.test(output) ||
        (runtime && !/(?:^|\s)flags=[^\n]*\bruntime\b/m.test(output)) ||
        (app && !output.includes(`Identifier=${APP_ID}\n`))
    ) {
        throw new Error("Missing expected Developer ID signature evidence");
    }
}
