// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The legend of the cards' colours (#2332, FR-REV-001 AC20): a line for every tone the cards can take, read from the
// cards' own tables, tones that look alike shown once, a calm button in the header, a card that opens on hover or focus
// and pins on a click.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { MissionHeader } from "../mission/mission-frame";
import { StateMarkKinds, type StateMarkKind } from "../state-mark";
import { RailColours, SentenceClasses, ToneMarks } from "./reviews-card";
import { CardStateKinds, CardStateTones, type CardTone } from "./reviews-card-model";
import { LegendButton, LegendCard } from "./reviews-legend";
import {
    LegendClosed,
    LegendHoverDelay,
    LegendLabelKeys,
    LegendMeaningKeys,
    LegendToneOrder,
    legendChange,
    legendEntries,
    legendReturnsFocus,
    type LegendState,
} from "./reviews-legend-model";

function lookup(dict: any, key: string): string {
    return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

function source(name: string): string {
    return readFileSync(new URL(name, import.meta.url), "utf8");
}

// The tones of the CardTone type itself, so that a tone added there without a line in the legend fails here.
const TypeTones = (() => {
    const declared = source("./reviews-card-model.ts").match(/export type CardTone =([^;]+);/);
    return [...declared[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]) as CardTone[];
})();

const LegendSources = ["./reviews-legend.tsx", "./reviews-legend-model.ts"].map(source);

describe("the legend's lines (AC2)", () => {
    const entries = legendEntries(RailColours, ToneMarks);

    it("reads the tones from the CardTone type and finds the same ones in the cards' tables", () => {
        expect(TypeTones.length).toBeGreaterThanOrEqual(7);
        expect([...TypeTones].sort()).toEqual(Object.keys(RailColours).sort());
        expect([...TypeTones].sort()).toEqual(Object.keys(ToneMarks).sort());
        expect([...TypeTones].sort()).toEqual(Object.keys(SentenceClasses).sort());
        expect([...TypeTones].sort()).toEqual(Object.keys(LegendMeaningKeys).sort());
    });

    it("has a line for every CardTone, once", () => {
        for (const tone of TypeTones) {
            expect(entries.filter((e) => e.tones.includes(tone)).length, tone).toBe(1);
        }
        expect(entries.flatMap((e) => e.tones).sort()).toEqual([...TypeTones].sort());
    });

    it("has a line for every tone a card state can take", () => {
        expect(CardStateKinds.length).toBeGreaterThan(0);
        for (const kind of CardStateKinds) {
            const tone = CardStateTones[kind];
            expect(
                entries.some((e) => e.tones.includes(tone)),
                `${kind} (${tone})`
            ).toBe(true);
        }
    });

    it("shows once the tones that render alike, in the panel's order of attention", () => {
        expect(entries.map((e) => e.tones)).toEqual([
            ["you"],
            ["ready"],
            ["broken"],
            ["agent", "running"],
            ["draft", "wait"],
        ]);
        expect(entries.map((e) => e.mark)).toEqual(["waiting", "ready", "blocked", "running", "draft"]);
        for (const entry of entries) {
            for (const tone of entry.tones) {
                expect(RailColours[tone], tone).toBe(RailColours[entry.tone]);
                expect(ToneMarks[tone], tone).toBe(entry.mark);
            }
        }
        expect(new Set(entries.map((e) => `${RailColours[e.tone]}|${e.mark}`)).size).toBe(entries.length);
        expect(LegendToneOrder.slice().sort()).toEqual([...TypeTones].sort());
    });

    it("adds a line for a new look and merges a tone that looks like another", () => {
        const rails = { ...RailColours, spare: "var(--mt-state-warning)", twin: RailColours.ready } as Record<
            CardTone,
            string
        >;
        const marks = { ...ToneMarks, spare: "blocked", twin: "ready" } as Record<CardTone, StateMarkKind>;
        const next = legendEntries(rails, marks);
        expect(next.length).toBe(entries.length + 1);
        expect(next.at(-1).tones).toEqual(["spare"]);
        expect(next.find((e) => e.tones.includes("ready")).tones).toEqual(["ready", "twin" as CardTone]);
    });

    it("tells a rail colour apart by its mark as well", () => {
        const marks = { ...ToneMarks, wait: "waiting" } as Record<CardTone, StateMarkKind>;
        const next = legendEntries(RailColours, marks);
        expect(next.map((e) => e.tones)).toContainEqual(["draft"]);
        expect(next.map((e) => e.tones)).toContainEqual(["wait"]);
    });

    it("never defines a colour of its own", () => {
        for (const code of LegendSources) {
            expect(code).not.toMatch(
                /["'`(]#[0-9a-fA-F]{3,8}["'`);]|rgba?\(|hsla?\(|color-mix|var\(--mt-state|var\(--mt-line/
            );
        }
    });
});

describe("the card (AC1)", () => {
    const html = renderToStaticMarkup(<LegendCard />);
    const lines = html.split('data-testid="reviews-legend-line"').slice(1);

    it("lists each state with its real rail colour, its state mark and its sentence", () => {
        expect(lines.length).toBe(5);
        const entries = legendEntries(RailColours, ToneMarks);
        entries.forEach((entry, i) => {
            const line = lines[i];
            expect(line, entry.tone).toContain(`data-tones="${entry.tones.join(" ")}"`);
            expect(line, entry.tone).toContain(`style="background:${RailColours[entry.tone]}"`);
            expect(line, entry.tone).toContain(`data-state="${entry.mark}"`);
            expect(line, entry.tone).toContain(lookup(en, LegendLabelKeys[entry.mark]));
            for (const key of entry.meaningKeys) {
                expect(line, key).toContain(lookup(en, key));
            }
            expect(line, entry.tone).toContain(SentenceClasses[entry.tone]);
        });
    });

    it("uses every shape of the state mark once, so that no state rests on its colour alone", () => {
        const shapes = [...html.matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]);
        expect(shapes.sort()).toEqual([...StateMarkKinds].sort());
    });

    it("says what the five states mean in plain words", () => {
        expect(html).toContain("What the colours mean");
        expect(html).toContain("Waiting for you");
        expect(html).toContain("An agent stopped to ask you something");
        expect(html).toContain("Ready to merge");
        expect(html).toContain("The CI is green and nothing is open");
        expect(html).toContain("Blocked");
        expect(html).toContain("The CI failed or it conflicts with its target branch");
        expect(html).toContain("In progress");
        expect(html).toContain("An agent is working on it. The CI is running.");
        expect(html).toContain("Nothing moving");
        expect(html).toContain("Its agent is done or stopped, and nobody is working on it. It waits on something else");
    });

    it("sits on a low-cornered surface of the theme, with no colour of its own", () => {
        expect(html).toMatch(/class="[^"]*\brounded-4\b[^"]*\bbg-surface-3\b/);
        expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
        expect(html).not.toContain("cursor-help");
    });
});

describe("the words (AC3)", () => {
    const keys = [
        "reviews.legend.button",
        "reviews.legend.title",
        "reviews.legend.intro",
        ...Object.values(LegendMeaningKeys),
        ...Object.values(LegendLabelKeys),
    ];
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

    it("has every key in both languages, with the same placeholders", () => {
        for (const key of keys) {
            expect(lookup(en, key), key).toBeTypeOf("string");
            expect(lookup(fr, key), key).toBeTypeOf("string");
            expect(lookup(en, key).length, key).toBeGreaterThan(0);
            expect(holes(lookup(fr, key)), key).toEqual(holes(lookup(en, key)));
        }
    });

    it("names a label for every shape of the state mark and a meaning for every tone", () => {
        expect(Object.keys(LegendLabelKeys).sort()).toEqual([...StateMarkKinds].sort());
        expect(Object.keys(LegendMeaningKeys).sort()).toEqual([...TypeTones].sort());
    });

    it("says it in French too", () => {
        expect(lookup(fr, "reviews.legend.button")).toBe("Ce que veulent dire les couleurs");
        expect(lookup(fr, LegendLabelKeys.waiting)).toBe("Vous attend");
        expect(lookup(fr, LegendLabelKeys.draft)).toBe("Rien ne bouge");
    });
});

function after(state: LegendState, steps: [boolean, string][]): LegendState {
    return steps.reduce((s, [open, reason]) => legendChange(s, open, reason), state);
}

describe("opening and closing (AC1)", () => {
    it("shows on hover or on keyboard focus, and hides when the pointer or the focus leaves", () => {
        expect(after(LegendClosed, [[true, "hover"]])).toEqual({ open: true, pinned: false });
        expect(after(LegendClosed, [[true, "focus"]])).toEqual({ open: true, pinned: false });
        expect(
            after(LegendClosed, [
                [true, "hover"],
                [false, "hover"],
            ])
        ).toEqual(LegendClosed);
        expect(
            after(LegendClosed, [
                [true, "hover"],
                [false, "safe-polygon"],
            ])
        ).toEqual(LegendClosed);
        expect(
            after(LegendClosed, [
                [true, "focus"],
                [false, "focus-out"],
            ])
        ).toEqual(LegendClosed);
    });

    it("pins on a click, whether the hover opened it first or not", () => {
        expect(
            after(LegendClosed, [
                [true, "hover"],
                [true, "click"],
            ])
        ).toEqual({ open: true, pinned: true });
        expect(after(LegendClosed, [[true, "click"]])).toEqual({ open: true, pinned: true });
        expect(
            after(LegendClosed, [
                [true, "focus"],
                [true, "click"],
            ])
        ).toEqual({ open: true, pinned: true });
    });

    it("stays open once pinned while the pointer or the focus leaves and comes back", () => {
        const pinned = after(LegendClosed, [
            [true, "hover"],
            [true, "click"],
        ]);
        for (const reason of ["hover", "safe-polygon", "focus-out", "focus"]) {
            expect(legendChange(pinned, false, reason), reason).toEqual(pinned);
        }
        expect(
            after(pinned, [
                [false, "hover"],
                [true, "hover"],
            ])
        ).toEqual(pinned);
    });

    it("closes a pinned card on Escape, on a click outside, and on a second click on the button", () => {
        const pinned = after(LegendClosed, [[true, "click"]]);
        expect(legendChange(pinned, false, "escape-key")).toEqual(LegendClosed);
        expect(legendChange(pinned, false, "outside-press")).toEqual(LegendClosed);
        expect(legendChange(pinned, false, "click")).toEqual(LegendClosed);
    });

    it("closes a card that was only hovered on Escape and on a click outside too", () => {
        const hovered = after(LegendClosed, [[true, "hover"]]);
        expect(legendChange(hovered, false, "escape-key")).toEqual(LegendClosed);
        expect(legendChange(hovered, false, "outside-press")).toEqual(LegendClosed);
    });

    it("forgets the pin once closed: the next hover shows it unpinned", () => {
        const next = after(LegendClosed, [
            [true, "click"],
            [false, "escape-key"],
            [true, "hover"],
        ]);
        expect(next).toEqual({ open: true, pinned: false });
        expect(legendChange(next, false, "hover")).toEqual(LegendClosed);
    });

    it("brings the focus back to the button after Escape only", () => {
        expect(legendReturnsFocus(false, "escape-key")).toBe(true);
        for (const reason of ["outside-press", "click", "hover", "focus-out", undefined]) {
            expect(legendReturnsFocus(false, reason), String(reason)).toBe(false);
        }
        expect(legendReturnsFocus(true, "escape-key")).toBe(false);
    });

    it("waits a little before a hover shows it, and hides it soon after the pointer leaves", () => {
        expect(LegendHoverDelay.open).toBeGreaterThan(0);
        expect(LegendHoverDelay.open).toBeLessThanOrEqual(600);
        expect(LegendHoverDelay.close).toBeLessThan(LegendHoverDelay.open);
    });
});

describe("the button (AC1, rule: no surprise in the UI)", () => {
    const html = renderToStaticMarkup(<LegendButton />);

    it("is a calm icon button with its name, shown closed: nothing opens by itself", () => {
        expect(html).toContain('data-testid="reviews-legend-button"');
        expect(html).toContain('aria-label="What the colours mean"');
        expect(html).toContain('aria-pressed="false"');
        expect(html).toContain("fa-circle-question");
        expect(html).not.toContain('data-testid="reviews-legend"');
        expect(html).not.toContain("reviews-legend-line");
    });

    it("has the pointer cursor, no help cursor, and no native tooltip over the card", () => {
        expect(html).toContain("cursor-pointer");
        expect(html).not.toContain("cursor-help");
        expect(html).not.toContain(" title=");
    });

    it("sits in the header bar right after the refresh button", () => {
        const header = renderToStaticMarkup(
            <MissionHeader
                project={{ workspace: null, dir: "/work/demo", facts: null }}
                snapshot={null}
                onRefresh={() => {}}
                trailing={<LegendButton />}
            >
                <span data-testid="header-child" />
            </MissionHeader>
        );
        const refresh = header.indexOf('aria-label="Refresh"');
        const legend = header.indexOf('data-testid="reviews-legend-button"');
        expect(refresh).toBeGreaterThan(0);
        expect(legend).toBeGreaterThan(refresh);
        expect(header.indexOf('data-testid="header-child"')).toBeLessThan(refresh);
    });

    it("is the Integration panel's header that carries it, once its list is read", () => {
        const view = source("./reviews-view.tsx");
        expect(view).toMatch(/<MissionHeader[^>]*trailing=\{answer\?\.state === "ok" \? <LegendButton \/> : null\}/);
    });
});
