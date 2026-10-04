// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A mod is a folder `<config>/mods/<mod-id>/` holding a `mod.json` manifest and the ES module named by `main`
// (DS-MORPH-001). The manifest is checked before any mod code is read, so a broken manifest never runs code.

export const MoltenSupportedApiVersions = [1];
export const MoltenManifestFileName = "mod.json";

const ModIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const MainPattern = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.(m?js)$/;

// The agent parts a mod may carry (FR-MORPH-010, DS-MORPH-009); must match pkg/molten/agentparts/agentparts.go
export const MoltenAgentClaudeCode = "claude-code";
export const MoltenSupportedAgents = [MoltenAgentClaudeCode];
const AgentFolderPattern = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const TargetVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export type MoltenAgentPart = {
    folder: string;
    targetVersion: string;
};

export type MoltenModManifest = {
    id: string;
    name: string;
    version: string;
    description: string;
    apiVersion: number;
    main: string;
    capabilities: string[];
    agents?: { "claude-code"?: MoltenAgentPart };
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

function isPlainObject(value: unknown): boolean {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

// The parts are only described here: the MoltenTerm host never runs them (the agent loads them itself).
function parseAgents(raw: any): { agents?: MoltenModManifest["agents"]; error?: string } {
    if (raw == null) {
        return {};
    }
    if (!isPlainObject(raw)) {
        return { error: `${MoltenManifestFileName}: "agents" must be an object keyed by agent id` };
    }
    for (const key of Object.keys(raw).sort()) {
        if (!MoltenSupportedAgents.includes(key)) {
            return {
                error: `${MoltenManifestFileName}: agent "${key}" is not supported; supported: ${MoltenSupportedAgents.join(", ")}`,
            };
        }
    }
    const entry = raw[MoltenAgentClaudeCode];
    if (entry == null) {
        return {};
    }
    const field = `"agents.${MoltenAgentClaudeCode}`;
    if (!isPlainObject(entry)) {
        return { error: `${MoltenManifestFileName}: ${field}" must be an object` };
    }
    if (!isNonEmptyString(entry.folder)) {
        return {
            error: `${MoltenManifestFileName}: ${field}.folder" must be a non-empty string (usually "agents/claude-code")`,
        };
    }
    if (!AgentFolderPattern.test(entry.folder)) {
        return {
            error: `${MoltenManifestFileName}: ${field}.folder" must be a relative path inside the mod folder (got "${entry.folder}")`,
        };
    }
    if (entry.folder.split("/").some((part: string) => part === "." || part === "..")) {
        return {
            error: `${MoltenManifestFileName}: ${field}.folder" must be a relative path inside the mod folder, with no "." or ".." segment (got "${entry.folder}")`,
        };
    }
    if (typeof entry.targetVersion !== "string" || !TargetVersionPattern.test(entry.targetVersion)) {
        return {
            error: `${MoltenManifestFileName}: ${field}.targetVersion" must be the Claude Code version the part was written for, as MAJOR.MINOR.PATCH (claude --version)`,
        };
    }
    return { agents: { [MoltenAgentClaudeCode]: { folder: entry.folder, targetVersion: entry.targetVersion } } };
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
    const agents = parseAgents(raw.agents);
    if (agents.error != null) {
        return invalid(agents.error);
    }
    if (!MoltenSupportedApiVersions.includes(raw.apiVersion)) {
        return {
            ok: false,
            refused: true,
            error: `apiVersion ${JSON.stringify(raw.apiVersion ?? null)} is not supported; supported versions: ${MoltenSupportedApiVersions.join(", ")}`,
        };
    }
    const manifest: MoltenModManifest = {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        description: raw.description ?? "",
        apiVersion: raw.apiVersion,
        main: raw.main,
        capabilities: raw.capabilities ?? [],
    };
    if (agents.agents != null) {
        manifest.agents = agents.agents;
    }
    return { ok: true, manifest };
}
