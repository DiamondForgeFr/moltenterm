// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/app/element/button";
import { readFileSync } from "fs";
import { forwardRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { accentForeground, contrastRatio, mixColor, MoltentermDefaultAccent, parseColor } from "./accent";
import { moltenButtonClasses } from "./molten-button";

// Read from disk: vitest stubs stylesheet imports, ?raw included.
const buttonCss = readFileSync(new URL("./molten-button.css", import.meta.url), "utf8");
const shellCss = readFileSync(new URL("./moltenterm-shell.css", import.meta.url), "utf8");

// The same colours as moltenterm-shell.test.ts: Moltenterm's workspace palette, Wave's flag colours and a dark blue
// (the one accent that takes white text).
const WorkspaceColours = [
    MoltentermDefaultAccent,
    "#00FFDB",
    "#429DFF",
    "#BF55EC",
    "#FF453A",
    "#58C142",
    "#FFE900",
    "#FF9500",
    "#1E3A8A",
];

type Recipe = { pct: number; base: string };

function readHighlights(): Record<string, Recipe> {
    const recipes: Record<string, Recipe> = {};
    const re = /(--molten-hi-\d):\s*color-mix\(in srgb, var\(--molten-base\) (\d+)%, (rgb\([^)]*\))\);/g;
    for (const m of buttonCss.matchAll(re)) {
        recipes[m[1]] = { pct: Number(m[2]), base: m[3] };
    }
    return recipes;
}

function cssValue(css: string, selector: string, prop: string): string {
    const block = new RegExp(`\\n${selector.replace(/[.-]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
    const decl = new RegExp(`${prop}:\\s*([^;]+);`).exec(block?.[1] ?? "");
    return decl?.[1].trim();
}

const Highlights = readHighlights();

// Every colour a molten button's text sits on: the rest colour and each wave highlight.
function surfaces(base: string) {
    const rgb = parseColor(base);
    return [
        { name: "rest", rgb },
        ...Object.entries(Highlights).map(([name, r]) => ({ name, rgb: mixColor(rgb, parseColor(r.base), r.pct) })),
    ];
}

describe("molten button contrast (NFR-SHELL-003)", () => {
    it("reads both wave highlights from molten-button.css", () => {
        expect(Object.keys(Highlights).sort()).toEqual(["--molten-hi-1", "--molten-hi-2"]);
    });

    describe.each(WorkspaceColours)("primary on workspace colour %s", (accent) => {
        const fg = parseColor(accentForeground(parseColor(accent)));
        it.each(surfaces(accent).map((s) => [s.name, s.rgb]))("keeps the text at 4.5:1 over %s", (_name, rgb) => {
            expect(contrastRatio(rgb, fg)).toBeGreaterThanOrEqual(4.5);
        });
    });

    describe.each([
        [".molten-btn-destructive", "--mt-state-error"],
        [".molten-btn-warning", "--mt-state-waiting"],
    ])("%s", (selector, token) => {
        const base = new RegExp(`${token}:\\s*(rgb\\([^)]*\\));`).exec(shellCss)?.[1];
        const fg = cssValue(buttonCss, selector, "--molten-fg");

        it("declares the readable text colour of its semantic colour", () => {
            expect(fg).toBe(accentForeground(parseColor(base)));
        });

        it.each(surfaces(base).map((s) => [s.name, s.rgb]))("keeps the text at 4.5:1 over %s", (_name, rgb) => {
            expect(contrastRatio(rgb, parseColor(fg))).toBeGreaterThanOrEqual(4.5);
        });
    });

    it("never uses Wave's green button colours", () => {
        expect(buttonCss).not.toMatch(/button-green/);
    });
});

describe("moltenButtonClasses", () => {
    it.each([
        ["", "primary", "molten-btn solid", true],
        ["font-[600]", "primary", "molten-btn solid font-[600]", true],
        ["green", "primary", "molten-btn solid", true],
        ["solid green bold", "primary", "molten-btn solid bold", true],
        ["red", "destructive", "molten-btn molten-btn-destructive solid", true],
        ["yellow rounded-[4px]", "warning", "molten-btn molten-btn-warning solid rounded-[4px]", true],
        ["grey", "secondary", "molten-btn-secondary grey solid", false],
        [
            "workspace-switcher-button grey",
            "secondary",
            "molten-btn-secondary grey solid workspace-switcher-button",
            false,
        ],
        ["outlined green font-[600]", "outline", "molten-btn-outline molten-tone-accent outlined font-[600]", false],
        ["outlined grey", "outline", "molten-btn-outline grey outlined", false],
        ["py-[4px] red outlined", "outline", "molten-btn-outline red py-[4px] outlined", false],
        ["ghost emoji-button", "ghost", "molten-btn-ghost molten-tone-accent ghost emoji-button", false],
        ["ghost grey close", "ghost", "molten-btn-ghost grey ghost close", false],
        ["ghost red text-[12px] bold", "ghost", "molten-btn-ghost red ghost text-[12px] bold", false],
    ])("maps %j to %s", (className, variant, classes, wave) => {
        const style = moltenButtonClasses(className);
        expect(style).toEqual({ variant, className: classes, wave });
    });

    it("matches whole class names: an icon's fa-solid is not a category", () => {
        expect(moltenButtonClasses("outlined grey fa-xmark fa-solid").variant).toBe("outline");
        expect(moltenButtonClasses("fa-xmark fa-solid").variant).toBe("primary");
    });

    it("never renders Wave's green class", () => {
        for (const className of ["", "green", "outlined green", "ghost green", "solid green"]) {
            expect(moltenButtonClasses(className).className.split(" ")).not.toContain("green");
        }
    });
});

describe("Button", () => {
    it("renders a molten primary with its wave layer after the content, without wrapping it", () => {
        const html = renderToStaticMarkup(
            <Button>
                <i className="fa fa-solid fa-check" />
                Continue
            </Button>
        );
        expect(html).toBe(
            '<button tabindex="0" class="wave-button molten-btn solid"><i class="fa fa-solid fa-check"></i>Continue' +
                '<i class="molten-btn-wave" aria-hidden="true"></i></button>'
        );
    });

    it("gives a destructive button the same wave", () => {
        const html = renderToStaticMarkup(<Button className="red">Remove</Button>);
        expect(html).toContain('class="wave-button molten-btn molten-btn-destructive solid"');
        expect(html).toContain("molten-btn-wave");
    });

    it("keeps calm variants and icon-only buttons free of the wave", () => {
        expect(renderToStaticMarkup(<Button className="ghost grey close" />)).toBe(
            '<button tabindex="0" class="wave-button molten-btn-ghost grey ghost close"></button>'
        );
        expect(renderToStaticMarkup(<Button className="outlined grey fa-xmark fa-solid" />)).not.toContain(
            "molten-btn-wave"
        );
    });

    it("passes a component's children through untouched", () => {
        const Slot = forwardRef<HTMLSpanElement, { className?: string; children?: React.ReactNode }>(
            ({ className, children }, ref) => (
                <span ref={ref} className={className} data-count={Array.isArray(children) ? children.length : 1}>
                    {children}
                </span>
            )
        );
        Slot.displayName = "Slot";
        const html = renderToStaticMarkup(<Button as={Slot}>Open</Button>);
        expect(html).toBe('<span class="wave-button molten-btn solid" data-count="1">Open</span>');
    });

    it("renders a molten div when asked for one", () => {
        expect(renderToStaticMarkup(<Button as="div">Go</Button>)).toContain("molten-btn-wave");
    });
});
