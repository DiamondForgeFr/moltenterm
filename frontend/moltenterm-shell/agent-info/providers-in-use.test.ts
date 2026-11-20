// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    DefaultProvidersUseDays,
    MaxProvidersUseDays,
    orderProviders,
    preferredProviderId,
    ProviderAgent,
    providersUseWindowMs,
} from "./providers-in-use";

// A fake clock: every time is a fixed offset from Now, so no test waits or reads the real clock.
const Now = 1_800_000_000_000;
const Minute = 60 * 1000;
const Hour = 60 * Minute;
const Day = 24 * Hour;
const Window = 7 * Day;

const agent = (id: string, installed = true): ProviderAgent => ({ id, name: id, installed });

// The last use of each provider, from a table of how long ago it was used (synthetic values only).
const lastUseFrom =
    (ages: Record<string, number>) =>
    (id: string): number =>
        id in ages ? Now - ages[id] : 0;

describe("the window of recent use comes from Settings (FR-AGC-004)", () => {
    it("is 7 days when the setting is unset or not a usable count", () => {
        expect(providersUseWindowMs(undefined)).toBe(DefaultProvidersUseDays * Day);
        expect(providersUseWindowMs(null)).toBe(7 * Day);
        expect(providersUseWindowMs(0)).toBe(7 * Day);
        expect(providersUseWindowMs(Number.NaN)).toBe(7 * Day);
        expect(providersUseWindowMs("3")).toBe(7 * Day);
    });

    it("is the days the developer set, rounded and capped at the range of the setting", () => {
        expect(providersUseWindowMs(3)).toBe(3 * Day);
        expect(providersUseWindowMs(2.4)).toBe(2 * Day);
        expect(providersUseWindowMs(999)).toBe(MaxProvidersUseDays * Day);
    });
});

describe("a provider is in use when installed and used within the window (FR-AGC-004)", () => {
    it("puts an installed provider used recently in use, and an installed stale one in other", () => {
        const order = orderProviders(
            [agent("kimi"), agent("codex")],
            lastUseFrom({ kimi: Hour, codex: 8 * Day }),
            Now,
            Window
        );
        expect(order.shown.map((a) => a.id)).toEqual(["kimi"]);
        expect(order.other.map((a) => a.id)).toEqual(["codex"]);
    });

    it("never offers a provider that is not installed, used or not", () => {
        const order = orderProviders(
            [agent("claude"), agent("codex", false)],
            lastUseFrom({ codex: Minute, claude: Hour }),
            Now,
            Window
        );
        expect(order.shown.map((a) => a.id)).toEqual(["claude"]);
        expect(order.other).toEqual([]);
    });

    it("counts a use exactly one window old as no longer in use", () => {
        const at = (age: number) =>
            orderProviders([agent("codex")], lastUseFrom({ codex: age }), Now, Window).shown.length;
        expect(at(Window)).toBe(0);
        expect(at(Window - 1)).toBe(1);
    });

    it("treats a provider with no known use as not in use", () => {
        const order = orderProviders([agent("codex")], lastUseFrom({}), Now, Window);
        expect(order.shown).toEqual([]);
        expect(order.other.map((a) => a.id)).toEqual(["codex"]);
    });
});

describe("the order is by last use, the most recent first (#2431)", () => {
    it("lists the providers in use by their last use, not by a fixed order", () => {
        const order = orderProviders(
            [agent("claude"), agent("codex"), agent("kimi")],
            lastUseFrom({ claude: 3 * Hour, codex: 10 * Minute, kimi: 2 * Day }),
            Now,
            Window
        );
        expect(order.shown.map((a) => a.id)).toEqual(["codex", "claude", "kimi"]);
    });

    it("ranks a recently used provider before a week-old Codex in a synthetic scenario", () => {
        const order = orderProviders(
            [agent("codex"), agent("kimi")],
            lastUseFrom({ codex: 8 * Day, kimi: 5 * Hour }),
            Now,
            Window
        );
        expect(order.shown.map((a) => a.id)).toEqual(["kimi"]);
        expect(order.other.map((a) => a.id)).toEqual(["codex"]);
    });

    it("keeps the given order on a tie in last use, so no provider is preferred by name", () => {
        const order = orderProviders(
            [agent("kimi"), agent("codex")],
            lastUseFrom({ kimi: Hour, codex: Hour }),
            Now,
            Window
        );
        expect(order.shown.map((a) => a.id)).toEqual(["kimi", "codex"]);
    });
});

describe("the preferred provider leads a choice (#2431)", () => {
    it("leads with the preferred provider, even stale, and keeps the others in use after it", () => {
        const order = orderProviders(
            [agent("claude"), agent("codex"), agent("kimi")],
            lastUseFrom({ codex: Hour, kimi: 2 * Hour, claude: 30 * Day }),
            Now,
            Window,
            "claude"
        );
        expect(order.shown.map((a) => a.id)).toEqual(["claude", "codex", "kimi"]);
        expect(order.other).toEqual([]);
    });

    it("ignores a preferred provider that is not installed", () => {
        const order = orderProviders(
            [agent("codex", false), agent("kimi")],
            lastUseFrom({ kimi: Hour }),
            Now,
            Window,
            "codex"
        );
        expect(order.shown.map((a) => a.id)).toEqual(["kimi"]);
    });

    it('finds the provider behind a pull request\'s agent name, ignoring a provider host after "via"', () => {
        const agents = [{ id: "claude", name: "Claude Code", installed: true }, agent("codex")];
        expect(preferredProviderId("Claude Code", agents)).toBe("claude");
        expect(preferredProviderId("Claude Code via GLM", agents)).toBe("claude");
        expect(preferredProviderId("Unknown Agent", agents)).toBe("");
        expect(preferredProviderId("", agents)).toBe("");
    });
});

describe("the resume picker's order, from the PR's provider (#2431)", () => {
    // Synthetic: Claude Code made the pull request, Kimi Code was used today, Codex eight days ago.
    const agents = [
        { id: "claude", name: "Claude Code", installed: true },
        { id: "kimi", name: "Kimi Code", installed: true },
        { id: "codex", name: "Codex", installed: true },
    ];

    it("defaults to the provider that made the PR, then Kimi Code, with Codex under Other agents", () => {
        const preferred = preferredProviderId("Claude Code", agents);
        const order = orderProviders(agents, lastUseFrom({ kimi: 3 * Hour, codex: 8 * Day }), Now, Window, preferred);
        expect(order.shown.map((a) => a.id)).toEqual(["claude", "kimi"]);
        expect(order.other.map((a) => a.id)).toEqual(["codex"]);
    });

    it("names no provider in code: the same rule leads with whichever provider made the PR", () => {
        const preferred = preferredProviderId("Kimi Code", agents);
        const order = orderProviders(agents, lastUseFrom({ claude: 2 * Day, codex: 8 * Day }), Now, Window, preferred);
        expect(order.shown.map((a) => a.id)).toEqual(["kimi", "claude"]);
        expect(order.other.map((a) => a.id)).toEqual(["codex"]);
    });
});

describe("a provider used again comes back by itself (#2431)", () => {
    it("moves from other to in use once it is used again, and back out after the window", () => {
        const agents = [agent("codex")];
        expect(orderProviders(agents, lastUseFrom({ codex: 9 * Day }), Now, Window).other).toHaveLength(1);
        expect(orderProviders(agents, lastUseFrom({ codex: Minute }), Now, Window).shown).toHaveLength(1);
        expect(orderProviders(agents, lastUseFrom({ codex: 8 * Day }), Now, Window).other).toHaveLength(1);
    });

    it("follows the window the developer set: a shorter one folds a provider the 7-day window kept", () => {
        const ages = lastUseFrom({ codex: 3 * Day });
        expect(orderProviders([agent("codex")], ages, Now, providersUseWindowMs(7)).shown).toHaveLength(1);
        expect(orderProviders([agent("codex")], ages, Now, providersUseWindowMs(2)).other).toHaveLength(1);
    });
});
