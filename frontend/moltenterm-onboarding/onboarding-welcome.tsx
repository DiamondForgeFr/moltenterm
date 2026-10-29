// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The welcome page, the panel's first (FR-ONB-001), full frame (FR-SHELL-110): the >_ glyph with the turning light,
// what MoltenTerm is in a few lines, one molten call to action, the licence and the privacy commitment; the credit to
// Wave Terminal lives in About. Everything is bundled: no remote font, image or request until the user clicks a link
// (NFR-ONB-002).

import { modalsModel } from "@/app/store/modalmodel";
import { MoltentermRepoUrl } from "@/util/moltenterm-identity";
import { cn } from "@/util/util";
import { useId } from "react";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { formatKeys, modifierLabel } from "../moltenterm-shell/shortcuts/format";
import { ShortcutsSheetKey } from "../moltenterm-shell/shortcuts/registry";
import { GlowRing } from "../moltenterm-shell/suite/suite";
import { ShownFirstRunSteps } from "./onboarding-steps";
import "./onboarding-welcome.css";

export const MoltentermLicenseUrl = `${MoltentermRepoUrl}/blob/main/LICENSE`;
export const MoltentermPrivacyUrl = `${MoltentermRepoUrl}/blob/main/PRIVACY.md`;

// Keys of onboarding.welcome.points.<id>.title / .text (FR-I18N-001).
const Points: { id: string; icon: string }[] = [
    { id: "agent", icon: "terminal" },
    { id: "morph", icon: "wand-magic-sparkles" },
    { id: "sessions", icon: "clock-rotate-left" },
    { id: "privacy", icon: "lock" },
    // The shortcut overlay (FR-SHELL-090): how to call it up, in the platform's keys.
    { id: "shortcuts", icon: "keyboard" },
];

// The commands a point names, set in code wherever its translation puts their placeholder.
const PointCode: Record<string, string> = { morph: "/morph", undo: "molten undo" };

// The keys a point names, formatted for this platform by the shortcut registry, never hard-coded glyphs.
function pointKeys(): Record<string, string> {
    return { hold: modifierLabel("Cmd"), press: formatKeys(ShortcutsSheetKey) };
}

function withCode(text: string): React.ReactNode[] {
    const keys = pointKeys();
    return text.split(/\{(morph|undo|hold|press)\}/).map((part, i) => {
        if (i % 2 === 0) {
            return part;
        }
        if (keys[part] != null) {
            return (
                <kbd
                    key={i}
                    className="rounded-4 border border-border px-1 font-mono text-12 text-primary"
                    data-testid={`onboarding-shortcut-${part}`}
                >
                    {keys[part]}
                </kbd>
            );
        }
        return (
            <code key={i} className="font-mono text-12 text-primary">
                {PointCode[part]}
            </code>
        );
    });
}

const linkClassName = "cursor-pointer text-secondary underline decoration-border underline-offset-2 hover:text-primary";

export function OnboardingWelcome({
    busy,
    error,
    onStart,
    onSkip,
}: {
    busy: boolean;
    error?: string;
    onStart: () => void;
    onSkip: () => void;
}) {
    const t = useT();
    return (
        <div className="molten-welcome" data-testid="first-run-welcome">
            <div className="molten-welcome-in flex flex-col">
                <WelcomeGlyph />
                <h1 className="mb-1.5 text-32 leading-tight font-semibold tracking-tight text-primary">
                    {t("onboarding.welcome.title")}
                </h1>
                <p className="mb-6 text-15 text-secondary">{t("onboarding.welcome.tagline")}</p>
                <ul className="mb-6 flex flex-col gap-2.5">
                    {Points.map((point) => (
                        <li key={point.icon} className="flex gap-2.5">
                            <i
                                className={cn("fa-solid fa-fw mt-[3px] text-icon-14 text-muted", `fa-${point.icon}`)}
                                aria-hidden
                            />
                            <p className="text-13 leading-5 text-secondary">
                                <span className="font-semibold text-primary">
                                    {t(`onboarding.welcome.points.${point.id}.title`)}
                                </span>{" "}
                                {withCode(t(`onboarding.welcome.points.${point.id}.text`))}
                            </p>
                        </li>
                    ))}
                </ul>
                <div className="flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onStart}
                        className={cn("molten-btn rounded-6 px-5 py-2.5 text-13 font-semibold", busy && "opacity-60")}
                        data-testid="first-run-start"
                    >
                        {t("onboarding.welcome.start")}
                        <MoltenWave />
                    </button>
                    <span className="text-12 text-muted">
                        {ShownFirstRunSteps.length === 1
                            ? t("onboarding.welcome.stepsOne")
                            : t("onboarding.welcome.stepsOther", { count: ShownFirstRunSteps.length })}
                    </span>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onSkip}
                        className="molten-btn-ghost ml-auto cursor-pointer rounded-6 px-3 py-2 text-13 text-secondary hover:text-primary"
                    >
                        {t("onboarding.welcome.skip")}
                    </button>
                </div>
                {error ? (
                    <p className="mt-3 text-12 text-danger" role="alert">
                        {error}
                    </p>
                ) : null}
                <footer className="mt-7 flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-border pt-3 text-12 text-muted">
                    <span>{t("onboarding.welcome.license")}</span>
                    <a href={MoltentermLicenseUrl} target="_blank" rel="noopener" className={linkClassName}>
                        {t("onboarding.welcome.licenceLink")}
                    </a>
                    <a href={MoltentermPrivacyUrl} target="_blank" rel="noopener" className={linkClassName}>
                        {t("onboarding.welcome.privacyLink")}
                    </a>
                    <button
                        type="button"
                        onClick={() => modalsModel.pushModal("AboutModal")}
                        className={linkClassName}
                        data-testid="first-run-about"
                    >
                        {t("onboarding.welcome.aboutLink")}
                    </button>
                </footer>
            </div>
        </div>
    );
}

// The >_ glyph in molten metal; the light turning round its frame says MoltenTerm is getting ready (stilled under
// reduced motion).
function WelcomeGlyph() {
    // React's ids hold characters a url(#…) reference does not take.
    const gradientId = `mt-welcome-${useId().replace(/[^\w-]/g, "")}`;
    return (
        <div className="molten-welcome-glyph" aria-hidden>
            <GlowRing on />
            <svg viewBox="0 0 40 40">
                <defs>
                    <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="0" y1="8" x2="0" y2="32">
                        <stop offset="0" className="stop-hot" />
                        <stop offset=".35" className="stop-mid" />
                        <stop offset="1" className="stop-base" />
                    </linearGradient>
                </defs>
                <path
                    d="M8 11 L18 20 L8 29"
                    stroke={`url(#${gradientId})`}
                    strokeWidth="4"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                <path d="M21 30 H33" stroke={`url(#${gradientId})`} strokeWidth="4" strokeLinecap="round" />
            </svg>
        </div>
    );
}
