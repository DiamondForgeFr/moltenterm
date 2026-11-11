// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The page is drawn from rows: what reads the app's stores is not part of what is checked here.
vi.mock("../boss/use-boss-name", () => ({ useBossName: () => "Brokk" }));
vi.mock("../build/current-build", () => ({ currentChannel: () => "gold" }));
vi.mock("../build/features-narrowing", () => ({ useNarrowing: () => ({ public: false, off: [] }) }));
vi.mock("../build/features-in-test-store", () => ({ switchFeature: vi.fn(), switchPublicVersion: vi.fn() }));

import { FeatureBrainstorm, NoNarrowing } from "../build/gated-features";
import { featureRows } from "./features-in-test-model";
import { FeaturesInTestPage } from "./features-in-test-section";

// The attribute, not the Tailwind variants in the class.
const IsDisabled = /\sdisabled(=""|\s|>)/;

function page(channel: any, narrowing = NoNarrowing, handlers = { onSwitch: vi.fn(), onPublicVersion: vi.fn() }) {
    return renderToStaticMarkup(
        <FeaturesInTestPage
            rows={featureRows(channel, narrowing)}
            publicVersion={narrowing.public}
            bossName="Brokk"
            {...handlers}
        />
    );
}

// FR-BOSS-011 AC1, AC3, AC4: what the page says of each feature, as the build and the switches make it.
describe("the rows of Features in test", () => {
    it("lists the brainstorm on a gold: on, open, and switchable", () => {
        const [row] = featureRows("gold", NoNarrowing);
        expect(row).toMatchObject({ id: FeatureBrainstorm, state: "on", on: true, locked: false, ticket: 2246 });
        expect([...row.channels].sort()).toEqual(["dev", "gold", "local"]);
    });

    it("shows a feature switched off as off, and still switchable", () => {
        const [row] = featureRows("dev", { public: false, off: [FeatureBrainstorm] });
        expect(row).toMatchObject({ state: "off", on: false, locked: false });
    });

    it("holds every feature off, locked, in the public version, whatever each switch says", () => {
        for (const off of [[], [FeatureBrainstorm]]) {
            const [row] = featureRows("gold", { public: true, off });
            expect(row).toMatchObject({ state: "publicOff", on: false, locked: true });
        }
    });

    it("never shows a feature as on where its channel does not open it", () => {
        for (const channel of ["rc", "public", "unknown", null]) {
            const [row] = featureRows(channel as any, NoNarrowing);
            expect(row).toMatchObject({ state: "closedHere", on: false, locked: true });
        }
    });
});

describe("the page", () => {
    it("names the feature, says what it does, where it is open and its ticket, with the boss's name", () => {
        const html = page("gold");
        expect(html).toContain('data-testid="library-features"');
        expect(html).toContain("Brainstorm with Brokk");
        expect(html).toContain("Talk an idea through with Brokk");
        for (const channel of ["dev", "local build", "Gold"]) {
            expect(html).toContain(channel);
        }
        expect(html).toContain("Ticket #2246");
        expect(html).toContain("See the public version");
        expect(html).toContain("These switches only turn features off");
    });

    it("draws each switch as it is", () => {
        const on = page("gold");
        expect(on).toMatch(/data-testid="features-switch"[^>]*>/);
        expect(on).toContain('aria-checked="true"');
        expect(on).toContain("On");

        const off = page("gold", { public: false, off: [FeatureBrainstorm] });
        const row = /<li[^>]*data-feature="brainstorm"[\s\S]*?<\/li>/.exec(off)[0];
        expect(row).toContain('aria-checked="false"');
        expect(row).not.toMatch(IsDisabled);

        const publicVersion = page("gold", { public: true, off: [] });
        const locked = /<li[^>]*data-feature="brainstorm"[\s\S]*?<\/li>/.exec(publicVersion)[0];
        expect(locked).toMatch(IsDisabled);
        expect(locked).toContain("Off in the public version");
        expect(/data-testid="features-public"[\s\S]*?<\/section>/.exec(publicVersion)[0]).toContain(
            'aria-checked="true"'
        );
    });

    it("says a feature is not open on a build whose channel does not have it", () => {
        const html = page("public");
        expect(html).toContain("Not open on this build");
        expect(/<li[^>]*data-feature="brainstorm"[\s\S]*?<\/li>/.exec(html)[0]).toMatch(IsDisabled);
    });
});
