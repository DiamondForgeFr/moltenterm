// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../workspace-project", () => ({ ProjectMetaKey: "molten:project", WorkspaceFolderMetaKey: "molten:folder" }));

import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import settingsSchema from "../../../schema/settings.json";
import { integrationRunRows, integrationRunText } from "../agent-integration-runs";
import { hasKey, translate } from "../i18n/i18n-core";
import { SuiteIcons } from "../suite/suite-icons";
import {
    buildCatalog,
    clampSetting,
    groupEntries,
    groupSlug,
    isChanged,
    jsonSummary,
    localizeCatalog,
    localizeSection,
    localizeSettingEntry,
    multiOptionOn,
    multiToggled,
    searchSettings,
    sectionEntries,
    sectionTitle,
    settingChoices,
    SettingEntry,
    settingsCatalog,
    SettingsSchema,
    SettingsSections,
    UnknownGroup,
    WorkspaceSettings,
} from "./settings-catalog";
import { settingsGroupIcon, SettingsSectionConcepts } from "./settings-icons";

const schema = settingsSchema as SettingsSchema;
const props = schema.$defs.SettingsType.properties;

function catalog(platform = "darwin"): SettingEntry[] {
    return buildCatalog(schema, builtinDefaults as Record<string, unknown>, platform);
}

function entry(key: string, platform = "darwin"): SettingEntry {
    return catalog(platform).find((e) => e.key === key);
}

describe("settings catalog (FR-SHELL-050)", () => {
    it("maps every key of the schema to a section or hides it on purpose", () => {
        const unmapped = Object.entries(props)
            .filter(([, p]) => p["x-moltenterm"] == null)
            .map(([k]) => k);
        expect(unmapped).toEqual([]);
        const ids = SettingsSections.map((s) => s.id as string);
        for (const [key, p] of Object.entries(props)) {
            const meta = p["x-moltenterm"];
            if (meta.hidden) {
                continue;
            }
            expect(ids, key).toContain(meta.section);
            expect(meta.label, key).toBeTruthy();
            expect(meta.description, key).toBeTruthy();
        }
    });

    it("lists the sections in the screen's order, Advanced last", () => {
        expect(SettingsSections.map((s) => s.title)).toEqual([
            "General",
            "Appearance",
            "Terminal",
            "Agents",
            "Browser",
            "Project",
            "Keyboard",
            "Mods",
            "Secrets",
            "Advanced",
        ]);
    });

    it("gives each section but Advanced and Keyboard its own settings", () => {
        const all = [...WorkspaceSettings, ...catalog()];
        for (const s of SettingsSections.filter((s) => s.id !== "mods" && s.id !== "secrets")) {
            expect(sectionEntries(all, s.id).length, s.id).toBeGreaterThan(0);
        }
    });

    it("hides namespace resets, telemetry and Wave's inert updater", () => {
        const keys = catalog().map((e) => e.key);
        for (const key of ["app:*", "term:*", "telemetry:enabled", "autoupdate:enabled", "widget:showhelp"]) {
            expect(keys).not.toContain(key);
        }
    });

    it("never shows Wave's AI settings", () => {
        expect(catalog().some((e) => e.key.startsWith("ai:") || e.key.startsWith("waveai:"))).toBe(false);
    });

    it("puts a key without metadata under Advanced with its key as label and a control from its type", () => {
        const fake: SettingsSchema = {
            $defs: {
                SettingsType: {
                    properties: {
                        "new:flag": { type: "boolean", description: "A new flag" },
                        "new:mode": { type: "string", enum: ["a", "b"] },
                        "new:count": { type: "integer" },
                        "new:map": { type: "object" },
                    },
                },
            },
        };
        const entries = buildCatalog(fake, {}, "darwin");
        expect(entries.map((e) => [e.key, e.section, e.group, e.label, e.control])).toEqual([
            ["new:flag", "advanced", UnknownGroup, "new:flag", "toggle"],
            ["new:mode", "advanced", UnknownGroup, "new:mode", "select"],
            ["new:count", "advanced", UnknownGroup, "new:count", "number"],
            ["new:map", "advanced", UnknownGroup, "new:map", "json"],
        ]);
        expect(entries[0].description).toBe("A new flag");
        expect(entries[1].options).toEqual([
            { value: "a", label: "a" },
            { value: "b", label: "b" },
        ]);
    });

    it("reads the section, label and control of a described key", () => {
        const e = entry("term:scrollback");
        expect(e).toMatchObject({ section: "terminal", label: "Scrollback", control: "number", unit: "lines" });
        expect(e.defaultValue).toBe(2000);
        expect(entry("term:copyonselect").defaultValue).toBe(true);
    });

    it("shows platform-only settings on their platform", () => {
        expect(entry("term:macoptionismeta", "darwin")).toBeDefined();
        expect(entry("term:macoptionismeta", "linux")).toBeUndefined();
        expect(entry("term:gitbashpath", "windows")).toBeDefined();
        expect(entry("term:gitbashpath", "darwin")).toBeUndefined();
    });

    it("keeps the rows of a section in the metadata's order, by group", () => {
        const groups = groupEntries(sectionEntries(catalog(), "terminal")).map((g) => g.group);
        expect(groups).toEqual(["Look", "Behaviour", "Shell", "Connections"]);
    });
});

describe("workspace settings (FR-SHELL-050-AC4)", () => {
    it("marks the workspace's own settings and puts them first in General", () => {
        const all = settingsCatalog("darwin");
        const general = sectionEntries(all, "general");
        expect(general.slice(0, 2).map((e) => [e.key, e.scope])).toEqual([
            ["molten:folder", "workspace"],
            ["molten:project", "workspace"],
        ]);
        expect(all.filter((e) => e.scope === "workspace").every((e) => !(e.key in props))).toBe(true);
        expect(all.filter((e) => e.key in props).every((e) => e.scope === "global")).toBe(true);
    });
});

describe("settings search (FR-SHELL-050-AC2)", () => {
    const all = () => settingsCatalog("darwin");

    it("finds a setting by its label", () => {
        expect(searchSettings(all(), "scrollback")[0].key).toBe("term:scrollback");
        expect(searchSettings(all(), "Font size")[0].key).toBe("term:fontsize");
    });

    it("finds a setting by its key", () => {
        expect(searchSettings(all(), "term:osc52").map((e) => e.key)).toEqual(["term:osc52"]);
        expect(searchSettings(all(), "copyonselect")[0].key).toBe("term:copyonselect");
    });

    it("finds a setting by its description", () => {
        expect(searchSettings(all(), "desktop show through")[0].key).toBe("window:transparent");
        expect(searchSettings(all(), "dotfiles")[0].key).toBe("preview:showhiddenfiles");
    });

    it("needs every word, ignores case and accents, and ranks label matches first", () => {
        expect(searchSettings(all(), "SCROLLBACK lines").map((e) => e.key)).toEqual(["term:scrollback"]);
        expect(searchSettings(all(), "scrollback nothinglikethis")).toEqual([]);
        expect(searchSettings(all(), "  ")).toEqual([]);
        const theme = searchSettings(all(), "theme");
        expect(theme[0].key).toBe("term:theme");
    });

    it("finds the workspace settings", () => {
        expect(searchSettings(all(), "working folder")[0].key).toBe("molten:folder");
    });

    it("answers nothing for an unknown word", () => {
        expect(searchSettings(all(), "zzzz")).toEqual([]);
    });
});

describe("values", () => {
    it("shows Reset only for a value that differs from the default", () => {
        const scrollback = entry("term:scrollback");
        expect(isChanged(scrollback, undefined)).toBe(false);
        expect(isChanged(scrollback, 2000)).toBe(false);
        expect(isChanged(scrollback, 5000)).toBe(true);
        const blur = entry("window:blur");
        expect(isChanged(blur, false)).toBe(false);
        expect(isChanged(blur, true)).toBe(true);
        const gauges = entry("companion:usagegauges");
        expect(isChanged(gauges, [])).toBe(false);
        expect(isChanged(gauges, ["claude"])).toBe(true);
        expect(isChanged(entry("web:defaulturl"), builtinDefaults["web:defaulturl"])).toBe(false);
    });

    it("keeps a typed number inside the range and on the step", () => {
        const e = entry("tab:holdtoclosems");
        expect(clampSetting(e, "120")).toBe(200);
        expect(clampSetting(e, "9000")).toBe(2000);
        expect(clampSetting(e, "612")).toBe(600);
        expect(clampSetting(e, "abc")).toBeNull();
        expect(clampSetting(e, "")).toBeNull();
    });

    it("summarises what only the JSON file edits", () => {
        expect(jsonSummary(undefined)).toBe("Not set");
        expect(jsonSummary({ "a.com": "app", "b.com": "installed" })).toBe("2 entries");
        expect(jsonSummary(["-l"])).toBe("1 item");
    });
});

describe("settings in the interface language (FR-I18N-001)", () => {
    const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

    it("translates every shown row, its group, its options and the sections", () => {
        const all = localizeCatalog([...WorkspaceSettings, ...catalog()], fr);
        const quit = all.find((e) => e.key === "app:confirmquit");
        expect(quit.label).toBe("Confirmer avant de quitter");
        expect(quit.group).toBe("Quitter et fermer");
        const sleep = all.find((e) => e.key === "power:sleeppolicy");
        expect(sleep.unsetLabel).toBe("Demander la première fois");
        expect(sleep.options.find((o) => o.value === "letsleep").label).toBe("Jamais");
        expect(all.find((e) => e.key === "molten:folder").group).toBe("Cet espace de travail");
        const english = new Map([...WorkspaceSettings, ...catalog()].map((e) => [e.key, e]));
        const sameWord = ["Shell", "Minimap", "Zoom", "Git Bash"];
        const untranslated = all.filter((e) => e.label === english.get(e.key).label && !sameWord.includes(e.label));
        expect(untranslated.map((e) => e.key)).toEqual([]);
        expect(
            localizeSection(
                SettingsSections.find((s) => s.id === "advanced"),
                fr
            ).title
        ).toBe("Avancé");
        expect(sectionTitle("keyboard", fr)).toBe("Clavier");
        expect(searchSettings(all, "quitter")[0].key).toBe("app:confirmquit");
        expect(jsonSummary(["a", "b"], fr)).toBe("2 éléments");
    });

    it("words every unit the catalog uses (#741)", () => {
        const all = localizeCatalog(catalog(), fr);
        expect(all.find((e) => e.key === "term:scrollback").unit).toBe("lignes");
        expect(all.find((e) => e.key === "moltenterm:hiddentabviewsmb").unit).toBe("Mo");
        const units = new Set(
            catalog()
                .map((e) => e.unit)
                .filter((u) => !!u)
        );
        expect([...units].filter((u) => !hasKey(`settings.units.${u}`))).toEqual([]);
    });

    it("keeps the metadata's English for a setting the dictionaries do not know yet", () => {
        const fresh: SettingEntry = {
            key: "new:thing",
            section: "general",
            group: "Brand new group",
            label: "Brand new",
            description: "Not translated yet.",
            control: "select",
            options: [{ value: "a", label: "Alpha" }],
            unsetLabel: "Nothing",
            scope: "global",
            order: 0,
        };
        expect(localizeSettingEntry(fresh, fr)).toMatchObject({
            group: "Brand new group",
            label: "Brand new",
            description: "Not translated yet.",
            unsetLabel: "Nothing",
            options: [{ value: "a", label: "Alpha" }],
        });
        expect(groupSlug("Quitting and closing")).toBe("quittingAndClosing");
    });
});

describe("short choices as option rows (#658)", () => {
    const langs = [
        { code: "en", name: "English" },
        { code: "fr", name: "Français" },
    ];

    it("shows a select of four choices or fewer as rows, the unset choice first", () => {
        expect(settingChoices(entry("preview:defaultsort"), langs, "System").map((c) => c.value)).toEqual([
            "name",
            "modtime",
        ]);
        expect(settingChoices(entry("term:cursor"), langs, "System")).toHaveLength(3);
        expect(settingChoices(entry("browser:installed"), langs, "System")).toBeNull();
        expect(settingChoices(entry("term:theme"), langs, "System")).toBeNull();
        expect(settingChoices(entry("app:focusfollowscursor"), langs, "System")).not.toBeNull();
    });

    it("lists the languages after the system's while they fit", () => {
        expect(settingChoices(entry("app:language"), langs, "System (English)")).toEqual([
            { value: "", label: "System (English)" },
            { value: "en", label: "English" },
            { value: "fr", label: "Français" },
        ]);
        const many = ["en", "fr", "de", "es"].map((code) => ({ code, name: code }));
        expect(settingChoices(entry("app:language"), many, "System")).toBeNull();
    });

    it("keeps toggles, numbers and texts as they are", () => {
        const toggle = catalog().find((e) => e.control === "toggle");
        expect(settingChoices(toggle, langs, "System")).toBeNull();
    });

    it("gives every section and group a suite icon", () => {
        for (const id of Object.values(SettingsSectionConcepts)) {
            expect(SuiteIcons[id]).toBeTruthy();
        }
        for (const e of catalog()) {
            expect([e.group, settingsGroupIcon(groupSlug(e.group)) !== "tools" || e.group === UnknownGroup]).toEqual([
                e.group,
                true,
            ]);
        }
        expect(settingsGroupIcon("360View")).toBe("overview");
        expect(settingsGroupIcon("ciCd")).toBe("ci");
    });
});

describe("Agents with the integration (FR-SHELL-040, #947)", () => {
    it("shows agent:integrateoff inverted: a ticked agent gets the integration", () => {
        const entry = catalog().find((e) => e.key === "agent:integrateoff");
        expect(entry).toMatchObject({ label: "Agents with the hookup", inverted: true, control: "multi" });
        expect(entry.description).toMatch(/from now on/);
        expect(multiOptionOn(entry, null, "claude")).toBe(true);
        expect(multiOptionOn(entry, ["codex"], "codex")).toBe(false);
        expect(multiOptionOn(entry, ["codex"], "claude")).toBe(true);
        expect(multiToggled(entry, null, "codex")).toEqual(["codex"]);
        expect(multiToggled(entry, ["codex"], "codex")).toBeNull();
    });

    it("keeps a plain multi ticked when its value is in the list", () => {
        const entry = catalog().find((e) => e.key === "companion:usagegauges");
        expect(entry.inverted).toBeUndefined();
        expect(multiOptionOn(entry, ["claude"], "claude")).toBe(true);
        expect(multiOptionOn(entry, null, "claude")).toBe(false);
    });

    it("lists the running sessions with or without the integration", () => {
        const states = {
            b1: { blockid: "b1", agent: "claude", agentname: "Claude Code", firstname: "Valentin", version: 1 },
        };
        const rows = integrationRunRows(
            [
                { blockid: "b2", agent: "codex", integration: "off", browser: "none" },
                { blockid: "b1", agent: "claude", integration: "on", browser: "added" },
            ],
            states
        );
        expect(rows.map((r) => [r.label, integrationRunText(r.integration)])).toEqual([
            ["codex", "Without the hookup"],
            ["Valentin · Claude Code", "With the hookup"],
        ]);
    });
});
