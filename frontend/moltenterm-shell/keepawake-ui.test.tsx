// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", () => ({ useSettingsKeyAtom: () => "" }));
vi.mock("@/util/platformutil", () => ({ PLATFORM: "darwin" }));
vi.mock("./keepawake-store", () => ({ KeepAwakeModel: { getInstance: () => ({}) } }));

import { SleepPolicyControl } from "./keepawake-ui";

function control(policy: string, holding = "") {
    return renderToStaticMarkup(
        <SleepPolicyControl platform="darwin" policy={policy} holding={holding} onSelect={() => {}} />
    );
}

function segments(html: string) {
    return [...html.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]]);
}

describe("keep-awake popover (FR-SHELL-059-AC3)", () => {
    it("says one sentence, then the policies as a segmented control", () => {
        const html = control("untilworkends");
        expect(html.match(/<div class="text-12 text-primary">[^<]+<\/div>/g)).toEqual([
            '<div class="text-12 text-primary">Keep this Mac awake when a terminal asks</div>',
        ]);
        expect(html).toContain('role="radiogroup" aria-label="Keep this Mac awake when a terminal asks"');
        expect(html).toContain('data-role="segmented"');
        expect(html).not.toContain('type="radio"');
    });

    it("fills the current choice, and only it", () => {
        expect(segments(control("untilworkends"))).toEqual([
            ["Always", "false"],
            ["Until work ends", "true"],
            ["Never", "false"],
        ]);
        expect(segments(control("letsleep")).filter((s) => s[1] === "true")).toEqual([["Never", "true"]]);
        expect(segments(control("")).filter((s) => s[1] === "true")).toEqual([]);
    });

    it("keeps each policy's detail in its tooltip, and shows what the policy holds only while it holds", () => {
        const html = control("untilworkends");
        expect(html).toMatch(/title="MoltenTerm keeps the Mac awake while work runs[^"]*"[^>]*>Until work ends</);
        expect(html).not.toContain("Holding");
        expect(control("untilworkends", "Holding the Mac awake while work runs")).toContain(
            "Holding the Mac awake while work runs"
        );
    });
});
