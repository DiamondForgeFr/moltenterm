// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Language packs in the mod host (FR-I18N-002): data-only mods load without trust and without code, a pack that
// breaks a placeholder is refused whole, and the host hands the packs to the dictionaries after each sync.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguagePackInput } from "../moltenterm-shell/i18n/language-packs";
import { MoltenHost, MoltenHostEnv } from "./molten-host";
import { parseMoltenManifest } from "./molten-manifest";
import { validateMoltenMod } from "./molten-validate";

const ModsDir = "/cfg/mods";
const StateFile = "/cfg/molten/mods.json";
const TrustFile = "/data/molten/trust.json";

type Files = Record<string, string>;

function packManifest(id: string, code = "es", extra?: any) {
    return JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        apiVersion: 1,
        languages: [{ code, name: code === "es" ? "Español" : code, file: `locales/${code}.json` }],
        ...extra,
    });
}

function makeEnv(files: Files, state: any, applied: LanguagePackInput[][]): MoltenHostEnv {
    return {
        modsDir: ModsDir,
        stateFile: StateFile,
        trustFile: TrustFile,
        listDir: async () => {
            const ids = new Set(Object.keys(files).map((p) => p.slice(ModsDir.length + 1).split("/")[0]));
            return [...ids].map((name) => ({ name, isDir: true }));
        },
        readTextFile: async (path: string) => {
            if (path === StateFile) return JSON.stringify(state);
            if (path === TrustFile) return JSON.stringify({ trusted: {} });
            return files[path] ?? null;
        },
        importModule: vi.fn(async () => {
            throw new Error("a language pack must never be imported");
        }),
        writeClipboard: async () => {},
        applyLanguagePacks: (packs) => applied.push(packs),
    };
}

let host: MoltenHost;

beforeEach(() => {
    MoltenHost.resetInstance();
    host = MoltenHost.getInstance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("language packs in the mod host (FR-I18N-002)", () => {
    it("loads an enabled pack without trust and without importing code (AC6, TC-I18N-013)", async () => {
        const applied: LanguagePackInput[][] = [];
        const env = makeEnv(
            {
                [`${ModsDir}/lang-es/mod.json`]: packManifest("lang-es"),
                [`${ModsDir}/lang-es/locales/es.json`]: JSON.stringify({ common: { close: "Cerrar" }, bogus: "x" }),
            },
            { enabled: ["lang-es"], enabledat: { "lang-es": "2026-10-14T10:00:00Z" } },
            applied
        );
        await host.start(env);
        const status = host.listMods().mods.find((m) => m.id === "lang-es");
        expect(status).toMatchObject({ state: "active", dataonly: true, languages: ["es"], commands: [] });
        expect(status.warnings[0]).toContain('"bogus" is not an English key');
        expect(env.importModule).not.toHaveBeenCalled();
        const last = applied[applied.length - 1];
        expect(last).toHaveLength(1);
        expect(last[0]).toMatchObject({ modId: "lang-es", code: "es", name: "Español" });
        expect(last[0].dict).toEqual({ common: { close: "Cerrar" } });
        expect(last[0].enabledAt).toBe(Date.parse("2026-10-14T10:00:00Z"));
    });

    it("refuses a pack that breaks a placeholder and applies nothing of it (AC2, TC-I18N-010)", async () => {
        const applied: LanguagePackInput[][] = [];
        await host.start(
            makeEnv(
                {
                    [`${ModsDir}/lang-es/mod.json`]: packManifest("lang-es"),
                    [`${ModsDir}/lang-es/locales/es.json`]: JSON.stringify({
                        common: { close: "Cerrar" },
                        language: { system: "Igual que el sistema ({n})" },
                    }),
                },
                { enabled: ["lang-es"] },
                applied
            )
        );
        const status = host.listMods().mods.find((m) => m.id === "lang-es");
        expect(status.state).toBe("refused");
        expect(status.error).toContain('"language.system"');
        expect(status.error).toContain("{name}");
        expect(applied[applied.length - 1]).toEqual([]);
    });

    it("keeps a disabled pack off", async () => {
        const applied: LanguagePackInput[][] = [];
        await host.start(
            makeEnv(
                {
                    [`${ModsDir}/lang-es/mod.json`]: packManifest("lang-es"),
                    [`${ModsDir}/lang-es/locales/es.json`]: "{}",
                },
                { enabled: [] },
                applied
            )
        );
        expect(host.listMods().mods[0].state).toBe("disabled");
        expect(applied[applied.length - 1]).toEqual([]);
    });

    it("loads packs in a view that does not show, but no code mod", async () => {
        const applied: LanguagePackInput[][] = [];
        host.showing = false;
        const env = makeEnv(
            {
                [`${ModsDir}/lang-es/mod.json`]: packManifest("lang-es"),
                [`${ModsDir}/lang-es/locales/es.json`]: JSON.stringify({ common: { close: "Cerrar" } }),
                [`${ModsDir}/code/mod.json`]: JSON.stringify({
                    id: "code",
                    name: "code",
                    version: "1",
                    apiVersion: 1,
                    main: "main.js",
                }),
                [`${ModsDir}/code/main.js`]: "export function activate() {}",
            },
            { enabled: ["lang-es", "code"] },
            applied
        );
        await host.start(env);
        const mods = host.listMods().mods;
        expect(mods.find((m) => m.id === "lang-es").state).toBe("active");
        expect(mods.find((m) => m.id === "code").state).toBe("untrusted");
        expect(applied[applied.length - 1].map((p) => p.code)).toEqual(["es"]);
    });

    it("does not load packs in safe mode", async () => {
        const applied: LanguagePackInput[][] = [];
        await host.start(
            makeEnv(
                {
                    [`${ModsDir}/lang-es/mod.json`]: packManifest("lang-es"),
                    [`${ModsDir}/lang-es/locales/es.json`]: "{}",
                },
                { enabled: ["lang-es"] },
                applied
            ),
            { safeMode: true }
        );
        expect(host.listMods().mods[0].state).toBe("safemode");
        expect(applied).toEqual([[]]);
    });

    it("validates a pack with the load check (molten mod validate)", async () => {
        const files: Files = {
            [`${ModsDir}/lang-es/mod.json`]: packManifest("lang-es"),
            [`${ModsDir}/lang-es/locales/es.json`]: JSON.stringify({ language: { system: "({nombre})" }, x: "y" }),
        };
        const result = await validateMoltenMod(ModsDir, "lang-es", async (p) => files[p] ?? null);
        expect(result.ok).toBe(false);
        expect(result.problems.map((p) => p.severity ?? "error")).toEqual(["error", "warning"]);
        expect(result.problems[0]).toMatchObject({ file: "locales/es.json" });
        expect(result.problems[0].message).toContain("{nombre}");
    });
});

describe("language pack manifest (DS-I18N-008)", () => {
    it("accepts languages without main", () => {
        const parsed = parseMoltenManifest("lang-es", packManifest("lang-es"));
        expect(parsed.ok && parsed.manifest.languages).toEqual([
            { code: "es", name: "Español", file: "locales/es.json" },
        ]);
        expect(parsed.ok && parsed.manifest.main).toBe("");
    });

    it("refuses a pack that also names code (TC-I18N-013)", () => {
        const withMain = parseMoltenManifest("lang-es", packManifest("lang-es", "es", { main: "main.js" }));
        expect(withMain.ok === false && withMain.error).toContain("runs no code");
        const withAgents = parseMoltenManifest(
            "lang-es",
            packManifest("lang-es", "es", { agents: { "claude-code": { folder: "x", targetVersion: "1.0.0" } } })
        );
        expect(withAgents.ok).toBe(false);
    });

    it("refuses bad language entries", () => {
        const bad = (languages: any) =>
            parseMoltenManifest("p", JSON.stringify({ id: "p", name: "p", version: "1", apiVersion: 1, languages })).ok;
        expect(bad([])).toBe(false);
        expect(bad([{ code: "spanish", name: "x", file: "locales/es.json" }])).toBe(false);
        expect(bad([{ code: "es", name: "", file: "locales/es.json" }])).toBe(false);
        expect(bad([{ code: "es", name: "Español", file: "../es.json" }])).toBe(false);
        expect(bad([{ code: "es", name: "Español", file: "es.js" }])).toBe(false);
        expect(bad([{ code: "pt_BR", name: "Português", file: "locales/pt-br.json" }])).toBe(true);
    });
});
