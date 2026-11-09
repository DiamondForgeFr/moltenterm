// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { UsageWeekGrid } from "../usage-week/usage-week";
import { legendColours, paceColour, paceRatio, UnusedBlueAt } from "../usage-week/usage-week-model";
import { PlanUsageBody } from "./companion-gauges";
import {
    CompanionUsageInfo,
    creditsText,
    experimentalView,
    gaugeLevel,
    gaugePercent,
    gaugeRows,
    gaugesView,
    resetText,
    usageFor,
    usageReadFor,
    usageReasonText,
    UsageSourceIds,
    usageSourceName,
    usageStale,
    UsageStaleMs,
    usageWindowShortLabel,
} from "./companion-gauges-model";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

const Min = 60 * 1000;
const Hour = 60 * Min;
const now = new Date(2026, 9, 6, 10, 0, 0).getTime();

// What wavesrv sends for Claude Code once the relay reported (pkg/molten/companion/usage.go).
const enabled: CompanionUsageInfo = {
    blockid: "b1",
    agent: "claude",
    pageurl: "https://claude.ai/settings/usage",
    pagename: "Claude usage",
    hasgauges: true,
    gauges: "enabled",
    sourcename: "Claude Code status line",
    snapshot: {
        agent: "claude",
        source: "claude-statusline",
        readat: now - 3 * Min,
        windows: [
            {
                id: "session",
                label: "Current session",
                usedpercent: 23.5,
                resetsat: now + 2 * Hour + 14 * Min,
                windowmins: 300,
            },
            { id: "week", label: "This week", usedpercent: 82, resetsat: now + 3 * 24 * Hour, windowmins: 10080 },
        ],
    },
};

const noop = { onShow: () => {}, onHide: () => {}, onRefresh: () => {} };

function markup(info: CompanionUsageInfo, at = now): string {
    return renderToStaticMarkup(<PlanUsageBody view={gaugesView(info, at)} {...noop} />);
}

const RowStart = '<span class="mt-uw-row"';
const rowTag = (html: string, window: string): string =>
    [...html.matchAll(/<span class="mt-uw-row"[^>]*>/g)]
        .map((m) => m[0])
        .find((tag) => tag.includes(`data-window="${window}"`)) ?? "";
const rowHtml = (html: string, window: string): string => {
    const start = html.indexOf(rowTag(html, window));
    const next = html.indexOf(RowStart, start + 1);
    return html.slice(start, next < 0 ? html.length : next);
};
const windowsOf = (html: string): string[] =>
    [...html.matchAll(/<span class="mt-uw-row"[^>]*data-window="([^"]*)"/g)].map((m) => m[1]);
const labelsOf = (html: string): string[] =>
    [...html.matchAll(/data-testid="usage-week-label">([^<]*)</g)].map((m) => m[1]);
const percentsOf = (html: string): string[] =>
    [...html.matchAll(/data-testid="usage-week-percent">([^<]*)</g)].map((m) => m[1]);
const noteOf = (html: string, window: string): string =>
    /data-testid="usage-week-note">([^<]*)</.exec(rowHtml(html, window))?.[1] ?? "";
const initialsOf = (html: string): string =>
    [...html.matchAll(/data-testid="usage-week-day"[^>]*>([^<]*)</g)].map((m) => m[1]).join("");
// The seven day blocks of a row, Monday first: their fill and whether the reset ring stands on them.
const blocksOf = (html: string, window: string): { fill: number; reset: boolean }[] =>
    [...rowHtml(html, window).matchAll(/<span class="mt-uw-cell([^"]*)"[^>]*><i style="width:([0-9.]+)%"/g)].map(
        (m) => ({
            fill: Number(m[2]),
            reset: m[1].includes("is-reset"),
        })
    );

describe("plan usage reads", () => {
    it("may fetch only for a window that shows, so a hidden or minimised one pauses the automatic reads", () => {
        expect(usageReadFor("visible")).toEqual({ fetch: true });
        expect(usageReadFor("hidden")).toEqual({ fetch: false });
        expect(usageReadFor("prerender")).toEqual({ fetch: false });
    });
});

describe("plan usage rules", () => {
    it("says when each window resets", () => {
        expect(resetText(now + 2 * Hour + 14 * Min, now)).toBe("Resets in 2 h 14 min");
        expect(resetText(now + 3 * Hour, now)).toBe("Resets in 3 h");
        expect(resetText(now + 45 * Min, now)).toBe("Resets in 45 min");
        expect(resetText(now + 10 * 1000, now)).toBe("Resets in 1 min");
        expect(resetText(now + 3 * 24 * Hour, now)).toBe("Resets Fri 10:00");
        expect(resetText(new Date(2026, 9, 13, 9, 5).getTime(), now)).toBe("Resets Tue 13 Oct, 09:05");
        expect(resetText(now - 1, now)).toBe("");
        expect(resetText(0, now)).toBe("");
    });

    it("shows percents as given and clamps only the bar", () => {
        expect(gaugePercent(23.5)).toBe("23.5 % used");
        expect(gaugePercent(41.234)).toBe("41.2 % used");
        expect(gaugePercent(104)).toBe("104 % used");
        const rows = gaugeRows(
            {
                agent: "claude",
                source: "x",
                readat: now,
                windows: [
                    { id: "spend", label: "Spend limit", usedpercent: 104 },
                    { id: "session", label: "Current session", usedpercent: -3 },
                ],
            },
            now
        );
        expect(rows.map((r) => [r.bar, r.percent])).toEqual([
            [100, "104 % used"],
            [0, "-3 % used"],
        ]);
    });

    it("colours the bar from 80 % and 95 %", () => {
        expect(gaugeLevel(79.9)).toBe("normal");
        expect(gaugeLevel(80)).toBe("warning");
        expect(gaugeLevel(94.9)).toBe("warning");
        expect(gaugeLevel(95)).toBe("error");
    });

    it("drops a window past its reset, and the source's windows it does not give are absent", () => {
        const view = gaugesView(enabled, now + 2 * Hour + 15 * Min);
        expect(view.kind).toBe("enabled");
        expect(view.kind === "enabled" && view.rows.map((r) => r.id)).toEqual(["week"]);
        expect(gaugesView(enabled, now + 4 * 24 * Hour)).toEqual({
            kind: "unavailable",
            reason: usageReasonText("expired"),
        });
    });

    it("decides the section's state", () => {
        expect(gaugesView(null, now).kind).toBe("hidden");
        expect(gaugesView({ ...enabled, hasgauges: false }, now).kind).toBe("hidden");
        expect(gaugesView({ ...enabled, gauges: "off", snapshot: undefined }, now).kind).toBe("off");
        const setup = { source: "claude-statusline", file: "~/.claude/settings.json", language: "json", snippet: "{}" };
        expect(gaugesView({ ...enabled, gauges: "unavailable", reason: "notsetup", setup }, now)).toEqual({
            kind: "setup",
            setup,
        });
        expect(gaugesView({ ...enabled, gauges: "unavailable", reason: "noplan", snapshot: undefined }, now)).toEqual({
            kind: "unavailable",
            reason: "Not on a Pro or Max plan",
        });
        expect(gaugesView({ ...enabled, gauges: "unavailable", reason: "bogus" as any }, now)).toEqual({
            kind: "unavailable",
            reason: usageReasonText("failed"),
        });
        const view = gaugesView(enabled, now);
        expect(view.kind === "enabled" && [view.source, view.age]).toEqual([
            "Claude Code status line",
            "Updated 3 min ago",
        ]);
    });

    it("asks again once the values stopped coming", () => {
        expect(usageStale(enabled, now)).toBe(false);
        expect(usageStale(enabled, now - 3 * Min + UsageStaleMs + 1)).toBe(true);
        expect(usageStale({ ...enabled, gauges: "unavailable" }, now + Hour)).toBe(false);
        expect(usageStale(null, now)).toBe(false);
    });

    it("takes only this terminal's answers", () => {
        expect(usageFor(enabled, "b1", "claude")).toBe(true);
        expect(usageFor(enabled, "b2", "claude")).toBe(false);
        expect(usageFor(enabled, "b1", "codex")).toBe(false);
        expect(usageFor(null, "b1", "claude")).toBe(false);
    });
});

describe("plan usage section", () => {
    it("is one compact row offering Show plan usage when off, without saying it twice (#748)", () => {
        const html = markup({ ...enabled, gauges: "off", snapshot: undefined });
        expect(html).toContain('data-state="off"');
        expect(html).toContain("<span>Plan usage</span>");
        expect(html).toMatch(/aria-label="Show plan usage"[^>]*>Show<\/button>/);
        expect(html).toContain("cursor-pointer");
        expect(html).not.toContain("Experimental");
    });

    it("renders nothing for an agent without gauges", () => {
        expect(markup({ ...enabled, hasgauges: false })).toBe("");
    });

    it("shows each window as a week-grid row with its label, percent and reset, marked experimental with its source", () => {
        const html = markup(enabled);
        expect(html).toContain("Experimental");
        expect(html).toContain("From the Claude Code status line");
        expect(html).toContain("Updated 3 min ago");
        expect(labelsOf(html)).toEqual(["Session", "Week"]);
        expect(html).toContain('aria-label="Current session, 24 %, resets Tuesday"');
        expect(html).toContain('title="Current session: 23.5 % used\nResets in 2 h 14 min"');
        expect(noteOf(html, "session")).toBe("Resets in 2 h 14 min");
        expect(html).toContain('aria-label="This week, 82 %, resets Friday"');
        expect(noteOf(html, "week")).toBe("Resets Fri 10:00");
        expect(percentsOf(html)).toEqual(["24 %", "82 %"]);
        expect(html).toContain('aria-label="Refresh plan usage"');
        expect(html).toContain(">Hide</button>");
    });

    it("is one week-grid row per limit in its compact form, the details a click away (#555)", () => {
        const onDetails = vi.fn();
        const html = renderToStaticMarkup(
            <PlanUsageBody view={gaugesView(enabled, now)} {...noop} compact onDetails={onDetails} />
        );
        expect(html).toContain('data-compact="true"');
        expect(windowsOf(html)).toEqual(["session", "week"]);
        expect(percentsOf(html)).toEqual(["24 %", "82 %"]);
        expect(html).toContain(
            'title="This week: 82 % used\nResets Fri 10:00\nFrom the Claude Code status line · Updated 3 min ago"'
        );
        expect(html).not.toContain('data-testid="usage-week-note"');
        expect(html).toContain('aria-label="Plan usage details"');
        expect(html).not.toContain("Experimental");
        expect(html).not.toContain(">Hide</button>");
        const full = renderToStaticMarkup(
            <PlanUsageBody view={gaugesView(enabled, now)} {...noop} compact={false} onDetails={onDetails} />
        );
        expect(full).toContain('aria-label="Compact plan usage"');
        expect(full).toContain(">Hide</button>");
    });

    it("keeps the limits beyond two and the credits in the details", () => {
        const many: CompanionUsageInfo = {
            ...enabled,
            snapshot: {
                ...enabled.snapshot,
                windows: [
                    ...enabled.snapshot.windows,
                    { id: "opus", label: "Opus this week", usedpercent: 10, resetsat: now + 3 * 24 * Hour },
                ],
                credits: { enabled: true, used: 5, limit: 50, unit: "USD" },
            },
        };
        const html = renderToStaticMarkup(
            <PlanUsageBody view={gaugesView(many, now)} {...noop} compact onDetails={() => {}} />
        );
        expect(windowsOf(html)).toEqual(["session", "week"]);
        expect(html).not.toContain("Opus this week");
        expect(html).toContain(">+2<");
    });

    it("collapses to one muted line on failure, with the reason as tooltip and Hide kept", () => {
        const html = markup({ ...enabled, gauges: "unavailable", reason: "noplan", snapshot: undefined });
        expect(html).toContain('data-state="unavailable"');
        expect(html).toContain('title="Not on a Pro or Max plan"');
        expect(html).toContain("Plan usage unavailable");
        expect(html).toMatch(/aria-label="Hide plan usage"[^>]*>Hide<\/button>/);
        expect(html).not.toContain('role="meter"');
    });

    it("shows the status line setup with the snippet and a Copy call to action", () => {
        const snippet = '{\n  "statusLine": {\n    "type": "command",\n    "command": "command -v molten"\n  }\n}';
        const html = markup({
            ...enabled,
            gauges: "unavailable",
            reason: "notsetup",
            snapshot: undefined,
            setup: {
                source: "claude-statusline",
                file: "~/.claude/settings.json",
                current: "jq .",
                language: "json",
                snippet,
            },
        });
        expect(html).toContain('data-state="setup"');
        expect(html).toContain("Replace the statusLine entry in ");
        expect(html).toContain("~/.claude/settings.json");
        expect(html).toContain("command -v molten");
        expect(html).toContain("MoltenTerm never edits");
        expect(html).toMatch(/class="molten-btn cursor-pointer[^"]*"[^>]*>.*Copy<i class="molten-btn-wave"/);
        expect(html).toContain(">Hide plan usage</button>");
        const fresh = markup({
            ...enabled,
            gauges: "unavailable",
            reason: "notsetup",
            snapshot: undefined,
            setup: { source: "claude-statusline", file: "~/.claude/settings.json", language: "json", snippet },
        });
        expect(fresh).toContain("Add this to ");
    });
});

// What wavesrv sends for Codex (pkg/molten/usage/codex.go): windows labelled from their length, credits as a balance.
const codex: CompanionUsageInfo = {
    blockid: "b2",
    agent: "codex",
    pageurl: "https://chatgpt.com/codex/settings/usage",
    pagename: "Codex usage",
    hasgauges: true,
    gauges: "enabled",
    sourcename: "Codex session log",
    snapshot: {
        agent: "codex",
        source: "codex-transcript",
        plan: "plus",
        readat: now - 3 * Min,
        windows: [
            { id: "session", label: "5-hour", usedpercent: 12.5, resetsat: now + 3 * Hour, windowmins: 300 },
            { id: "week", label: "This week", usedpercent: 96, resetsat: now + 4 * 24 * Hour, windowmins: 10080 },
        ],
        credits: { enabled: true, used: 0, limit: 0, balance: "17.5" },
    },
};

describe("Codex plan usage", () => {
    it("shows the windows with their age, and the credits balance", () => {
        const html = markup(codex);
        expect(html).toContain("From the Codex session log");
        expect(html).toContain("Updated 3 min ago");
        expect(labelsOf(html)).toEqual(["5-hour", "Week"]);
        expect(html).toContain('title="5-hour: 12.5 % used\nResets in 3 h"');
        expect(noteOf(html, "session")).toBe("Resets in 3 h");
        expect(percentsOf(html)).toEqual(["13 %", "96 %"]);
        expect(rowTag(html, "week")).toContain('data-pace="red"');
        expect(html).toContain("Credits: 17.5 left");
    });

    it("has no credits line without credits", () => {
        expect(markup({ ...codex, snapshot: { ...codex.snapshot, credits: undefined } })).not.toContain("Credits");
        expect(creditsText({ enabled: false, used: 0, limit: 0, balance: "3" })).toBe("");
        expect(creditsText({ enabled: true, used: 0, limit: 0, unlimited: true })).toBe("Credits: unlimited");
        expect(creditsText({ enabled: true, used: 0, limit: 0 })).toBe("Credits available");
        expect(creditsText({ enabled: true, used: 4, limit: 50, unit: "USD" })).toBe("Extra usage: $4.00 of $50.00");
    });

    it("names the merged sources", () => {
        const appServer = {
            ...codex,
            sourcename: "Codex app-server",
            snapshot: { ...codex.snapshot, source: "codex-appserver" },
        };
        expect(markup(appServer)).toContain("From the Codex app-server");
    });

    it("gives Codex's own reasons", () => {
        expect(usageReasonText("waiting", "codex")).toBe(
            "Waiting for the agent: the limits come with its next response"
        );
        expect(usageReasonText("noplan", "codex")).toBe("The agent reports no plan limits for this sign-in");
        expect(usageReasonText("format", "codex")).toBe(usageReasonText("format"));
        expect(usageReasonText("noplan", "claude")).toBe("Not on a Pro or Max plan");
        const html = markup({ ...codex, gauges: "unavailable", reason: "waiting", snapshot: undefined });
        expect(html).toContain('title="Waiting for the agent: the limits come with its next response"');
        const expired = { ...codex, snapshot: { ...codex.snapshot, credits: undefined } };
        expect(gaugesView(expired, now + 5 * 24 * Hour)).toEqual({
            kind: "unavailable",
            reason: "The limits were reset: new values come with the agent's next response",
        });
    });

    it("shows the dominoes in place of the Refresh icon while a read runs (DS-SHELL-154)", () => {
        const html = renderToStaticMarkup(<PlanUsageBody view={gaugesView(codex, now)} refreshing {...noop} />);
        expect(html).toContain('aria-busy="true"');
        expect(html).toContain("df-domino-loader mt-dominos-icon");
        expect(html).not.toContain("fa-rotate-right");
        expect(markup(codex)).toContain("fa-rotate-right");
        expect(markup(codex)).not.toContain("df-domino-loader");
    });
});

// The companion draws the gauges as Brokk's usage week grid (FR-SHELL-027, FR-BOSS-009 AC48 to AC51, #2102).
describe("the companion's usage week grid (#2102)", () => {
    const withModel: CompanionUsageInfo = {
        ...enabled,
        snapshot: {
            ...enabled.snapshot,
            windows: [
                enabled.snapshot.windows[1],
                {
                    id: "model:opus",
                    label: "This week (Opus)",
                    usedpercent: 70,
                    resetsat: now + 5 * 24 * Hour,
                    windowmins: 10080,
                },
            ],
        },
    };

    it("is the shared component: one row per window, labelled by its window in place of a logo", () => {
        const html = markup(enabled);
        expect(html).toContain('data-testid="usage-week"');
        expect(html).toContain('data-labelled="true"');
        expect(windowsOf(html)).toEqual(["session", "week"]);
        expect(labelsOf(html)).toEqual(["Session", "Week"]);
        expect(html).not.toContain('data-testid="usage-week-logo"');
        expect(html).not.toContain('role="meter"');
        const source = readFileSync(join(__dirname, "companion-gauges.tsx"), "utf8");
        expect(source).toContain('from "../usage-week/usage-week"');
        expect(source).not.toContain('role="meter"');
    });

    it("draws the weekly and the per-model weekly window of the agent, the model's name in its label", () => {
        const html = markup(withModel);
        expect(windowsOf(html)).toEqual(["week", "model:opus"]);
        expect(labelsOf(html)).toEqual(["Week", "Week (Opus)"]);
        expect(rowTag(html, "model:opus")).toContain('aria-label="This week (Opus), 70 %, resets Sunday"');
    });

    // The reset day's block is 0 %: the fill starts on it and runs forward, past Sunday to Monday. Tuesday 6 October.
    it("starts each window's fill on the weekday it last reset, wrapping round the week", () => {
        const html = markup(withModel);
        // The week resets on Friday 9 October at 10:00: it last reset on Friday 2 October.
        expect(blocksOf(html, "week")).toEqual([
            { fill: 100, reset: false },
            { fill: 100, reset: false },
            { fill: 74, reset: false },
            { fill: 0, reset: false },
            { fill: 100, reset: true },
            { fill: 100, reset: false },
            { fill: 100, reset: false },
        ]);
        // Opus resets on Sunday 11 October: it last reset on Sunday 4 October, 70 % being 4.9 blocks from there.
        expect(blocksOf(html, "model:opus")).toEqual([
            { fill: 100, reset: false },
            { fill: 100, reset: false },
            { fill: 100, reset: false },
            { fill: 90, reset: false },
            { fill: 0, reset: false },
            { fill: 0, reset: false },
            { fill: 100, reset: true },
        ]);
        // The 5-hour session last reset this morning, on Tuesday.
        expect(blocksOf(markup(enabled), "session").map((b) => b.reset)).toEqual([
            false,
            true,
            false,
            false,
            false,
            false,
            false,
        ]);
    });

    it("follows Brokk's pace colours, a per-model week being paced against a week", () => {
        const html = markup(withModel);
        const colour = (window: string) => /--mt-uw-pace:([^"]*)"/.exec(rowTag(html, window))?.[1];
        // 82 % when 4 days of 7 allow 57 %.
        expect(colour("week")).toBe(paceColour(paceRatio(82, now + 3 * 24 * Hour, 10080, now)));
        expect(colour("week")).toBe("color-mix(in srgb, var(--color-error) 63%, var(--color-warning))");
        expect(rowTag(html, "week")).toContain('data-pace="above"');
        // 70 % when 2 days of 7 allow 28.5 %.
        expect(colour("model:opus")).toBe("var(--color-error)");
        expect(rowTag(html, "model:opus")).toContain('data-pace="red"');
        // 24 % (23.5 rounded) of a session that is 2 h 46 min old of 5 h: 55.3 % allowed, 31.3 points left unused,
        // nearly full blue (#2106).
        const session = markup(enabled);
        expect(/--mt-uw-pace:([^"]*)"/.exec(rowTag(session, "session"))?.[1]).toBe(
            "color-mix(in srgb, var(--mt-info) 85%, var(--color-success))"
        );
        expect(rowTag(session, "session")).toContain('data-pace="under"');
    });

    it("writes the initials Monday first in the interface language, today's emphasised, and follows a switch", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const html = markup(enabled);
            expect(initialsOf(html)).toBe("LMMJVSD");
            expect(labelsOf(html)).toEqual(["Session", "Semaine"]);
            expect(rowTag(html, "week")).toMatch(/aria-label="Cette semaine, 82\s%, remise à zéro vendredi"/);
            i18n.setLanguageSetting("en");
            expect(initialsOf(markup(enabled))).toBe("MTWTFSS");
        } finally {
            i18n.setLanguageSetting("");
        }
        const days = [...markup(enabled).matchAll(/<span class="mt-uw-day"[^>]*>/g)].map((m) => m[0]);
        expect(days.map((d) => d.includes('data-today="true"'))).toEqual([
            false,
            true,
            false,
            false,
            false,
            false,
            false,
        ]);
    });

    it("tells the reset in the row's tooltip, and under the row in the details form only", () => {
        const compact = renderToStaticMarkup(
            <PlanUsageBody view={gaugesView(enabled, now)} {...noop} compact onDetails={() => {}} />
        );
        expect(compact).not.toContain('data-testid="usage-week-note"');
        expect(rowTag(compact, "week")).toContain("Resets Fri 10:00");
        expect(noteOf(markup(enabled), "week")).toBe("Resets Fri 10:00");
    });

    it("names a window in a short form for a narrow column, and keeps the whole name for the row", () => {
        expect(usageWindowShortLabel("Current session")).toBe("Session");
        expect(usageWindowShortLabel("This week")).toBe("Week");
        expect(usageWindowShortLabel("This week (Opus)")).toBe("Week (Opus)");
        expect(usageWindowShortLabel("Spend limit")).toBe("Spend");
        expect(usageWindowShortLabel("5-hour")).toBe("5-hour");
        expect(usageWindowShortLabel("GPT-5 This week")).toBe("GPT-5 Week");
        expect(usageWindowShortLabel("Something else")).toBe("Something else");
        const rows = gaugeRows(withModel.snapshot, now);
        expect(rows.map((r) => [r.label, r.shortLabel])).toEqual([
            ["This week", "Week"],
            ["This week (Opus)", "Week (Opus)"],
        ]);
        expect(rows[1].line.start).toBe(6);
        expect(rows[1].line.windowMins).toBe(10080);
    });
});

// The expanded section says what the grid shows, and names its sources in the interface language (FR-SHELL-027,
// amended for #2123).
describe("the legend, the explanation and the source line (#2123)", () => {
    const plain = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    const inFrench = <T,>(run: () => T): T => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            return run();
        } finally {
            i18n.setLanguageSetting("");
        }
    };
    const keysOf = (html: string): [string, string][] =>
        [
            ...html.matchAll(
                /<span class="mt-uw-key"[^>]*data-key="(\w+)"[^>]*><span[^>]*>(?:<i><\/i>)?<\/span>([^<]*)<\/span>/g
            ),
        ].map((m) => [m[1], plain(m[2])]);
    const swatchesOf = (html: string) =>
        [
            ...html.matchAll(/<span class="(mt-uw-cell[^"]*)"([^>]*)data-testid="usage-week-key-swatch">(<i><\/i>)?/g),
        ].map((m) => ({
            classes: m[1],
            colour: /style="--mt-uw-pace:([^"]*)"/.exec(m[2])?.[1] ?? null,
            filled: m[3] != null,
        }));
    const fromOf = (html: string): string =>
        plain(/<div class="w-full text-11 text-muted">([^<]*)<\/div>/.exec(html)?.[1] ?? "");
    const explainOf = (html: string): string =>
        plain(/data-testid="companion-plan-usage-explain">([^<]*)</.exec(html)?.[1] ?? "");
    const fromSources = (source: string, sourcename: string): CompanionUsageInfo => ({
        ...enabled,
        sourcename,
        snapshot: { ...enabled.snapshot, source },
    });

    it("shows the legend under the rows of the expanded section, in the grid's order of marks", () => {
        const html = markup(enabled);
        expect(html).toContain('data-testid="usage-week-legend"');
        expect(html).toContain('role="group" aria-label="Colours and marks of the week grid"');
        expect(keysOf(html)).toEqual([
            ["today", "Today"],
            ["reset", "Reset day"],
            ["under", "Under pace"],
            ["on", "On pace"],
            ["above", "Above pace"],
        ]);
        expect(html.indexOf('data-testid="usage-week-legend"')).toBeGreaterThan(
            html.lastIndexOf('data-testid="usage-week-row"')
        );
        expect(html).toContain(
            'title="More than the time gone allows, orange towards red. At this pace the window may run out before it resets"'
        );
    });

    it("is absent from the compact form and from every state without a grid", () => {
        const compact = renderToStaticMarkup(
            <PlanUsageBody view={gaugesView(enabled, now)} {...noop} compact onDetails={() => {}} />
        );
        expect(compact).toContain('data-testid="usage-week"');
        expect(compact).not.toContain("usage-week-legend");
        expect(compact).not.toContain("companion-plan-usage-explain");
        for (const info of [
            { ...enabled, gauges: "off" as const, snapshot: undefined },
            { ...enabled, gauges: "unavailable" as const, reason: "noplan" as const, snapshot: undefined },
            {
                ...enabled,
                snapshot: {
                    ...enabled.snapshot,
                    windows: [],
                    credits: { enabled: true, used: 5, limit: 50, unit: "USD" },
                },
            },
        ]) {
            const html = markup(info);
            expect(html).not.toContain("usage-week-legend");
            expect(html).not.toContain("companion-plan-usage-explain");
        }
    });

    it("leaves Brokk's usage block as it is: its grid asks for no legend", () => {
        expect(renderToStaticMarkup(<UsageWeekGrid rows={[]} now={now} />)).not.toContain("usage-week-legend");
        expect(renderToStaticMarkup(<UsageWeekGrid rows={[]} now={now} legend />)).toContain("usage-week-legend");
        const brokk = readFileSync(join(__dirname, "../boss/brokk-group.tsx"), "utf8");
        expect(brokk).toContain("<UsageWeekGrid rows={weekRows} now={now} />");
        expect(brokk).not.toMatch(/\blegend\b/i);
    });

    it("draws the swatches with the grid's own blocks, ring and colours", () => {
        const html = markup(enabled);
        const colours = legendColours();
        expect(swatchesOf(html)).toEqual([
            { classes: "mt-uw-cell is-today", colour: null, filled: false },
            { classes: "mt-uw-cell is-reset", colour: null, filled: false },
            { classes: "mt-uw-cell", colour: colours.under, filled: true },
            { classes: "mt-uw-cell", colour: colours.on, filled: true },
            { classes: "mt-uw-cell", colour: colours.above, filled: true },
        ]);
        // The rows' blocks carry the same classes: a row far under its pace is full blue, a row on pace is green.
        expect(colours.under).toBe(paceColour(0, UnusedBlueAt));
        const onPace = gaugeRows(
            {
                ...enabled.snapshot,
                windows: [
                    {
                        id: "week",
                        label: "This week",
                        usedpercent: 28,
                        resetsat: now + 5 * 24 * Hour,
                        windowmins: 10080,
                    },
                ],
            },
            now
        );
        expect(onPace[0].line.pace).toBeLessThanOrEqual(1);
        expect(paceColour(onPace[0].line.pace, onPace[0].line.unused)).toBe(colours.on);
        expect(html).toContain('class="mt-uw-cell is-reset"');
    });

    it("explains a row, its blocks, the percentage and the reset line, in the interface language", () => {
        const english = explainOf(markup(enabled));
        expect(english).toBe(
            'A row is one usage window of your plan, filled day by day from its reset day (one block a day). The percentage is the share already used; the "Resets" line says when the window starts again.'
        );
        expect(english.split(". ")).toHaveLength(2);
        inFrench(() => {
            const html = markup(enabled);
            expect(explainOf(html)).toBe(
                "Une ligne est une fenêtre d'utilisation de votre abonnement, remplie jour après jour à partir de son jour de remise à zéro (un bloc par jour). Le pourcentage est la part déjà utilisée ; la ligne « Remise à zéro » indique quand la fenêtre repart."
            );
            expect(keysOf(html).map(([, label]) => label)).toEqual([
                "Aujourd'hui",
                "Jour de remise à zéro",
                "Sous le rythme",
                "Au rythme",
                "Au-dessus du rythme",
            ]);
        });
        expect(explainOf(markup(enabled))).toBe(english);
    });

    it("names the sources in the interface language, from their ids", () => {
        const both = fromSources(
            "claude-statusline,claude-oauth",
            "Claude Code status line and Anthropic usage endpoint"
        );
        expect(fromOf(markup(both))).toBe("From the Claude Code status line and Anthropic usage endpoint");
        expect(fromOf(markup(enabled))).toBe("From the Claude Code status line");
        inFrench(() => {
            expect(fromOf(markup(both))).toBe(
                "Depuis : ligne d'état de Claude Code et service d'utilisation d'Anthropic"
            );
            expect(fromOf(markup(enabled))).toBe("Depuis : ligne d'état de Claude Code");
            expect(fromOf(markup({ ...codex }))).toBe("Depuis : journal de session de Codex");
            expect(
                fromOf(
                    markup(fromSources("codex-transcript,codex-appserver", "Codex session log and Codex app-server"))
                )
            ).toBe("Depuis : journal de session de Codex et app-server de Codex");
            const compact = renderToStaticMarkup(
                <PlanUsageBody view={gaugesView(both, now)} {...noop} compact onDetails={() => {}} />
            );
            expect(plain(compact)).toContain(
                "Depuis : ligne d'état de Claude Code et service d'utilisation d'Anthropic"
            );
        });
        expect(fromOf(markup(codex))).toBe("From the Codex session log");
    });

    it("keeps wavesrv's words for a source it does not know, whole rather than half translated", () => {
        const unknown = fromSources("claude-newsource", "Some new source");
        const mixed = fromSources("claude-statusline,claude-newsource", "Claude Code status line and Some new source");
        const unnamed = fromSources("", "Claude Code status line");
        for (const info of [unknown, mixed, unnamed]) {
            expect(fromOf(markup(info))).toBe(`From the ${info.sourcename}`);
            inFrench(() => expect(fromOf(markup(info))).toBe(`Depuis : ${info.sourcename}`));
        }
        expect(usageSourceName("claude-newsource", "Some new source")).toBe("Some new source");
        expect(usageSourceName("claude-newsource")).toBe("");
    });

    it("lists three sources with commas and the last after 'and'", () => {
        const three = fromSources(
            "claude-statusline,claude-oauth,codex-transcript",
            "Claude Code status line and Anthropic usage endpoint and Codex session log"
        );
        const view = gaugesView(three, now);
        expect(view.kind === "enabled" && view.source).toBe(
            "Claude Code status line, Anthropic usage endpoint and Codex session log"
        );
    });

    it("names the experimental source in its confirmation in the interface language", () => {
        const off: CompanionUsageInfo = {
            ...enabled,
            experimental: {
                source: "claude-oauth",
                name: "Anthropic usage endpoint",
                on: false,
                store: "the keychain",
            },
        };
        const statement = (info: CompanionUsageInfo) => {
            const view = experimentalView(info);
            return view.kind === "off" ? plain(view.statement) : "";
        };
        expect(statement(off)).toContain("(source: Anthropic usage endpoint)");
        inFrench(() => expect(statement(off)).toMatch(/\(source\s: service d'utilisation d'Anthropic\)/));
        const unknown = { ...off, experimental: { ...off.experimental, source: "other", name: "Some endpoint" } };
        inFrench(() => expect(statement(unknown)).toMatch(/\(source\s: Some endpoint\)/));
    });

    it("knows every source id of wavesrv, and has a name for each in both languages", () => {
        const dir = join(__dirname, "../../../pkg/molten/usage");
        const goIds = ["claudeoauth.go", "claudestatusline.go", "codex.go"].flatMap((file) =>
            [...readFileSync(join(dir, file), "utf8").matchAll(/SourceId\s*=\s*"([^"]+)"/g)].map((m) => m[1])
        );
        expect([...goIds].sort()).toEqual([...UsageSourceIds].sort());
        for (const id of UsageSourceIds) {
            expect(usageSourceName(id)).not.toContain("companion.gauges.source");
            inFrench(() => expect(usageSourceName(id)).not.toContain("companion.gauges.source"));
        }
    });
});
