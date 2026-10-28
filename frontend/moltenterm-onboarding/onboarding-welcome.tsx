// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The welcome page, the panel's first (FR-ONB-001): what MoltenTerm is in four lines, the licence and the privacy
// commitment. Everything is bundled: no remote font, image or request until the user clicks a link (NFR-ONB-002).

import Logo from "@/app/asset/logo.svg";
import { MoltentermRepoUrl } from "@/util/moltenterm-identity";
import { cn } from "@/util/util";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { formatKeys, modifierLabel } from "../moltenterm-shell/shortcuts/format";
import { ShortcutsSheetKey } from "../moltenterm-shell/shortcuts/registry";
import { ShownFirstRunSteps } from "./onboarding-steps";

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
    onStart,
    onSkip,
}: {
    busy: boolean;
    onStart: () => void;
    onSkip: () => void;
}) {
    const t = useT();
    return (
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
            <div className="flex flex-col gap-3">
                <div className="h-8 w-10 [&>svg]:h-full [&>svg]:w-full">
                    <Logo />
                </div>
                <div className="flex flex-col gap-1">
                    <h1 className="text-20 leading-7 font-semibold text-primary">{t("onboarding.welcome.title")}</h1>
                    <p className="text-13 text-secondary">{t("onboarding.welcome.tagline")}</p>
                </div>
            </div>
            <ul className="flex flex-col gap-4">
                {Points.map((point) => (
                    <li key={point.icon} className="flex gap-3">
                        <i
                            className={cn("fa-solid fa-fw mt-[3px] text-icon-14 text-accent", `fa-${point.icon}`)}
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
                    className={cn("molten-btn rounded-6 px-4 py-2 text-13 font-semibold", busy && "opacity-60")}
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
            <footer className="flex flex-col gap-1 border-t border-border pt-4 text-12 text-muted">
                <p>{t("onboarding.welcome.license")}</p>
                <p className="flex gap-3">
                    <a href={MoltentermLicenseUrl} target="_blank" rel="noopener" className={linkClassName}>
                        {t("onboarding.welcome.licenceLink")}
                    </a>
                    <a href={MoltentermPrivacyUrl} target="_blank" rel="noopener" className={linkClassName}>
                        {t("onboarding.welcome.privacyLink")}
                    </a>
                </p>
            </footer>
        </div>
    );
}
