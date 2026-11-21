// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { FlowGapYPx, FlowGutterPx, FlowNotchRisePx } from "./companion-flow-model";
import { CompanionInsetPx } from "./companion-layout";

// The companion's one horizontal inset (FR-SHELL-018, #2440, #2441): a token, --mt-companion-inset (tokens.css). In
// every block of the dashboard, its content, its notches and its rows start on it, and one 24 px gutter (the flow's) runs
// round and between the blocks. A browser lays this out; here the stylesheets are read and the token resolved, so a
// value written by hand somewhere else shows as a different number.

const ShellDir = resolve(__dirname, "..");
const Token = "--mt-companion-inset";

const read = (...parts: string[]) => readFileSync(join(ShellDir, ...parts), "utf8");

type Rule = { selector: string; decls: Map<string, string>; inAtRule: boolean };

function rulesOf(css: string): Rule[] {
    const rules: Rule[] = [];
    postcss.parse(css).walkRules((rule) => {
        const decls = new Map<string, string>();
        rule.each((node) => {
            if (node.type === "decl") {
                decls.set(node.prop, node.value);
            }
        });
        let inAtRule = false;
        for (let p = rule.parent; p != null && p.type !== "root"; p = p.parent) {
            // A cascade layer groups rules without conditioning them; a media or container query does.
            if (p.type === "atrule" && (p as postcss.AtRule).name !== "layer") {
                inAtRule = true;
            }
        }
        rules.push({ selector: rule.selector, decls, inAtRule });
    });
    return rules;
}

const oneLine = (selector: string) => selector.replace(/\s+/g, " ").trim();

const ruleFor = (rules: Rule[], selector: string): Rule => {
    const found = rules.find((r) => oneLine(r.selector) === selector);
    if (found == null) {
        throw new Error(`no rule "${selector}"`);
    }
    return found;
};

// A length in px, from a declaration's value: var() read from the scope (with its fallback), calc() with + - * / and
// parentheses.
function lengthOf(value: string, scope: Map<string, string>): number {
    let text = value;
    for (let i = 0; i < 50 && /var\(/.test(text); i++) {
        text = text.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/, (_, name: string, fallback?: string) => {
            const found = scope.get(name) ?? fallback;
            if (found == null) {
                throw new Error(`${name} is not defined`);
            }
            return `(${found})`;
        });
    }
    const tokens = text.match(/calc\(|\(|\)|[+*/]|-(?=\s)|-?\d+(?:\.\d+)?(?:px)?/g) ?? [];
    let at = 0;
    const factor = (): number => {
        const token = tokens[at++];
        if (token === "calc(" || token === "(") {
            const inner = sum();
            at++;
            return inner;
        }
        if (token === "-") {
            return -factor();
        }
        return parseFloat(token);
    };
    const product = (): number => {
        let n = factor();
        while (tokens[at] === "*" || tokens[at] === "/") {
            const op = tokens[at++];
            const m = factor();
            n = op === "*" ? n * m : n / m;
        }
        return n;
    };
    const sum = (): number => {
        let n = product();
        while (tokens[at] === "+" || tokens[at] === "-") {
            const op = tokens[at++];
            const m = product();
            n = op === "+" ? n + m : n - m;
        }
        return n;
    };
    return sum();
}

// The values a declaration gives to the left and the right of an element.
function horizontalValues(prop: string, value: string): string[] {
    if (/^(padding|margin)-(left|right|inline(-start|-end)?)$/.test(prop)) {
        return [value];
    }
    if (!/^(padding|margin)$/.test(prop)) {
        return [];
    }
    const parts = value.trim().split(/\s+(?![^(]*\))/);
    return parts.length === 4 ? [parts[1], parts[3]] : parts.length === 1 ? [parts[0]] : [parts[1]];
}

// A horizontal padding or margin written as 12 px, the inset's value, instead of the token.
function literalInsets(css: string): string[] {
    const found: string[] = [];
    postcss.parse(css).walkDecls((decl) => {
        if (horizontalValues(decl.prop, decl.value).some((v) => /^(12px|0?\.75rem)$/.test(v))) {
            found.push(`${decl.parent && (decl.parent as postcss.Rule).selector}: ${decl.prop}: ${decl.value}`);
        }
    });
    return found;
}

// A Tailwind class for a horizontal padding or margin of 12 px, in a class list that is not a control's or a card's
// (those have a radius): a section's own inset.
const LiteralClass = /(?<![\w:-])(?:px|pl|pr|ps|pe|mx|ml|mr|ms|me|p|m)-3(?![\w.-])/;

function literalClasses(source: string): string[] {
    const found: string[] = [];
    for (const [text] of source.matchAll(/"[^"\n]*"/g)) {
        if (LiteralClass.test(text) && !/\brounded-/.test(text)) {
            found.push(text);
        }
    }
    return found;
}

const SourceDir = join(ShellDir, "companion");
const Sources = readdirSync(SourceDir).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
const Styles = readdirSync(SourceDir).filter((f) => /\.css$/.test(f));
// Read while the file is collected: collection has no timeout, a loaded machine stretches a scan 10 times (#2274).
const SourceText = new Map(Sources.map((f) => [f, readFileSync(join(SourceDir, f), "utf8")]));
const StyleText = new Map(Styles.map((f) => [f, readFileSync(join(SourceDir, f), "utf8")]));
const ShellStyles = (readdirSync(ShellDir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, readFileSync(join(ShellDir, f), "utf8")] as const);

const tokens = rulesOf(read("tokens.css"));
const suite = rulesOf(read("suite", "suite.css"));
const work = rulesOf(StyleText.get("companion-work.css"));
const dash = rulesOf(StyleText.get("companion-dashboard.css"));

const rootScope = new Map<string, string>();
for (const rule of [...tokens.filter((r) => r.selector === ":root" && !r.inAtRule), ruleFor(suite, ":where(:root)")]) {
    rule.decls.forEach((v, k) => k.startsWith("--") && rootScope.set(k, v));
}
// Inside the dashboard: its own spacing and the suite slots the milestone's rows read.
const dashScope = new Map(rootScope);
ruleFor(dash, ".mt-cdash").decls.forEach((v, k) => k.startsWith("--") && dashScope.set(k, v));

const horizontal = (rules: Rule[], selector: string, scope = dashScope): number[] => {
    const rule = ruleFor(rules, selector);
    return [...rule.decls.entries()].flatMap(([prop, value]) =>
        horizontalValues(prop, value).map((v) => lengthOf(v, scope))
    );
};

describe("the companion's one inset (#2440, #2441)", () => {
    it("is one token, worth CompanionInsetPx, that no band, width or section redefines", () => {
        expect(lengthOf(`var(${Token})`, rootScope)).toBe(CompanionInsetPx);
        const defined = ShellStyles.flatMap(([file, css]) => rulesOf(css).map((r) => ({ file, r }))).filter(({ r }) =>
            r.decls.has(Token)
        );
        expect(defined.map(({ file, r }) => `${file}: ${oneLine(r.selector)}`)).toEqual(["tokens.css: :root"]);
        expect(defined[0].r.inAtRule).toBe(false);
        const inline = [...SourceText.entries()].filter(([, text]) => new RegExp(`["']${Token}["']\\s*:`).test(text));
        expect(inline.map(([file]) => file)).toEqual([]);
    });

    it("pads every block's content and starts its notches on the inset", () => {
        expect(horizontal(dash, ".mt-cb")).toEqual([CompanionInsetPx]);
        const head = ruleFor(dash, ".mt-cb-head");
        expect(lengthOf(head.decls.get("left"), dashScope)).toBe(CompanionInsetPx);
        expect(lengthOf(head.decls.get("right"), dashScope)).toBe(CompanionInsetPx);
        expect(lengthOf("var(--df-block-pad)", dashScope)).toBe(CompanionInsetPx);
    });

    it("starts the rows of every block on the same inset: heads, tickets, sub-agents, topics, files, 'and N more'", () => {
        for (const [rules, selector] of [
            [work, ".mt-cwork-sec"],
            [work, ".mt-cwork-row"],
            [work, ".mt-cwork-sub-row"],
            [dash, ".mt-cdash-topic"],
            [dash, ".mt-cdash-frow"],
            [dash, ".mt-cb-more"],
            [dash, ".mt-cb-foot"],
            [dash, ".mt-cdash-hero-usage"],
        ] as const) {
            expect(horizontal(rules, selector), selector).toContain(CompanionInsetPx);
        }
    });

    it("keeps one 24 px gutter, the flow's: the companion's edges, between columns, and above each block's label", () => {
        expect(lengthOf("var(--mt-cdash-gutter)", dashScope)).toBe(FlowGutterPx);
        expect(lengthOf("var(--mt-cdash-gap-y)", dashScope)).toBe(FlowGapYPx);
        expect(lengthOf("var(--mt-cdash-notch)", dashScope) / 2).toBe(FlowNotchRisePx);
        expect(FlowGapYPx - FlowNotchRisePx).toBe(FlowGutterPx);
        for (const selector of [".mt-cdash-hero", ".mt-cdash-flow", ".mt-cdash-arrbar"]) {
            const margin = ruleFor(dash, selector).decls.get("margin").split(/\s+/);
            expect(
                margin.map((v) => lengthOf(v, dashScope)),
                selector
            ).toEqual([FlowGapYPx, FlowGutterPx, 0]);
        }
    });

    it("runs the usage attached to the main agent to the block's edges, under a hairline, on the inset (#2450)", () => {
        const row = ruleFor(dash, ".mt-cdash-hero-usage");
        const margin = row.decls.get("margin").split(/\s+(?![^(]*\))/);
        // Out to the block's own edges, as the foot of a block runs, and closing it.
        expect(lengthOf(margin[1], dashScope)).toBe(-CompanionInsetPx);
        expect(lengthOf(margin[2], dashScope)).toBe(-CompanionInsetPx);
        expect(horizontal(dash, ".mt-cdash-hero-usage")).toContain(CompanionInsetPx);
        expect(row.decls.get("border-top")).toBe(ruleFor(dash, ".mt-cb-foot").decls.get("border-top"));
    });

    // The scroller of the companion is a column (companion-view.tsx): a child with a min-height that is a percentage
    // shrinks to the scroller's height unless it says it does not, and its blocks, which the flow places, then overflow
    // it, taking its bottom space with them (#2450). A browser lays this out; here the stylesheet is read.
    it("leaves under the last block the gutter the sides have, held by the dashboard and never by a block", () => {
        const sides = ruleFor(dash, ".mt-cdash-flow")
            .decls.get("margin")
            .split(/\s+(?![^(]*\))/)
            .map((v) => lengthOf(v, dashScope));
        expect(sides[1]).toBe(FlowGutterPx);
        const root = ruleFor(dash, ".mt-cdash");
        expect(lengthOf(root.decls.get("padding-bottom"), dashScope)).toBe(sides[1]);
        expect(root.decls.get("flex-shrink")).toBe("0");
        expect(root.decls.get("min-height")).toBe("100%");
        // Not a margin of the flow, which could collapse in the scroller, and not a space on a block, which the last
        // block, whichever it is and in whichever column, would have to carry.
        for (const selector of [".mt-cdash-flow", ".mt-cdash-flow > .mt-cb", ".mt-cb"]) {
            const decls = ruleFor(dash, selector).decls;
            expect(
                [...decls.keys()].filter((prop) => /^(margin|padding)-bottom$/.test(prop)),
                selector
            ).toEqual([]);
        }
        expect(sides[2]).toBe(0);
        // The scroller adds no space of its own, which would double it.
        const scroller = /className="([^"]*)"\s+data-testid="companion-scroll"/.exec(
            SourceText.get("companion-view.tsx")
        );
        expect(scroller?.[1]).toBeDefined();
        expect(scroller[1].split(/\s+/).filter((c) => /^(p|pb|py)-/.test(c))).toEqual([]);
    });

    it("keeps one 6 px gap in a notch: between its chips, from its chips to the U, and the U's spread", () => {
        const notch = ruleFor(dash, ".mt-cb-notch");
        const gap = lengthOf("var(--mt-cdash-notch-gap)", dashScope);
        expect(gap).toBe(6);
        expect(lengthOf(notch.decls.get("gap"), dashScope)).toBe(gap);
        expect(horizontal(dash, ".mt-cb-notch")).toEqual([gap]);
        expect(ruleFor(dash, ".mt-cb-notch::before").decls.get("inset")).toBe("var(--mt-cdash-notch-gap)");
    });

    it("leaves no section or style with an inset of its own", () => {
        const literals = [...StyleText.entries()].flatMap(([file, css]) =>
            literalInsets(css).map((found) => `${file}: ${found}`)
        );
        const classes = [...SourceText.entries()].flatMap(([file, text]) =>
            literalClasses(text).map((found) => `${file}: ${found}`)
        );
        expect([...literals, ...classes]).toEqual([]);
    });

    it("sees a literal inset in a stylesheet or a class list, and not a control's padding", () => {
        expect(literalInsets(".a { padding: 0 12px; }\n.b { margin: 4px 12px 6px 2px; }")).toHaveLength(2);
        expect(literalInsets(".a { padding: 12px var(--mt-companion-inset); gap: 12px; width: 12px; }")).toEqual([]);
        expect(literalClasses('<div className="flex px-3 pt-3">')).toHaveLength(1);
        expect(literalClasses('<div className="m-3 mb-0 border">')).toHaveLength(1);
        expect(literalClasses('<button className="molten-btn rounded-6 px-3 py-1">')).toEqual([]);
        expect(literalClasses('<div className="px-(--mt-companion-inset) pt-3 gap-3">')).toEqual([]);
    });
});
