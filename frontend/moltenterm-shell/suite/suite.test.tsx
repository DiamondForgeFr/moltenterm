// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    BlockRows,
    DominoLoader,
    GlowRing,
    LoadingState,
    nextToggleIndex,
    OptionList,
    OptionRow,
    SectionBlock,
    SuiteSignature,
    ToggleGroup,
} from "./suite";
import { suiteIcon, SuiteIcons } from "./suite-icons";

const KitDir = __dirname;

function kitSources(): { file: string; text: string }[] {
    return readdirSync(KitDir)
        .filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\./.test(f))
        .map((f) => ({ file: f, text: readFileSync(join(KitDir, f), "utf8") }));
}

describe("DiamondForge suite kit (#658)", () => {
    it("stays extractable: no import but React, Lucide and its own files, no Tailwind class, no app variable", () => {
        for (const { file, text } of kitSources()) {
            const imports = [...text.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((m) => m[1]);
            for (const spec of imports) {
                expect([file, spec]).toEqual([
                    file,
                    expect.stringMatching(/^(react|lucide-react|\.\/[\w-]+(\.css)?)$/),
                ]);
            }
            if (file.endsWith(".tsx")) {
                for (const m of text.matchAll(/className="([^"]+)"/g)) {
                    for (const cls of m[1].split(/\s+/)) {
                        expect([file, cls]).toEqual([file, expect.stringMatching(/^df-/)]);
                    }
                }
            }
            expect([file, /var\(--mt-|--mt-[\w-]+:/.test(text)]).toEqual([file, false]);
        }
    });

    it("draws a block with its label chip as a heading on the top border, naming the section", () => {
        const html = renderToStaticMarkup(
            <SectionBlock title="Language" icon={suiteIcon("language")} description="One line." data-section="x">
                <BlockRows>
                    <div>row</div>
                </BlockRows>
            </SectionBlock>
        );
        const id = /<section aria-labelledby="([^"]+)"/.exec(html)?.[1];
        expect(id).toBeTruthy();
        expect(html).toContain(`<h3 id="${id}" class="df-chip-text">Language</h3>`);
        expect(html).toContain('class="df-icon-tile"');
        expect(html).toContain('<p class="df-block-desc">One line.</p>');
        expect(html).toContain('class="df-block-rows"');
        expect(html).toContain('data-section="x"');
        expect(html).toContain('class="df-glow"');
        expect(html).not.toContain("data-on");
    });

    it("lights the turning light only when asked, and tones a danger block", () => {
        expect(renderToStaticMarkup(<GlowRing on />)).toBe(
            '<span class="df-glow" data-on="" aria-hidden="true"></span>'
        );
        const html = renderToStaticMarkup(
            <SectionBlock title="Danger zone" tone="danger" glow>
                x
            </SectionBlock>
        );
        expect(html).toContain('data-tone="danger"');
        expect(html).toContain('data-on=""');
    });

    it("leaves out the pocket of an untitled block and keeps a name's case on request", () => {
        const untitled = renderToStaticMarkup(<SectionBlock aria-label="Rows">x</SectionBlock>);
        expect(untitled).toContain('data-untitled=""');
        expect(untitled).not.toContain("df-pocket");
        expect(renderToStaticMarkup(<SectionBlock title="my_token" titleCase="as-is" />)).toContain(
            'data-chip-case="as-is"'
        );
    });

    it("marks the selected option row with its label, as a real radio", () => {
        const html = renderToStaticMarkup(
            <OptionList aria-label="Tab bar">
                <OptionRow name="t" value="top" label="Top" selected selectedLabel="Selected" onSelect={() => {}} />
                <OptionRow
                    name="t"
                    value="left"
                    label="Left"
                    selected={false}
                    selectedLabel="Selected"
                    onSelect={() => {}}
                />
            </OptionList>
        );
        expect(html).toContain('role="radiogroup" aria-label="Tab bar"');
        expect(html.match(/type="radio"/g)).toHaveLength(2);
        expect(html.match(/class="df-option-selected">Selected</g)).toHaveLength(1);
        expect(html).toMatch(/data-selected="" data-option="top"/);
        expect(html).toContain('name="t" checked="" value="top"');
    });

    it("gives a toggle group one tab stop on the chosen option, and moves with the arrows", () => {
        const html = renderToStaticMarkup(
            <ToggleGroup
                label="Icon kind"
                options={[
                    { value: "symbol", label: "Symbol" },
                    { value: "image", label: "Image" },
                ]}
                selected="image"
                onSelect={() => {}}
            />
        );
        expect([...html.matchAll(/aria-checked="(true|false)" tabindex="(-?\d)"/g)].map((m) => [m[1], m[2]])).toEqual([
            ["false", "-1"],
            ["true", "0"],
        ]);
        expect(nextToggleIndex("ArrowRight", 1, 2)).toBe(0);
        expect(nextToggleIndex("ArrowLeft", 0, 3)).toBe(2);
        expect(nextToggleIndex("End", 0, 3)).toBe(2);
        expect(nextToggleIndex("a", 0, 3)).toBe(-1);
    });

    it("signs with the product, its version and the caller's label, or the label alone (#740)", () => {
        const full = renderToStaticMarkup(
            <SuiteSignature product="MoltenTerm" version="1.0.0" label="A DiamondForge product" className="x" />
        );
        expect(full).toBe(
            '<p class="df-signature x" data-suite-signature=""><span class="df-signature-product">MoltenTerm 1.0.0 ·</span> ' +
                '<span class="df-signature-label">A DiamondForge product</span></p>'
        );
        const bare = renderToStaticMarkup(<SuiteSignature label="Un produit DiamondForge" />);
        expect(bare).toBe(
            '<p class="df-signature" data-suite-signature=""><span class="df-signature-label">Un produit DiamondForge</span></p>'
        );
        expect(renderToStaticMarkup(<SuiteSignature product="MoltenTerm" label="L" />)).toContain(
            '<span class="df-signature-product">MoltenTerm ·</span> <span class="df-signature-label">L</span>'
        );
    });

    it("draws the falling dominoes inline or large, a status only when it names what works (#739)", () => {
        const bars = "<span></span>".repeat(8);
        expect(renderToStaticMarkup(<DominoLoader />)).toBe(
            `<span class="df-domino-loader" aria-hidden="true">${bars}</span>`
        );
        expect(renderToStaticMarkup(<DominoLoader size="large" label="Loading" className="x" />)).toBe(
            `<span class="df-dominos x" role="status" aria-label="Loading">${bars}</span>`
        );
    });

    it("draws the loading state: the large dominoes over a caption, one busy status (#1070)", () => {
        const html = renderToStaticMarkup(<LoadingState caption="Reading…" testId="t" />);
        expect(html).toBe(
            '<div class="df-loading-state" role="status" aria-live="polite" aria-busy="true" data-testid="t">' +
                `<span class="df-dominos" aria-hidden="true">${"<span></span>".repeat(8)}</span>` +
                '<p class="df-loading-caption">Reading…</p></div>'
        );
    });

    it("keeps Notulia's dominoes: geometry, 1 s cycle, delays, and still under reduced motion (#739)", () => {
        const css = readFileSync(join(KitDir, "suite.css"), "utf8");
        expect(css).toMatch(/\.df-dominos \{[^}]*width: 110px;\s*height: 44px;/);
        expect(css).toMatch(/\.df-dominos > span \{[^}]*height: 7px;\s*width: 25px;\s*background: var\(--df-accent\);/);
        expect(css).toMatch(/\.df-domino-loader \{[^}]*width: 32px;\s*height: 14px;/);
        expect(css).toMatch(/\.df-domino-loader > span \{[^}]*height: 2px;\s*width: 8px;\s*background: currentColor;/);
        const delays = ["0.915s", "0.79s", "0.665s", "0.54s", "0.425s", "0.3s", "0.125s"];
        for (const kind of ["dominos", "domino-loader"]) {
            expect(css).toMatch(new RegExp(`\\.df-${kind} > span \\{[^}]*animation: df-dominos 1s ease infinite;`));
            delays.forEach((delay, i) => {
                expect(css).toMatch(
                    new RegExp(`\\.df-${kind} > span:nth-child\\(${i + 2}\\) \\{[^}]*animation-delay: ${delay};`)
                );
            });
        }
        expect(css).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.df-dominos > span,\s*\.df-domino-loader > span \{\s*animation: none;/
        );
    });

    it("maps each concept to one Lucide icon, Notulia's where it has one", () => {
        expect(SuiteIcons.appearance.source).toBe("notulia");
        expect(SuiteIcons.language.source).toBe("notulia");
        expect(SuiteIcons.wizard.source).toBe("notulia");
        expect(SuiteIcons.terminal.source).toBe("proposed");
        const icons = Object.values(SuiteIcons).map((e) => e.icon);
        expect(icons.every((i) => i != null)).toBe(true);
    });
});
