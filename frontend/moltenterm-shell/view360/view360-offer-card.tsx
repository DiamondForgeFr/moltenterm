// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The inline offers of the 360 view (FR-SHELL-066-AC11, AC12, #2180), drawn in the view at the bottom right (the agent
// stays on the left, the graphics on the right): "Switch to the 360 view?" the first time a view that never was in 360
// view goes beyond the screen's column threshold, with the numbers of visible panels of the chooser, Keep the grid and
// "Do the same in every view"; then, once, "Save for this {width} × {height} screen?" after a change of configuration
// on a screen the Columns per screen list does not hold. Neither is a toast or a dialog: they never take the focus (a
// press on them keeps it where it was, nothing focuses on opening), are read politely, and go once answered.

import { useAtomValue } from "jotai";
import { memo, useId, useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { ScreenModel } from "./screen-store";
import { screenSaveOffered } from "./screen-threshold";
import { CarpetIcon } from "./view360-icon";
import { OfferGrid } from "./view360-meta";
import type { View360Model } from "./view360-model";
import type { OfferState, ScreenOffer } from "./view360-offer";
import { PlaceCount } from "./view360-places";
import "./view360.css";

const AccentButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";

// A press on the card does not move the focus from the panel that has it: the terminal keeps typing.
export function keepFocus(e: { preventDefault: () => void }): void {
    e.preventDefault();
}

type FirstTimeProps = { view360: View360Model; offer: OfferState };

export function FirstTimeOffer({ view360, offer }: FirstTimeProps) {
    const t = useT();
    const titleId = useId();
    const labelId = useId();
    const [everyView, setEveryView] = useState(false);
    const [hover, setHover] = useState<number>(null);
    const offered = offer.options.filter((o) => o.offered);
    return (
        <section
            role="group"
            aria-labelledby={titleId}
            aria-live="polite"
            className="mt-offer"
            data-testid="mt-v360-offer"
            onMouseDown={keepFocus}
        >
            <div className="mt-offer-head">
                <CarpetIcon />
                <span id={titleId}>{t("view360.offer.title")}</span>
            </div>
            <p className="mt-offer-text">{t("view360.offer.message")}</p>
            <div className="mt-places-label" id={labelId}>
                {t("view360.places.label")}
            </div>
            <div
                className="mt-places-counts mt-offer-counts"
                role="group"
                aria-labelledby={labelId}
                style={{ gridTemplateColumns: `repeat(${Math.max(1, offered.length)}, minmax(0, 1fr))` }}
            >
                {offered.map((option) => (
                    <PlaceCount
                        key={option.n}
                        option={option}
                        hover={hover === option.n}
                        testId={`mt-offer-${option.n}`}
                        onHover={(on) => setHover((h) => (on ? option.n : h === option.n ? null : h))}
                        onApply={() => view360.answerOffer(option.n, everyView)}
                    />
                ))}
            </div>
            <label className="mt-offer-check cursor-pointer">
                <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={everyView}
                    data-testid="mt-offer-every"
                    onChange={(e) => setEveryView(e.target.checked)}
                />
                <span>{t("view360.offer.everyView")}</span>
            </label>
            <p className="mt-offer-hint">{t("view360.offer.everyViewHint")}</p>
            <div className="mt-offer-foot">
                <button
                    type="button"
                    className="mt-offer-ghost cursor-pointer"
                    data-testid="mt-offer-grid"
                    onClick={() => view360.answerOffer(OfferGrid, everyView)}
                >
                    {t("view360.notice.keepGrid")}
                </button>
            </div>
        </section>
    );
}

type ScreenProps = { view360: View360Model; offer: ScreenOffer };

export function ScreenSaveOffer({ view360, offer }: ScreenProps) {
    const t = useT();
    const titleId = useId();
    const { screen, columns } = offer;
    return (
        <section
            role="group"
            aria-labelledby={titleId}
            aria-live="polite"
            className="mt-offer"
            data-testid="mt-v360-screen-offer"
            onMouseDown={keepFocus}
        >
            <div className="mt-offer-head">
                <i className="fa fa-solid fa-display mt-offer-icon" aria-hidden="true" />
                <span id={titleId}>
                    {t("view360.offer.saveTitle", { width: screen.widthpx, height: screen.heightpx })}
                </span>
            </div>
            <p className="mt-offer-text">{t("view360.offer.saveText", { count: columns })}</p>
            <div className="mt-offer-foot">
                <button
                    type="button"
                    className="mt-offer-ghost cursor-pointer"
                    data-testid="mt-offer-notnow"
                    onClick={() => view360.answerScreenOffer(false)}
                >
                    {t("view360.offer.notNow")}
                </button>
                <button
                    type="button"
                    className={AccentButton}
                    data-testid="mt-offer-save"
                    onClick={() => view360.answerScreenOffer(true)}
                >
                    {t("view360.offer.save")}
                    <MoltenWave />
                </button>
            </div>
        </section>
    );
}

export const View360Offers = memo(({ view360 }: { view360: View360Model }) => {
    const offer = useAtomValue(view360.offerAtom);
    const screenOffer = useAtomValue(view360.screenOfferAtom);
    const screens = ScreenModel.getInstance();
    const stored = useAtomValue(screens.storedAtom);
    const asked = useAtomValue(screens.askedAtom);
    const screen = useAtomValue(screens.screenAtom);
    const showScreen =
        screenOffer != null && screen?.key === screenOffer.screen.key && screenSaveOffered(stored, asked, screen);
    if (offer == null && !showScreen) {
        return null;
    }
    return (
        <div className="mt-offer-host" data-testid="mt-v360-offers">
            {offer != null && <FirstTimeOffer view360={view360} offer={offer} />}
            {showScreen && <ScreenSaveOffer view360={view360} offer={screenOffer} />}
        </div>
    );
});
View360Offers.displayName = "View360Offers";
