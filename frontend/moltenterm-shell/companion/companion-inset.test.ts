// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { BlockInsetPx, CompanionInsetPx, TileHangPx } from "./companion-layout";

// The companion's one horizontal inset (FR-SHELL-018, #2440): a token, --mt-companion-inset (tokens.css). From the
// companion's edge, the section titles, a block's icon tile and the padding of a block's content all start on it, in one
// column or two, at every width. A browser lays this out; here the stylesheets are read and the token resolved, so a
// value written by hand somewhere else shows as a different number.

const ShellDir = resolve(__dirname, "..");
const Token = "--mt-companion-inset";
// What the suite's block draws round its content (suite.css, ".df-block { border: 1px solid transparent }").
const BlockBorderPx = 1;

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

const rootScope = new Map<string, string>();
for (const rule of [...tokens.filter((r) => r.selector === ":root" && !r.inAtRule), ruleFor(suite, ":where(:root)")]) {
    rule.decls.forEach((v, k) => k.startsWith("--") && rootScope.set(k, v));
}
const blockScope = new Map(rootScope);
ruleFor(work, ".mt-cwork").decls.forEach((v, k) => k.startsWith("--") && blockScope.set(k, v));
const tileRule = work.find((r) => r.selector.includes(":has(> .df-icon-tile)"));
const tileScope = new Map(blockScope);
tileRule?.decls.forEach((v, k) => k.startsWith("--") && tileScope.set(k, v));
const plainRule = ruleFor(work, ".mt-cwork > .df-block, .mt-cwork-col > .df-block");

describe("the companion's one inset (#2440)", () => {
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

    it("starts the section titles, the tile and the block's content on the same left inset", () => {
        const title = SourceText.get("companion-section.tsx").match(
            /export function SectionTitle[\s\S]*?className="([^"]+)"/
        )?.[1];
        const titleVar = title?.match(/(?<![\w:-])px-\((--[\w-]+)\)/)?.[1];
        expect(titleVar, "SectionTitle's padding").toBeDefined();
        const sectionTitle = lengthOf(`var(${titleVar})`, rootScope);

        const blockContent = lengthOf("var(--df-block-pad)", blockScope);
        const rowTitle = lengthOf(ruleFor(work, ".mt-cwork-sec").decls.get("padding").split(" ")[1], blockScope);

        // From the companion's edge: the block's left margin, its border, then the tile's offset into the corner.
        const tileLeft =
            lengthOf(tileRule.decls.get("margin-inline-start"), tileScope) +
            BlockBorderPx +
            lengthOf("var(--df-tile-offset)", tileScope);

        expect({ sectionTitle, blockContent, rowTitle, tileLeft }).toEqual({
            sectionTitle: CompanionInsetPx,
            blockContent: CompanionInsetPx,
            rowTitle: CompanionInsetPx,
            tileLeft: CompanionInsetPx,
        });
    });

    it("keeps the inset on the block's right and the tabs one inset after the tile", () => {
        expect(lengthOf(plainRule.decls.get("margin-inline"), blockScope)).toBe(CompanionInsetPx);
        const tileRight = lengthOf("var(--df-tile-size)", tileScope) + lengthOf("var(--df-tile-offset)", tileScope);
        expect(lengthOf("var(--df-pocket-left)", tileScope)).toBe(tileRight + CompanionInsetPx);
        expect(lengthOf("var(--df-pocket-left)", blockScope)).toBe(CompanionInsetPx);
    });

    it("gives the Tasks block's width the same margins, in code and in CSS", () => {
        expect(TileHangPx).toBe(-lengthOf("var(--df-tile-offset)", tileScope) - BlockBorderPx);
        const left = lengthOf(tileRule.decls.get("margin-inline-start"), tileScope);
        const right = lengthOf(plainRule.decls.get("margin-inline"), tileScope);
        expect(BlockInsetPx).toBe(left + right);
    });

    it("lays the tile out from the block's inside edge, one border in", () => {
        expect(ruleFor(suite, ".df-icon-tile").decls.get("left")).toBe("var(--df-tile-offset)");
        expect(ruleFor(suite, ".df-block").decls.get("border")).toBe("1px solid transparent");
    });

    it("lets no band or width change the insets of the work area", () => {
        const insetProps = (r: Rule) =>
            [...r.decls.keys()].filter(
                (k) => k === "--df-block-pad" || k === "--df-pocket-left" || /^margin-inline/.test(k)
            );
        const conditional = work.filter((r) => r.inAtRule || /data-(layout|both)/.test(r.selector));
        expect(conditional.flatMap(insetProps)).toEqual([]);
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

    it("reads the inset in every section of the session view", () => {
        const using = [...SourceText.entries()].filter(([, text]) => text.includes(`(${Token})`)).map(([file]) => file);
        expect(using).toEqual(
            expect.arrayContaining([
                "companion-files.tsx",
                "companion-gauges.tsx",
                "companion-recap.tsx",
                "companion-section.tsx",
                "companion-task.tsx",
                "companion-view.tsx",
            ])
        );
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
