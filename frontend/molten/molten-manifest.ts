// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A mod is a folder `<config>/mods/<mod-id>/` holding a `mod.json` manifest and the ES module named by `main`
// (DS-MORPH-001). The manifest is checked before any mod code is read, so a broken manifest never runs code.

export const MoltenSupportedApiVersions = [1];
export const MoltenManifestFileName = "mod.json";

const ModIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const MainPattern = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.(m?js)$/;

export type MoltenModManifest = {
    id: string;
    name: string;
    version: string;
    description: string;
    apiVersion: number;
    main: string;
    capabilities: string[];
};

export type MoltenManifestResult =
    | { ok: true; manifest: MoltenModManifest }
    | { ok: false; refused: boolean; error: string };

function invalid(error: string): MoltenManifestResult {
    return { ok: false, refused: false, error };
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}

export function parseMoltenManifest(folderName: string, text: string): MoltenManifestResult {
    let raw: any;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return invalid(`${MoltenManifestFileName} is not valid JSON: ${e.message}`);
    }
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return invalid(`${MoltenManifestFileName} must hold a JSON object`);
    }
    for (const field of ["id", "name", "version", "main"]) {
        if (!isNonEmptyString(raw[field])) {
            return invalid(`${MoltenManifestFileName}: "${field}" must be a non-empty string`);
        }
    }
    if (!ModIdPattern.test(raw.id)) {
        return invalid(
            `${MoltenManifestFileName}: "id" must use lowercase letters, digits, ".", "_" or "-" (got "${raw.id}")`
        );
    }
    if (raw.id !== folderName) {
        return invalid(`${MoltenManifestFileName}: "id" is "${raw.id}" but the folder is "${folderName}"`);
    }
    // A relative path inside the mod folder only: the host never reads code outside it.
    if (!MainPattern.test(raw.main) || raw.main.split("/").some((part: string) => part === "." || part === "..")) {
        return invalid(
            `${MoltenManifestFileName}: "main" must be a .js or .mjs file inside the mod folder (got "${raw.main}")`
        );
    }
    if (raw.description != null && typeof raw.description !== "string") {
        return invalid(`${MoltenManifestFileName}: "description" must be a string`);
    }
    if (
        raw.capabilities != null &&
        (!Array.isArray(raw.capabilities) || raw.capabilities.some((c: unknown) => typeof c !== "string"))
    ) {
        return invalid(`${MoltenManifestFileName}: "capabilities" must be a list of strings`);
    }
    if (!MoltenSupportedApiVersions.includes(raw.apiVersion)) {
        return {
            ok: false,
            refused: true,
            error: `apiVersion ${JSON.stringify(raw.apiVersion ?? null)} is not supported; supported versions: ${MoltenSupportedApiVersions.join(", ")}`,
        };
    }
    return {
        ok: true,
        manifest: {
            id: raw.id,
            name: raw.name,
            version: raw.version,
            description: raw.description ?? "",
            apiVersion: raw.apiVersion,
            main: raw.main,
            capabilities: raw.capabilities ?? [],
        },
    };
}
