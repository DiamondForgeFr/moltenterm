// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../command-panel/bindings", () => ({ writeSettings: vi.fn() }));

import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import settingsSchema from "../../../schema/settings.json";
import { t as translate } from "../i18n/i18n";
import { buildCatalog, localizeCatalog, sectionEntries } from "../settings/settings-catalog";
import {
    BrokkComingCard,
    BrokkTableGroup,
    BrokkTableKey,
    clockChange,
    clockText,
    comingChange,
    switchChange,
    thresholdChange,
} from "./brokk-coming-card";
import { SettingIds, VisitSettingKeys } from "./brokk-visit-events";

const entries = localizeCatalog(
    sectionEntries(buildCatalog(settingsSchema as any, builtinDefaults as Record<string, unknown>, "darwin"), "boss"),
    translate
).filter((entry) => entry.group === translate("settings.groups.whenHeComesToFetchMe"));

function render(settings: Record<string, unknown> = {}): string {
    return renderToStaticMarkup(<BrokkComingCard entries={entries} settings={settings} />);
}

function rowOf(html: string, key: string): string {
    const rows = html.split('data-testid="brokk-coming-row"').slice(1);
    return rows.find((row) => row.startsWith(` data-setting="${key}"`)) ?? "";
}

// The choices ticked in a line (React writes checked="" after the other attributes).
function checked(html: string, key: string): string[] {
    return [...rowOf(html, key).matchAll(/<input[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => tag.includes('checked=""'))
        .map((tag) => /data-value="([^"]+)"/.exec(tag)[1]);
}

describe('the table of Preferences, "Quand Brokk vient me chercher" (FR-BOSS-009, AC4)', () => {
    it("is the group of the Brokk section that the screen draws in place of the generic rows", () => {
        expect(entries.map((e) => e.key)).toContain(BrokkTableKey);
        expect(entries.every((e) => e.group !== "")).toBe(true);
        const meta = (settingsSchema as any).$defs.SettingsType.properties[BrokkTableKey]["x-moltenterm"];
        expect(meta.group).toBe(BrokkTableGroup);
        const screen = readFileSync(join(__dirname, "..", "settings", "settings-screen.tsx"), "utf8");
        expect(screen).toContain("<BrokkComingCard entries={g.entries} settings={data.settings} />");
    });

    it("has one line per event, in the order of the model, each with the three choices", () => {
        const html = render();
        const rows = [...html.matchAll(/data-testid="brokk-coming-row" data-setting="([^"]+)"/g)].map((m) => m[1]);
        expect(rows).toEqual(SettingIds.map((id) => VisitSettingKeys.coming[id]));
        for (const key of rows) {
            expect([...rowOf(html, key).matchAll(/data-value="([^"]+)"/g)].map((m) => m[1])).toEqual([
                "vient",
                "badge",
                "rien",
            ]);
        }
    });

    it("shows each event at its default until the developer chose, then at his choice", () => {
        const fresh = render();
        expect(checked(fresh, VisitSettingKeys.coming.blocked)).toEqual(["vient"]);
        expect(checked(fresh, VisitSettingKeys.coming.ci)).toEqual(["badge"]);
        const chosen = render({ [VisitSettingKeys.coming.ci]: "vient", [VisitSettingKeys.coming.blocked]: "rien" });
        expect(checked(chosen, VisitSettingKeys.coming.ci)).toEqual(["vient"]);
        expect(checked(chosen, VisitSettingKeys.coming.blocked)).toEqual(["rien"]);
    });

    it("shows an invalid value as the default, as the model reads it", () => {
        const html = render({ [VisitSettingKeys.coming.ci]: "always" });
        expect(checked(html, VisitSettingKeys.coming.ci)).toEqual(["badge"]);
    });

    it("holds the blocked threshold, the quiet hours and the master switch", () => {
        const html = render({
            [VisitSettingKeys.blockedMin]: 10,
            [VisitSettingKeys.quiet]: false,
            [VisitSettingKeys.quietFrom]: "23:30",
            [VisitSettingKeys.never]: true,
        });
        expect(html).toMatch(/data-testid="brokk-coming-threshold"/);
        expect(html).toMatch(/<option value="10" selected="">/);
        expect([...html.matchAll(/<option value="(\d+)"/g)].map((m) => m[1])).toEqual(["2", "5", "10", "15"]);
        const switches = [
            ...html.matchAll(/role="switch" aria-checked="(true|false)"[^>]*data-setting="([^"]+)"/g),
        ].map((m) => [m[2], m[1]]);
        expect(switches).toEqual([
            [VisitSettingKeys.quiet, "false"],
            [VisitSettingKeys.never, "true"],
        ]);
        expect(html).toMatch(/data-setting="boss:quietfrom"[^>]*|value="23:30"/);
        expect(html).toContain('value="23:30"');
        expect(html).toContain('value="08:00"');
    });

    it("says that severity sets his face and the delays of Later, never the words", () => {
        expect(render()).toMatch(
            /data-testid="brokk-coming-severity"[^>]*>Severity sets his face and the delays of Later/
        );
    });
});

describe("what its controls write (FR-BOSS-009, AC4: the keys of #2001)", () => {
    it("writes the event's own key with the chosen word", () => {
        expect(comingChange(VisitSettingKeys.coming.download, "vient")).toEqual({ "boss:visitdownload": "vient" });
        expect(comingChange("boss:visitci", "rien")).toEqual({ "boss:visitci": "rien" });
        expect(comingChange("boss:visitci", "sometimes" as any)).toBeNull();
    });

    it("writes the threshold as a number, and only one of the four", () => {
        expect(thresholdChange(VisitSettingKeys.blockedMin, 15)).toEqual({ "boss:blockedmin": 15 });
        expect(thresholdChange(VisitSettingKeys.blockedMin, 7)).toBeNull();
    });

    it("writes the switches as booleans", () => {
        expect(switchChange(VisitSettingKeys.quiet, false)).toEqual({ "boss:quiet": false });
        expect(switchChange(VisitSettingKeys.never, true)).toEqual({ "boss:nevercome": true });
    });

    it("writes the quiet hours as HH:MM, and nothing for an invalid or unchanged hour", () => {
        expect(clockChange(VisitSettingKeys.quietFrom, "9:05", 22 * 60)).toEqual({ "boss:quietfrom": "09:05" });
        expect(clockChange(VisitSettingKeys.quietTo, "7:30", 8 * 60)).toEqual({ "boss:quietto": "07:30" });
        expect(clockChange(VisitSettingKeys.quietTo, "25:00", 8 * 60)).toBeNull();
        expect(clockChange(VisitSettingKeys.quietTo, "tomorrow", 8 * 60)).toBeNull();
        expect(clockChange(VisitSettingKeys.quietTo, "08:00", 8 * 60)).toBeNull();
        expect(clockText(8 * 60 + 5)).toBe("08:05");
    });

    it("hands each control's change to the settings, through the helpers above", () => {
        const source = readFileSync(join(__dirname, "brokk-coming-card.tsx"), "utf8");
        for (const call of [
            "write(comingChange(entry.key, choice))",
            "write(thresholdChange(threshold.key, Number(e.target.value)))",
            "write(switchChange(entry.key, !on))",
            "write(clockChange(entry.key, typed, value))",
        ]) {
            expect(source, call).toContain(call);
        }
    });

    it("offers Show a visit beside the table, as a calm button that plays the example (AC31)", () => {
        const html = render();
        expect(html).toContain('data-testid="brokk-coming-example"');
        expect(html).toContain(translate("boss.coming.example.button"));
        expect(html).toContain(translate("boss.coming.example.hint"));
        expect(html.indexOf('data-testid="brokk-coming-example"')).toBeGreaterThan(
            html.indexOf('data-testid="brokk-coming-severity"')
        );
    });
});
