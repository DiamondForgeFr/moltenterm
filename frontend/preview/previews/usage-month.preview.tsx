// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage's month read like a week (#2532, FR-SHELL-018), on invented readings: one panel per row of the validated
// mockup (https://claude.ai/artifact/LyVT1guodQk6xReNiSKnBw), each on its own clock of January 2024 (a 31-day month that
// reset on Monday 1 January), drawn by the real grid and the real rows of the companion's usage.
// ?w=420|760 the panel's width, ?row=2..7 one row alone, ?lang=fr, ?theme=light, ?brokk=1 the rows as Brokk's grid draws
// them, with a logo in place of the label.

import { weekRow as brokkRow } from "../../moltenterm-shell/boss/brokk-usage-block";
import { usageGrid } from "../../moltenterm-shell/boss/brokk-usage-model";
import { weekRow } from "../../moltenterm-shell/companion/companion-gauges";
import {
    CompanionUsageInfo,
    gaugesView,
    UsageWindow,
    withSessionRing,
} from "../../moltenterm-shell/companion/companion-gauges-model";
import { I18nModel } from "../../moltenterm-shell/i18n/i18n";
import { UsageWeekGrid } from "../../moltenterm-shell/usage-week/usage-week";

const Min = 60 * 1000;
const query = new URLSearchParams(globalThis.location?.search);
if (query.get("lang")) {
    I18nModel.getInstance().setLanguageSetting(query.get("lang"));
}
if (query.get("theme") === "light") {
    globalThis.document?.documentElement.classList.add("mt-light", "df-light");
}
// The preview has no app start to await the interface language: its texts are loaded before the first panel is drawn.
await I18nModel.getInstance().whenReady();
const Width = Number(query.get("w")) || 560;
const Only = Number(query.get("row")) || 0;
const BrokkRows = query.get("brokk") === "1";

const at = (month: number, day: number, hour = 0, minute = 0) => new Date(2024, month - 1, day, hour, minute).getTime();
const HalfADay = (0.5 / 31) * 100;

type Case = {
    row: number;
    title: string;
    now: number;
    windows: (now: number) => UsageWindow[];
    // The week of the month the row opens on, when it is not the one holding today.
    week?: number;
};

const session = (now: number, used: number): UsageWindow => ({
    id: "session",
    label: "Current session",
    usedpercent: used,
    resetsat: now + 100 * Min,
    windowmins: 300,
});

const month = (used: number, extra: Partial<UsageWindow> = {}, resetsat = at(2, 1)): UsageWindow => ({
    id: "month",
    label: "This month",
    usedpercent: used,
    resetsat,
    ...extra,
});

const Cases: Case[] = [
    {
        row: 2,
        title: "Reset on Monday 1 January, half a day used on the 1st, nothing since. It is Wednesday 10: the week of the 8th",
        now: at(1, 10, 12),
        windows: (now) => [session(now, 15), month(HalfADay)],
    },
    {
        row: 3,
        title: "Same month, arrow ‹: the week of the 1st",
        now: at(1, 10, 12),
        windows: (now) => [session(now, 15), month(HalfADay)],
        week: 0,
    },
    {
        row: 4,
        title: "Catch-up: 30 % of the month used on Wednesday 10",
        now: at(1, 10, 12),
        windows: (now) => [session(now, 72), month(30)],
    },
    {
        row: 5,
        title: "A session limit: Thursday 25, 40 % used, a full session worth 1.5 % of the month. Arrow ›: the last week",
        now: at(1, 25, 12),
        windows: (now) => [session(now, 40), month(40, { sessionworth: 1.5, sessionmins: 300 })],
        week: 4,
    },
    {
        row: 6,
        title: "Reset in mid-week, Wednesday 17: Friday 19 is ahead of its pace",
        now: at(1, 19, 12),
        windows: (now) => [session(now, 40), month(12, {}, at(2, 17))],
    },
    {
        row: 7,
        title: "A week (Claude Code): reset on Tuesday, half of Tuesday used, it is Thursday",
        now: at(1, 4, 0, 30),
        windows: (now) => [
            session(now, 0),
            { id: "week", label: "This week", usedpercent: (0.5 / 7) * 100, resetsat: at(1, 9), windowmins: 10080 },
        ],
    },
    {
        row: 8,
        title: "The week before the last: the lost days begin partway through a day",
        now: at(1, 25, 12),
        windows: (now) => [session(now, 40), month(40, { sessionworth: 1.5, sessionmins: 300 })],
        week: 3,
    },
    {
        row: 9,
        title: "A week with a session limit and a measured worth: its last days are lost",
        now: at(1, 12, 12),
        windows: (now) => [
            session(now, 40),
            {
                id: "week",
                label: "This week",
                usedpercent: 10,
                resetsat: at(1, 16, 9),
                windowmins: 10080,
                sessionworth: 2,
                sessionmins: 300,
            },
        ],
    },
];

function info(windows: UsageWindow[], now: number): CompanionUsageInfo {
    return {
        blockid: "preview",
        agent: BrokkRows ? "kimi" : "claude",
        pageurl: "https://example.com/usage",
        pagename: "Usage",
        hasgauges: true,
        gauges: "enabled",
        sourcename: "A usage source",
        snapshot: { agent: BrokkRows ? "kimi" : "claude", source: "preview", readat: now - 2 * Min, windows },
    };
}

function Panel({ c }: { c: Case }) {
    const windows = c.windows(c.now);
    const view = withSessionRing(gaugesView(info(windows, c.now), c.now));
    if (view.kind !== "enabled") {
        return null;
    }
    const initialWeeks = c.week == null ? undefined : { month: c.week, week: c.week, kimi: c.week };
    const rows = BrokkRows
        ? usageGrid({ kimi: { agent: "kimi", source: "preview", readat: c.now - Min, windows } }, c.now).rows.map((u) =>
              brokkRow(u, { show: [], hide: [] })
          )
        : view.rows.map((row) => weekRow(view, row, ""));
    return (
        <section className="flex flex-col gap-2">
            <h3 className="m-0 text-12 font-semibold text-primary">
                Row {c.row}: {c.title}
            </h3>
            <div className="rounded border border-border bg-panel px-3 py-2.5" style={{ width: Width }}>
                <UsageWeekGrid
                    popovers
                    rows={rows}
                    session={BrokkRows ? undefined : view.session}
                    now={c.now}
                    legend={!BrokkRows && c.row === 2}
                    dayFigures={!BrokkRows}
                    initialWeeks={initialWeeks}
                />
            </div>
        </section>
    );
}

export default function UsageMonthPreview() {
    const shown = Cases.filter((c) => Only === 0 || c.row === Only);
    return (
        <div className="flex flex-col gap-5 px-6 pb-10 pt-4" data-testid="usage-month-preview">
            {shown.map((c) => (
                <Panel key={c.row} c={c} />
            ))}
        </div>
    );
}
