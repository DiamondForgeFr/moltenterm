// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RailEditButton, RailEditHint, railEditLabel } from "./workspace-rail-edit";

function render(settings: Record<string, unknown> = {}, reducedMotion = false): string {
    const env = {
        getSettingsKeyAtom: (key: string) => atom(settings[key]),
        atoms: { prefersReducedMotionAtom: atom(reducedMotion) },
    };
    return renderToStaticMarkup(
        <WaveEnvContext.Provider value={env as any}>
            <RailEditButton name="Client A" onEdit={() => {}} onHover={() => {}} onLeave={() => {}} />
        </WaveEnvContext.Provider>
    );
}

describe("rail pencil (FR-SHELL-030-AC1)", () => {
    const html = render();

    it("is a real button named after the workspace", () => {
        expect(html).toMatch(/^<button type="button"/);
        expect(html).toContain(`aria-label="Edit Client A, hold to confirm"`);
        expect(html).toContain('data-role="rail-edit"');
        expect(html).not.toContain("tabindex");
    });

    it("shows on hover and on keyboard focus of the item, hidden otherwise", () => {
        expect(html).toContain("opacity-0");
        expect(html).toContain("group-hover:opacity-100");
        expect(html).toContain("group-focus-within:opacity-100");
        expect(html).toContain("focus-visible:opacity-100");
        expect(html).toContain("motion-reduce:transition-none");
    });

    it("has a 24 px target and a pointer cursor", () => {
        expect(html).toContain("h-6 w-6");
        expect(html).toContain("cursor-pointer");
        expect(html).not.toContain("cursor-help");
    });
});

describe("hold to edit (#354, FR-SHELL-030-AC11 to AC16)", () => {
    it("names the hold and the hint", () => {
        expect(railEditLabel("Client A")).toBe("Edit Client A, hold to confirm");
        expect(RailEditHint).toBe("Hold to edit");
    });

    it("draws the shared ring and tint around the 16 px pencil badge, with an inset edge", () => {
        const html = render();
        expect(html).toContain('data-testid="hold-ring"');
        expect(html).toContain('data-testid="hold-tint"');
        expect(html).toMatch(/class="molten-hold-disc[^"]*h-4 w-4[^"]*ring-1[^"]*ring-inset/);
        expect(html).not.toMatch(/class="molten-hold-disc[^"]*\sborder[\s"]/);
        expect(html).toContain("fa-pencil");
        expect(html).toContain("molten-hold-glyph");
    });

    it("never starts a drag of the rail item", () => {
        expect(render()).toContain('draggable="false"');
    });

    it("follows reduced motion like the tab close button", () => {
        expect(render()).not.toContain("data-reduced-motion");
        expect(render({}, true)).toContain('data-reduced-motion=""');
    });

    it("opens on a single click again when the hold setting is off", () => {
        const html = render({ "tab:holdtoclose": false });
        expect(html).toContain('aria-label="Edit Client A"');
        expect(html).not.toContain("hold-ring");
        expect(html).toContain("fa-pencil");
    });
});
