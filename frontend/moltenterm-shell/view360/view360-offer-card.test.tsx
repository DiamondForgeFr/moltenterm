// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, type PrimitiveAtom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { placeOptions } from "./carpet-places";
import type { ScreenInfo, ScreensAsked, ScreenThresholds } from "./screen-threshold";
import type { View360Model } from "./view360-model";
import type { OfferState, ScreenOffer } from "./view360-offer";
import { FirstTimeOffer, keepFocus, ScreenSaveOffer, View360Offers } from "./view360-offer-card";

// The atoms the component reads are replaced for each case: it reads them through the default store, as the tests of
// the other components do, not through the app's.
const screens = vi.hoisted(() => ({ stored: null as unknown, asked: null as unknown, screen: null as unknown }));

vi.mock("./screen-store", () => ({
    ScreenModel: {
        getInstance: () => ({ storedAtom: screens.stored, askedAtom: screens.asked, screenAtom: screens.screen }),
    },
}));

function setScreens(opts: { stored?: ScreenThresholds; asked?: ScreensAsked; screen?: ScreenInfo }) {
    screens.stored = atom(opts.stored ?? {});
    screens.asked = atom(opts.asked ?? {});
    screens.screen = atom(opts.screen ?? null);
}

const laptop: ScreenInfo = { key: "1512x982@2", widthpx: 1512, heightpx: 982, scalefactor: 2 };
const other: ScreenInfo = { key: "2560x1440@1", widthpx: 2560, heightpx: 1440, scalefactor: 1 };

function fakeView(offer: OfferState, screenOffer: ScreenOffer = null) {
    return {
        offerAtom: atom(offer) as PrimitiveAtom<OfferState>,
        screenOfferAtom: atom(screenOffer) as PrimitiveAtom<ScreenOffer>,
        answerOffer: vi.fn(),
        answerScreenOffer: vi.fn(),
    } as unknown as View360Model;
}

const threeNumbers: OfferState = { options: placeOptions(4, 2400, 0, 0) };
// Two carpet columns: only 1 stores something.
const oneNumber: OfferState = { options: placeOptions(2, 2400, 0, 0) };

beforeEach(() => {
    I18nModel.getInstance().setLanguageSetting("en");
    setScreens({ screen: laptop });
});
afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

describe("the first-time offer card (FR-SHELL-066-AC11, #2180)", () => {
    it("asks Switch to the 360 view? with the numbers the chooser offers, Keep the grid and the check", () => {
        const html = renderToStaticMarkup(<FirstTimeOffer view360={fakeView(threeNumbers)} offer={threeNumbers} />);
        expect(html).toContain('data-testid="mt-v360-offer"');
        expect(html).toContain("Switch to the 360 view?");
        for (const n of [1, 2, 3]) {
            expect(html).toContain(`data-testid="mt-offer-${n}"`);
            expect(html).toContain(`aria-label="${n} · 360 × ${n} ·`);
        }
        expect(html).toContain("Visible panels on the right");
        expect(html).toContain('data-testid="mt-offer-grid"');
        expect(html).toContain("Keep the grid");
        expect(html).toContain("Do the same in every view");
        expect(html).toMatch(/<input type="checkbox"[^>]*data-testid="mt-offer-every"/);
        expect(html).not.toMatch(/data-testid="mt-offer-every"[^>]*checked/);
    });

    it("lists only the numbers that apply", () => {
        const html = renderToStaticMarkup(<FirstTimeOffer view360={fakeView(oneNumber)} offer={oneNumber} />);
        expect(html).toContain('data-testid="mt-offer-1"');
        expect(html).not.toContain('data-testid="mt-offer-2"');
        expect(html).not.toContain('data-testid="mt-offer-3"');
        expect(html).toContain("repeat(1, minmax(0, 1fr))");
    });

    it("is a calm group in the view: read politely, never focused on opening, not a dialog or a toast", () => {
        const html = renderToStaticMarkup(<FirstTimeOffer view360={fakeView(threeNumbers)} offer={threeNumbers} />);
        expect(html).toContain('role="group"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toMatch(/aria-labelledby="[^"]+"/);
        expect(html).not.toContain("autofocus");
        expect(html).not.toContain("autoFocus");
        expect(html).not.toContain('role="dialog"');
        expect(html).not.toContain('role="alertdialog"');
        expect(html).not.toContain("toast");
    });

    it("keeps the focus where it was when it is pressed", () => {
        const event = { preventDefault: vi.fn() };
        keepFocus(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("speaks French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = renderToStaticMarkup(<FirstTimeOffer view360={fakeView(threeNumbers)} offer={threeNumbers} />);
        expect(html).toContain("Passer en vue 360 ?");
        expect(html).toContain("Garder la grille");
        expect(html).toContain("Faire pareil dans toutes les vues");
        expect(html).toContain("Panneaux visibles à droite");
    });
});

describe("the offer to save the screen (FR-SHELL-066-AC12, #2180)", () => {
    const offer: ScreenOffer = { screen: laptop, columns: 3 };

    it("asks Save for this {width} × {height} screen? with what it would save", () => {
        const html = renderToStaticMarkup(<ScreenSaveOffer view360={fakeView(null, offer)} offer={offer} />);
        expect(html).toContain('data-testid="mt-v360-screen-offer"');
        expect(html).toContain("Save for this 1512 × 982 screen?");
        expect(html).toContain("360 view beyond 3 columns");
        expect(html).toContain("Columns per screen");
        expect(html).toContain('data-testid="mt-offer-save"');
        expect(html).toContain('data-testid="mt-offer-notnow"');
        expect(html).toContain("Not now");
        expect(html).not.toContain("autofocus");
    });

    it("speaks French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = renderToStaticMarkup(<ScreenSaveOffer view360={fakeView(null, offer)} offer={offer} />);
        expect(html).toContain("Enregistrer pour cet écran de 1512 × 982 ?");
        expect(html).toContain("Pas maintenant");
    });
});

describe("the offers host", () => {
    const offer: ScreenOffer = { screen: laptop, columns: 3 };

    it("draws nothing while nothing is due", () => {
        expect(renderToStaticMarkup(<View360Offers view360={fakeView(null)} />)).toBe("");
    });

    it("draws the card of the first time, and the screen's once answered", () => {
        const first = renderToStaticMarkup(<View360Offers view360={fakeView(threeNumbers)} />);
        expect(first).toContain('data-testid="mt-v360-offers"');
        expect(first).toContain('data-testid="mt-v360-offer"');
        expect(first).not.toContain("mt-v360-screen-offer");
        const second = renderToStaticMarkup(<View360Offers view360={fakeView(null, offer)} />);
        expect(second).toContain('data-testid="mt-v360-screen-offer"');
        expect(second).not.toContain('data-testid="mt-v360-offer"');
    });

    it("does not offer a screen the list now holds, one that was declined, nor another screen than the window's", () => {
        setScreens({ screen: laptop, stored: { [laptop.key]: { columns: 3 } } });
        expect(renderToStaticMarkup(<View360Offers view360={fakeView(null, offer)} />)).toBe("");
        setScreens({ screen: laptop, asked: { [laptop.key]: true } });
        expect(renderToStaticMarkup(<View360Offers view360={fakeView(null, offer)} />)).toBe("");
        setScreens({ screen: other });
        expect(renderToStaticMarkup(<View360Offers view360={fakeView(null, offer)} />)).toBe("");
    });
});
