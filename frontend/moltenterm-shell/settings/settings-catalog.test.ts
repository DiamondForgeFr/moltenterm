// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("../workspace-project", () => ({ ProjectMetaKey: "molten:project", WorkspaceFolderMetaKey: "molten:folder" }));

import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import settingsSchema from "../../../schema/settings.json";
import { integrationRunRows, integrationRunText } from "../agent-integration-runs";
import { BrokkTableGroup, BrokkTableKey } from "../boss/brokk-coming-card";
import { hasKey, translate } from "../i18n/i18n-core";
import { SuiteIcons } from "../suite/suite-icons";
import {
    buildCatalog,
    clampSetting,
    ConfirmOnKeys,
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
            "Workspaces and views",
            "Appearance",
            "Terminal",
            "Agents",
            "Brokk",
            "Browser",
            "Project",
            "Notifications",
            "Keyboard",
            "Mods",
            "Secrets",
            "What MoltenTerm learned",
            "Tips",
            "About",
            "Advanced",
        ]);
    });

    // FR-SHELL-106: the sidebar and new views live with the workspaces; the per-site lists stay in Browser.
    it("gathers the sidebar and new views in Workspaces and views", () => {
        const spaces = sectionEntries(catalog(), "spaces").map((e) => e.key);
        expect(spaces).toEqual(["moltenterm:sidebartint", "app:newviewopen"]);
        expect(sectionEntries(catalog(), "general").map((e) => e.key)).not.toContain("app:newviewopen");
        expect(sectionEntries(catalog(), "appearance").map((e) => e.key)).not.toContain("moltenterm:sidebartint");
        const browser = sectionEntries(catalog(), "browser").map((e) => e.key);
        for (const key of [
            "browser:sites",
            "browser:agentsites",
            "browser:sitepermissions",
            "browser:clientcertificates",
        ]) {
            expect(browser).toContain(key);
        }
    });

    // The Library's Settings page lists SettingsSections as they are: Tips is one of them, so the lists cannot drift.
    it("gives Preferences and the Library one list of sections, Tips included", () => {
        const ids = SettingsSections.map((s) => s.id as string);
        expect(ids).toContain("tips");
        expect(ids).toContain("notifications");
        for (const s of SettingsSections) {
            expect(s.icon, s.id).toBeTruthy();
            expect(SettingsSectionConcepts[s.id], s.id).toBeTruthy();
        }
    });

    // Notifications, Mods, Secrets, What MoltenTerm learned, Tips and About hold what settings.json does not.
    it("gives each section but Advanced and Keyboard its own settings", () => {
        const all = [...WorkspaceSettings, ...catalog()];
        const noKeys = ["mods", "secrets", "learned", "notifications", "tips", "about"];
        for (const s of SettingsSections.filter((s) => !noKeys.includes(s.id))) {
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

describe("workspace settings (FR-SHELL-050-AC4, FR-SHELL-101)", () => {
    it("marks the workspace's own settings and keeps them out of General, a section for the whole app", () => {
        const all = settingsCatalog("darwin");
        expect(all.filter((e) => e.scope === "workspace").map((e) => e.key)).toEqual([
            "molten:folder",
            "molten:project",
        ]);
        for (const s of SettingsSections) {
            expect(
                sectionEntries(all, s.id).every((e) => e.scope === "global"),
                s.id
            ).toBe(true);
        }
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
        expect(theme.slice(0, 2).map((e) => e.key)).toEqual(["moltenterm:theme", "term:theme"]);
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
        const transparent = entry("window:transparent");
        expect(isChanged(transparent, false)).toBe(false);
        expect(isChanged(transparent, true)).toBe(true);
        const blur = entry("window:blur");
        expect(isChanged(blur, true)).toBe(false);
        expect(isChanged(blur, false)).toBe(true);
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
        const requests = all.find((e) => e.key === "power:terminalrequests");
        expect(requests.unsetLabel).toBe("Demander la première fois");
        expect(requests.options.find((o) => o.value === "never").label).toBe("Jamais");
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
            "type",
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

describe("the foreman's section (FR-BOSS-001, AC4, AC8, AC9)", () => {
    const boss = SettingsSections.find((s) => s.id === "boss");
    const tr = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
    const trFr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

    it("holds the name, Show the avatar and his proximity, then the table of when he comes, and no longer the bubble's collapse (FR-BOSS-009, AC4, AC13, AC75)", () => {
        const keys = sectionEntries(catalog(), "boss").map((e) => e.key);
        expect(keys.slice(0, 3)).toEqual(["boss:name", "boss:show", "boss:proximity"]);
        // His agent's permission requests (#2257), before the table.
        expect(keys[3]).toBe("boss:autoapprove");
        expect(keys.slice(4)).toEqual([
            "boss:visitsecurity",
            "boss:visitblocked",
            "boss:visiterror",
            "boss:visitci",
            "boss:visitready",
            "boss:visitfinished",
            "boss:visitdownload",
            "boss:visitupdate",
            "boss:visitusage",
            "boss:blockedmin",
            "boss:quiet",
            "boss:quietfrom",
            "boss:quietto",
            "boss:nevercome",
        ]);
        expect(entry("boss:collapseontype")).toBeUndefined();
    });

    // #2257: approving his agent's requests without asking is never on unless the developer set it, and turning it on
    // asks one explicit confirmation that says what it allows, in both languages.
    it("keeps his agent's auto-approval off by default, behind an explicit confirmation", () => {
        const auto = entry("boss:autoapprove");
        expect(auto).toMatchObject({ control: "toggle", group: "His agent" });
        expect(auto.defaultValue ?? false).toBe(false);
        expect(ConfirmOnKeys.has("boss:autoapprove")).toBe(true);
        for (const translateTo of [tr, trFr]) {
            for (const part of ["confirm", "confirmOn", "confirmCancel"]) {
                const key = `settings.items.boss:autoapprove.${part}`;
                expect(translateTo(key), key).not.toBe(key);
            }
        }
        expect(tr("settings.items.boss:autoapprove.confirm")).toMatch(/without asking/);
        expect(tr("settings.items.boss:autoapprove.confirm")).toMatch(/still asks/);
    });

    it("draws the keys of the table as one group, the one the card of Preferences replaces the rows of", () => {
        const table = sectionEntries(catalog(), "boss").filter(
            (e) =>
                e.key !== "boss:name" &&
                e.key !== "boss:show" &&
                e.key !== "boss:proximity" &&
                e.key !== "boss:autoapprove"
        );
        expect(new Set(table.map((e) => e.group))).toEqual(new Set([BrokkTableGroup]));
        expect(table[0].key).toBe(BrokkTableKey);
    });

    // FR-BOSS-009, AC75 (#2203): a scale that grows (1.1.0 adds Close and Partner), so a choice and not a switch.
    it("holds Brokk's proximity as a choice of two levels, Colleague by default, each with a line saying what it does", () => {
        const proximity = entry("boss:proximity");
        expect(proximity).toMatchObject({ control: "select", defaultValue: "colleague", group: "Avatar" });
        expect(proximity.options.map((o) => o.value)).toEqual(["discreet", "colleague"]);
        for (const [code, translateTo] of [
            ["en", tr],
            ["fr", trFr],
        ] as const) {
            const localized = localizeSettingEntry(proximity, translateTo);
            const choices = settingChoices(localized, [], "");
            expect(
                choices.map((c) => c.value),
                code
            ).toEqual(["discreet", "colleague"]);
            for (const choice of choices) {
                expect(choice.hint, `${code} ${choice.value}`).toMatch(/\S/);
                expect(choice.hint).not.toMatch(/\n/);
            }
        }
        const english = settingChoices(localizeSettingEntry(proximity, tr), [], "");
        expect(english.find((c) => c.value === "colleague").hint).toContain("only gets the time of day");
        expect(english.find((c) => c.value === "discreet").hint).toContain("nothing goes to his model");
    });

    it("shows the avatar by default, as a toggle", () => {
        expect(entry("boss:show")).toMatchObject({ control: "toggle", defaultValue: true, label: "Show the avatar" });
    });

    it("takes a name of 1 to 24 characters, Brokk by default", () => {
        expect(entry("boss:name")).toMatchObject({
            control: "text",
            defaultValue: "Brokk",
            range: { min: 1, max: 24 },
        });
    });

    it("is titled with the name the developer chose, in both languages", () => {
        expect(localizeSection(boss, tr, "Brokk").title).toBe("Brokk");
        expect(localizeSection(boss, tr, "Léa").title).toBe("Léa");
        expect(localizeSection(boss, trFr, "Léa").title).toBe("Léa");
        expect(sectionTitle("boss", tr, "Gaston")).toBe("Gaston");
        expect(localizeSection(boss, tr, "Léa").description).toBe(
            "The avatar that counts what waits for you in every workspace."
        );
    });

    it("leaves the other sections' titles alone", () => {
        const agents = SettingsSections.find((s) => s.id === "agents");
        expect(localizeSection(agents, tr, "Léa").title).toBe("Agents");
    });

    it("speaks French for its settings and the table's rows", () => {
        const localized = localizeCatalog(sectionEntries(catalog(), "boss"), trFr);
        expect(localized.slice(0, 3).map((e) => e.label)).toEqual(["Nom", "Afficher l'avatar", "Proximité"]);
        expect(localized.slice(0, 3).every((e) => e.group === "Avatar")).toBe(true);
        expect(localized[3]).toMatchObject({
            key: "boss:autoapprove",
            label: "Approuver les demandes de son agent sans me demander",
            group: "Son agent",
        });
        const table = localized.slice(4);
        expect(table.every((e) => e.group === "Quand il vient me chercher")).toBe(true);
        expect(table.find((e) => e.key === "boss:visitblocked").label).toBe("Un agent attend ma réponse");
        expect(table.find((e) => e.key === "boss:visitci").options.map((o) => o.label)).toEqual([
            "Vient me chercher",
            "Badge seulement",
            "Rien",
        ]);
        expect(table.every((e) => e.label !== "" && e.description !== "")).toBe(true);
    });
});
