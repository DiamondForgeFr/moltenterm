// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlanUsageBody } from "./companion-gauges";
import {
    CompanionUsageInfo,
    gaugeLevel,
    gaugePercent,
    gaugeRows,
    gaugesView,
    resetText,
    usageFor,
    UsageReasonTexts,
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
            reason: UsageReasonTexts.expired,
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
            reason: UsageReasonTexts.failed,
        });
        const view = gaugesView(enabled, now);
        expect(view.kind === "enabled" && [view.source, view.age]).toEqual([
            "Claude Code status line",
            "Updated 3 min ago",
        ]);
    });

    it("takes only this terminal's answers", () => {
        expect(usageFor(enabled, "b1", "claude")).toBe(true);
        expect(usageFor(enabled, "b2", "claude")).toBe(false);
        expect(usageFor(enabled, "b1", "codex")).toBe(false);
        expect(usageFor(null, "b1", "claude")).toBe(false);
    });
});

describe("plan usage section", () => {
    it("is one compact row offering Show plan usage when off", () => {
        const html = markup({ ...enabled, gauges: "off", snapshot: undefined });
        expect(html).toContain('data-state="off"');
        expect(html).toContain(">Show plan usage</button>");
        expect(html).toContain("cursor-pointer");
        expect(html).not.toContain("Experimental");
    });

    it("renders nothing for an agent without gauges", () => {
        expect(markup({ ...enabled, hasgauges: false })).toBe("");
    });

    it("shows each window with its label, percent, bar and reset, marked experimental with its source", () => {
        const html = markup(enabled);
        expect(html).toContain("Experimental");
        expect(html).toContain("From the Claude Code status line");
        expect(html).toContain("Updated 3 min ago");
        expect(html).toContain(">Current session<");
        expect(html).toContain(">23.5 % used<");
        expect(html).toContain("Resets in 2 h 14 min");
        expect(html).toContain(">This week<");
        expect(html).toContain("Resets Fri 10:00");
        expect(html).toContain('role="meter"');
        expect(html).toContain('aria-valuenow="24"');
        expect(html).toContain("width:23.5%");
        expect(html).toMatch(/bg-warning[^"]*" style="width:82%/);
        expect(html).toContain('aria-label="Refresh plan usage"');
        expect(html).toContain(">Hide</button>");
    });

    it("collapses to one muted line on failure, with the reason as tooltip and Hide kept", () => {
        const html = markup({ ...enabled, gauges: "unavailable", reason: "noplan", snapshot: undefined });
        expect(html).toContain('data-state="unavailable"');
        expect(html).toContain('title="Not on a Pro or Max plan"');
        expect(html).toContain("Plan usage unavailable");
        expect(html).toContain(">Hide plan usage</button>");
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
