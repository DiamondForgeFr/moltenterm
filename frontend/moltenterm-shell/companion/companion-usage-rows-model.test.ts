// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage's rows the developer chose to show (#2462): visibility per provider and per window key, the last row that
// stays, a window never seen shown by default, what a restart brings back, and a week deduced from the month computed
// with the month hidden.

import { describe, expect, it, vi } from "vitest";
import { CompanionUsageInfo, GaugesView, gaugesView, withSessionRing } from "./companion-gauges-model";
import {
    CompanionLayout,
    DefaultCompanionLayout,
    isDefaultLayout,
    normalizeLayout,
    readStoredLayout,
    sameLayout,
    usageOf,
} from "./companion-layout";
import {
    hiddenCount,
    hiddenRowsOf,
    onlyShown,
    setUsageRowHidden,
    usageRowsProps,
    windowChoices,
    withRowChoice,
} from "./companion-usage-rows-model";

const Min = 60 * 1000;
const Hour = 60 * Min;
// Thursday 19 November 2026, 12:00 local.
const now = new Date(2026, 10, 19, 12, 0, 0).getTime();
const monday = new Date(2026, 10, 23, 0, 0, 0).getTime();

const kimi: CompanionUsageInfo = {
    blockid: "k1",
    agent: "kimi",
    pageurl: "https://www.kimi.ai/code/console",
    pagename: "Kimi usage",
    hasgauges: true,
    gauges: "enabled",
    snapshot: {
        agent: "kimi",
        source: "kimi-oauth",
        readat: now - 2 * Min,
        windows: [
            {
                id: "session",
                label: "Current session",
                usedpercent: 0.15,
                resetsat: now + Hour + 20 * Min,
                windowmins: 300,
            },
            {
                id: "week",
                label: "Week (from the month)",
                usedpercent: 128.6,
                resetsat: monday,
                windowmins: 10080,
                deduced: true,
                days: [-1, -1, 240, 150, 0, 0, 0],
            },
            { id: "month", label: "This month", usedpercent: 30, resetsat: new Date(2026, 11, 1, 1, 0).getTime() },
        ],
    },
};

const claude: CompanionUsageInfo = {
    blockid: "c1",
    agent: "claude",
    pageurl: "https://claude.ai/settings/usage",
    pagename: "Claude usage",
    hasgauges: true,
    gauges: "enabled",
    snapshot: {
        agent: "claude",
        source: "claude-statusline",
        readat: now - 3 * Min,
        windows: [
            {
                id: "week",
                label: "This week",
                usedpercent: 63,
                resetsat: new Date(2026, 10, 24, 9, 0).getTime(),
                windowmins: 10080,
            },
            {
                id: "model:fable",
                label: "This week (Fable)",
                usedpercent: 12,
                resetsat: new Date(2026, 10, 24, 9, 0).getTime(),
                windowmins: 10080,
            },
        ],
    },
};

function enabled(view: GaugesView): Extract<GaugesView, { kind: "enabled" }> {
    expect(view.kind).toBe("enabled");
    return view as Extract<GaugesView, { kind: "enabled" }>;
}

const idsOf = (view: GaugesView) => enabled(view).rows.map((row) => row.id);

// What a restart does to a saved layout: it is stored as JSON and read back.
const restart = (layout: CompanionLayout): CompanionLayout => readStoredLayout(JSON.parse(JSON.stringify(layout)));

describe("which rows show, per provider and per window key (#2462)", () => {
    it("shows every row when nothing is hidden, and names the windows as the block shows them", () => {
        const view = enabled(withRowChoice(gaugesView(kimi, now), []));
        expect(view.rows.map((row) => row.id)).toEqual(["session", "week", "month"]);
        // The session draws a ring on today's letter, not a row (#2473): its entry says so.
        expect(view.listed).toEqual([
            { id: "session", label: "Session (ring on today)", shown: true },
            { id: "week", label: "Consumption", shown: true },
            { id: "month", label: "Month", shown: true },
        ]);
        expect(hiddenCount(view.listed)).toBe(0);
    });

    it("keeps only the rows whose key is not hidden: Kimi's week alone, Claude without Fable's", () => {
        expect(idsOf(withRowChoice(gaugesView(kimi, now), ["session", "month"]))).toEqual(["week"]);
        const view = enabled(withRowChoice(gaugesView(claude, now), ["model:fable"]));
        expect(view.rows.map((row) => row.id)).toEqual(["week"]);
        expect(view.listed.map((c) => [c.id, c.label, c.shown])).toEqual([
            ["week", "Consumption", true],
            ["model:fable", "Fable", false],
        ]);
        expect(hiddenCount(view.listed)).toBe(1);
    });

    it("draws the session as a ring while its window shows, and no ring once the developer hid it (#2473)", () => {
        const shown = enabled(withSessionRing(withRowChoice(gaugesView(kimi, now), [])));
        expect(shown.session).toBeDefined();
        expect(shown.rows.map((row) => row.id)).toEqual(["week", "month"]);
        expect(shown.listed.map((c) => [c.id, c.shown])).toEqual([
            ["session", true],
            ["week", true],
            ["month", true],
        ]);
        const hidden = enabled(withSessionRing(withRowChoice(gaugesView(kimi, now), ["session"])));
        expect(hidden.session).toBeUndefined();
        expect(hidden.rows.map((row) => row.id)).toEqual(["week", "month"]);
        expect(hidden.listed.map((c) => [c.id, c.shown])).toEqual([
            ["session", false],
            ["week", true],
            ["month", true],
        ]);
        expect(hiddenCount(hidden.listed)).toBe(1);
    });

    it("counts the session among the windows that stay: it can be the one that cannot turn off", () => {
        const view = enabled(withRowChoice(gaugesView(kimi, now), ["week", "month"]));
        expect(view.listed.map((c) => [c.id, c.shown])).toEqual([
            ["session", true],
            ["week", false],
            ["month", false],
        ]);
        expect(onlyShown(view.listed, "session")).toBe(true);
        const ringOnly = enabled(withSessionRing(view));
        expect(ringOnly.rows).toEqual([]);
        expect(ringOnly.session?.percent).toBeCloseTo(0.15);
        const layout = setUsageRowHidden(DefaultCompanionLayout, "kimi", "session", true, ["session", "week", "month"]);
        expect(hiddenRowsOf(layout, "kimi")).toEqual(["session"]);
        // With the session hidden, the week and the month cannot both go: the last one that shows stays.
        const next = setUsageRowHidden(layout, "kimi", "week", true, ["session", "week", "month"]);
        expect([...hiddenRowsOf(next, "kimi")].sort()).toEqual(["session", "week"]);
        const last = setUsageRowHidden(next, "kimi", "month", true, ["session", "week", "month"]);
        expect([...hiddenRowsOf(last, "kimi")].sort()).toEqual(["session", "week"]);
    });

    it("never takes the choice for a label: the key decides, so a translated label keeps it", () => {
        const hidden = ["month"];
        const english = enabled(withRowChoice(gaugesView(kimi, now), hidden));
        const relabelled = enabled(
            withRowChoice(
                gaugesView(
                    {
                        ...kimi,
                        snapshot: {
                            ...kimi.snapshot,
                            windows: kimi.snapshot.windows.map((w) =>
                                w.id === "month" ? { ...w, label: "Un autre nom pour le mois" } : w
                            ),
                        },
                    },
                    now
                ),
                hidden
            )
        );
        expect(english.rows.map((row) => row.id)).toEqual(["session", "week"]);
        expect(relabelled.rows.map((row) => row.id)).toEqual(["session", "week"]);
    });

    it("shows a window it never saw until the developer hides it", () => {
        const saved = ["session"];
        const before = enabled(withRowChoice(gaugesView(claude, now), saved));
        expect(before.rows.map((row) => row.id)).toEqual(["week", "model:fable"]);
        const later: CompanionUsageInfo = {
            ...claude,
            snapshot: {
                ...claude.snapshot,
                windows: [
                    ...claude.snapshot.windows,
                    { id: "model:opus_5", label: "This week (Opus 5)", usedpercent: 4, windowmins: 10080 },
                ],
            },
        };
        const after = enabled(withRowChoice(gaugesView(later, now), saved));
        expect(after.rows.map((row) => row.id)).toEqual(["week", "model:fable", "model:opus_5"]);
    });

    it("leaves the other states of the usage as they are", () => {
        const off: GaugesView = { kind: "off" };
        expect(withRowChoice(off, ["week"])).toBe(off);
    });
});

describe("at least one row stays (#2462)", () => {
    const choices = (hidden: string[]) =>
        windowChoices(
            [
                { id: "session", label: "Session" },
                { id: "week", label: "Week" },
                { id: "month", label: "Month" },
            ],
            hidden
        );

    it("finds the last row that shows", () => {
        expect(onlyShown(choices([]), "week")).toBe(false);
        expect(onlyShown(choices(["session"]), "week")).toBe(false);
        expect(onlyShown(choices(["session", "month"]), "week")).toBe(true);
        expect(onlyShown(choices(["session", "month"]), "session")).toBe(false);
    });

    it("refuses to hide the last row that shows, and hides any other", () => {
        const reported = ["session", "week", "month"];
        const two = setUsageRowHidden(DefaultCompanionLayout, "kimi", "session", true, reported);
        const one = setUsageRowHidden(two, "kimi", "month", true, reported);
        expect(hiddenRowsOf(one, "kimi")).toEqual(["month", "session"]);
        const refused = setUsageRowHidden(one, "kimi", "week", true, reported);
        expect(hiddenRowsOf(refused, "kimi")).toEqual(["month", "session"]);
        expect(sameLayout(refused, one)).toBe(true);
    });

    it("shows every window when a saved choice would hide them all, and a change from there starts from them all", () => {
        const stale = ["session", "week", "month"];
        expect(windowChoices([{ id: "week", label: "Week" }], ["week"]).map((c) => c.shown)).toEqual([true]);
        expect(idsOf(withRowChoice(gaugesView(kimi, now), stale))).toEqual(["session", "week", "month"]);
        const saved = setUsageRowHidden(DefaultCompanionLayout, "kimi", "x", true, ["x"]);
        expect(hiddenRowsOf(saved, "kimi")).toEqual([]);
        let layout = normalizeLayout(
            DefaultCompanionLayout.map((p) => (p.id === "usage" ? { ...p, hiddenrows: { kimi: stale } } : p))
        );
        layout = setUsageRowHidden(layout, "kimi", "month", true, stale);
        expect(hiddenRowsOf(layout, "kimi")).toEqual(["month"]);
        expect(idsOf(withRowChoice(gaugesView(kimi, now), hiddenRowsOf(layout, "kimi")))).toEqual(["session", "week"]);
    });
});

describe("the choice in the layout (#2462)", () => {
    it("is kept per provider: hiding Kimi's month leaves Claude's rows alone", () => {
        const layout = setUsageRowHidden(DefaultCompanionLayout, "kimi", "month", true, ["session", "week", "month"]);
        expect(hiddenRowsOf(layout, "kimi")).toEqual(["month"]);
        expect(hiddenRowsOf(layout, "claude")).toEqual([]);
        const both = setUsageRowHidden(layout, "claude", "model:fable", true, ["week", "model:fable"]);
        expect(hiddenRowsOf(both, "kimi")).toEqual(["month"]);
        expect(hiddenRowsOf(both, "claude")).toEqual(["model:fable"]);
    });

    it("shows a row again, and a layout that hides nothing is the default one", () => {
        const reported = ["session", "week", "month"];
        const hidden = setUsageRowHidden(DefaultCompanionLayout, "kimi", "month", true, reported);
        expect(isDefaultLayout(hidden)).toBe(false);
        const back = setUsageRowHidden(hidden, "kimi", "month", false, reported);
        expect(hiddenRowsOf(back, "kimi")).toEqual([]);
        expect(back.find((p) => p.id === "usage").hiddenrows).toBeUndefined();
        expect(isDefaultLayout(back)).toBe(true);
    });

    it("keeps the keys of the windows the provider does not report now, so that one that comes back is still hidden", () => {
        const first = setUsageRowHidden(DefaultCompanionLayout, "claude", "session", true, ["session", "week"]);
        const without = setUsageRowHidden(first, "claude", "model:fable", true, ["week", "model:fable"]);
        expect(hiddenRowsOf(without, "claude")).toEqual(["model:fable", "session"]);
        const comesBack = enabled(
            withRowChoice(
                gaugesView(
                    {
                        ...claude,
                        snapshot: {
                            ...claude.snapshot,
                            windows: [
                                { id: "session", label: "Current session", usedpercent: 1, windowmins: 300 },
                                ...claude.snapshot.windows,
                            ],
                        },
                    },
                    now
                ),
                hiddenRowsOf(without, "claude")
            )
        );
        expect(comesBack.rows.map((row) => row.id)).toEqual(["week"]);
    });

    it("is saved with the layout and comes back after a restart", () => {
        const layout = setUsageRowHidden(
            setUsageRowHidden(DefaultCompanionLayout, "kimi", "session", true, ["session", "week", "month"]),
            "claude",
            "model:fable",
            true,
            ["week", "model:fable"]
        );
        const back = restart(layout);
        expect(hiddenRowsOf(back, "kimi")).toEqual(["session"]);
        expect(hiddenRowsOf(back, "claude")).toEqual(["model:fable"]);
        expect(sameLayout(back, layout)).toBe(true);
        expect(restart(back)).toEqual(back);
    });

    it("reads a layout saved before the choice as showing every row", () => {
        const before = restart(DefaultCompanionLayout.map((p) => (p.id === "usage" ? { ...p, minimal: true } : p)));
        expect(hiddenRowsOf(before, "kimi")).toEqual([]);
        expect(usageOf(before)).toEqual({ shown: true, minimal: true, attached: false });
        expect(idsOf(withRowChoice(gaugesView(kimi, now), hiddenRowsOf(before, "kimi")))).toEqual([
            "session",
            "week",
            "month",
        ]);
    });

    it("keeps the rows hidden when the usage is made minimal, attached or hidden, and the other way round", () => {
        const layout = setUsageRowHidden(DefaultCompanionLayout, "kimi", "month", true, ["session", "week", "month"]);
        const moved = normalizeLayout(
            layout.map((p) => (p.id === "usage" ? { ...p, minimal: true, attached: true } : p))
        );
        expect(hiddenRowsOf(moved, "kimi")).toEqual(["month"]);
        expect(usageOf(moved).attached).toBe(true);
    });

    it("saves what usageRowsProps sets, through the given save", () => {
        const save = vi.fn();
        const rows = usageRowsProps(DefaultCompanionLayout, "kimi", save);
        expect(rows.hidden).toEqual([]);
        rows.onSet("month", true, ["session", "week", "month"]);
        expect(save).toHaveBeenCalledTimes(1);
        expect(hiddenRowsOf(save.mock.calls[0][0], "kimi")).toEqual(["month"]);
    });

    it("sets nothing for a provider without a name", () => {
        const layout = setUsageRowHidden(DefaultCompanionLayout, "", "month", true, ["session", "month"]);
        expect(sameLayout(layout, DefaultCompanionLayout)).toBe(true);
    });
});

describe("hiding a row hides nothing else (#2462)", () => {
    it("still computes Kimi's week from the month when the month row is hidden", () => {
        const all = enabled(withRowChoice(gaugesView(kimi, now), []));
        const hidden = enabled(withRowChoice(gaugesView(kimi, now), ["month"]));
        expect(hidden.rows.map((row) => row.id)).toEqual(["session", "week"]);
        const before = all.rows.find((row) => row.id === "week");
        const after = hidden.rows.find((row) => row.id === "week");
        expect(after).toEqual(before);
        expect(after.countdown).toBeDefined();
        expect(after.resets).toContain("Tue 1 Dec");
        expect(after.subLabel).toBe("from the month");
    });

    it("leaves the other rows' figures and resets as they were", () => {
        const all = enabled(withRowChoice(gaugesView(claude, now), []));
        const hidden = enabled(withRowChoice(gaugesView(claude, now), ["model:fable"]));
        expect(hidden.rows[0]).toEqual(all.rows[0]);
    });
});
