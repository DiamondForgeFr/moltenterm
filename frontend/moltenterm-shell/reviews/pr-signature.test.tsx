// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrSignature, signatureLine } from "./pr-signature";

const valentin = { firstname: "Valentin", agent: "Claude Code", model: "Opus 5.5", effort: "medium" };
const jerome = { firstname: "Jérôme", agent: "Codex", model: "gpt-5.5-codex", effort: "high" };

describe("PrSignature (#847)", () => {
    it("writes a signature with the parts it knows", () => {
        expect(signatureLine(valentin)).toBe("Valentin · Claude Code · Opus 5.5 · medium");
        expect(signatureLine({ firstname: "Camille", agent: "Codex" })).toBe("Camille · Codex");
        expect(signatureLine(null)).toBe("");
    });

    it("shows the last agent, every agent on hover and how many others", () => {
        const html = renderToStaticMarkup(<PrSignature agents={[valentin, jerome]} testId="sig" />);
        expect(html).toContain(">Valentin · Claude Code · Opus 5.5 · medium<");
        expect(html).toContain("Valentin · Claude Code · Opus 5.5 · medium\nJérôme · Codex · gpt-5.5-codex · high");
        expect(html).toContain("+1 agent");
        expect(html).not.toContain('data-unknown="true"');
    });

    it("names the reviewer of a merged PR", () => {
        const html = renderToStaticMarkup(
            <PrSignature agents={[valentin]} reviewed={{ name: "Anthony", date: "2026-10-16" }} testId="sig" />
        );
        expect(html).toContain('data-testid="sig-reviewed"');
        expect(html).toContain("reviewed by Anthony");
        expect(renderToStaticMarkup(<PrSignature agents={[valentin]} testId="sig" />)).not.toContain("sig-reviewed");
    });

    it("says unknown agent when nothing signed the PR, and guesses nothing", () => {
        for (const agents of [undefined, []]) {
            const html = renderToStaticMarkup(<PrSignature agents={agents} testId="sig" />);
            expect(html).toContain('data-unknown="true"');
            expect(html).toContain(">unknown agent<");
        }
    });
});
