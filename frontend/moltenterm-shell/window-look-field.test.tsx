// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./window-look", () => ({
    WindowLookModel: { getInstance: () => ({}) },
    useShownLook: () => null,
}));

import { ShownLook } from "./window-look";
import { lookNote, OpacityControl } from "./window-look-field";

const Supported = { translucent: true, blur: true };

function shown(change: Partial<ShownLook>): ShownLook {
    return {
        wanted: { opacity: 0.8, blur: false },
        source: "workspace",
        scope: "workspace",
        drawn: { opacity: 0.8, blur: false },
        reason: null,
        support: Supported,
        ...change,
    };
}

function render(s: ShownLook, hasProject = true) {
    return renderToStaticMarkup(
        <OpacityControl shown={s} hasProject={hasProject} onLook={() => {}} onCommit={() => {}} onScope={() => {}} />
    );
}

describe("the Opacity field (FR-SHELL-091, TC-SHELL-209)", () => {
    it("is a labelled slider from the readable minimum to 100 %, with Blur and where it applies", () => {
        const html = render(shown({}));
        expect(html).toMatch(
            /<label for="([^"]+)"[^>]*>Opacity<\/label><input id="\1" type="range" min="70" max="100" step="5"/
        );
        expect(html).toContain('value="80"');
        expect(html).toContain('aria-valuetext="80 percent"');
        expect(html).toMatch(
            /role="switch" aria-checked="false"[^>]*class="[^"]*cursor-pointer[^"]*"[^>]*>.*Blur what is behind/
        );
        expect(html).toContain('aria-label="Apply to"');
        expect(html).toMatch(/aria-checked="true"[^>]*>This workspace</);
        expect(html).toContain("panels stay opaque");
    });

    it("goes down to 50 % with blur", () => {
        expect(render(shown({ wanted: { opacity: 0.5, blur: true } }))).toContain('min="50"');
    });

    it("offers the project only when one is linked", () => {
        expect(render(shown({}), false)).not.toContain("Apply to");
    });

    it("says why the window stays opaque, without naming the system (TC-SHELL-212)", () => {
        const reduced = render(shown({ reason: "reducedTransparency", drawn: { opacity: 1, blur: false } }));
        expect(reduced).toContain("Stays opaque: this computer is set to reduce transparency.");
        const unsupported = render(shown({ reason: "unsupported", support: { translucent: false, blur: false } }));
        expect(unsupported).toContain("See-through windows are not available on this computer");
        expect(unsupported).toMatch(/type="range"[^>]*disabled=""/);
        const noBlur = render(
            shown({ wanted: { opacity: 0.8, blur: true }, support: { translucent: true, blur: false } })
        );
        expect(noBlur).toContain("Blur is not available on this computer.");
    });

    it("says where a shared value comes from", () => {
        expect(lookNote(shown({ source: "project", scope: "project" }))).toBe("workspace.look.fromProject");
        expect(lookNote(shown({ source: "global" }))).toBe("workspace.look.fromSettings");
        expect(lookNote(shown({}))).toBeNull();
    });
});
