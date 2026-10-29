// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The full-frame welcome (FR-SHELL-110 AC-1): the >_ glyph with the turning light, one molten call to action, and the
// credit to Wave Terminal in About rather than on the welcome.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../moltenterm-shell/i18n/locales/en.json";
import fr from "../moltenterm-shell/i18n/locales/fr.json";
import { OnboardingWelcome } from "./onboarding-welcome";

const noop = () => {};

describe("OnboardingWelcome", () => {
    const html = renderToStaticMarkup(<OnboardingWelcome busy={false} onStart={noop} onSkip={noop} />);

    it("fills the frame and lights the turning light round the glyph", () => {
        expect(html).toContain('class="molten-welcome"');
        expect(html).toMatch(/class="molten-welcome-glyph"[^>]*><span class="df-glow" data-on=""/);
        expect(html).toMatch(/<linearGradient id="mt-welcome-[\w-]+"/);
        expect(html).toMatch(/stroke="url\(#mt-welcome-[\w-]+\)"/);
    });

    it("has one molten call to action, with its wave", () => {
        expect(html.match(/class="molten-btn /g)).toHaveLength(1);
        expect(html.match(/molten-btn-wave/g)).toHaveLength(1);
        expect(html).toMatch(/class="molten-btn [^"]*"[^>]*data-testid="first-run-start"/);
    });

    it("opens About from its footer, and leaves the credit to it", () => {
        expect(html).toContain('data-testid="first-run-about"');
        for (const dict of [en, fr] as any[]) {
            expect(dict.onboarding.welcome.license).not.toMatch(/Wave/);
            expect(dict.onboarding.welcome.aboutLink).toBeTruthy();
            expect(dict.about.basedOn).toMatch(/Wave Terminal/);
        }
    });

    it("keeps orange for the action: the points' icons are muted", () => {
        expect(html).not.toMatch(/fa-terminal[^"]*text-accent/);
        expect(html).toMatch(/fa-fw[^"]*text-muted[^"]*fa-terminal|text-muted fa-terminal/);
    });

    it("shows a failure under the actions", () => {
        const failed = renderToStaticMarkup(
            <OnboardingWelcome busy={false} error="Could not start" onStart={noop} onSkip={noop} />
        );
        expect(failed).toMatch(/role="alert"[^>]*>Could not start/);
    });
});
