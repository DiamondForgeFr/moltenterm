// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The design tokens' lint (FR-SHELL-044 AC1, DS-SHELL-077, TC-SHELL-093): MoltenTerm-owned CSS, TSX and TS write font
// sizes, weights, radii, icon sizes and transition durations only through the tokens of tokens.css. Each finding
// names the file, the line and the literal. token-lint.test.ts runs it over frontend/moltenterm-shell and
// frontend/moltenterm-onboarding.

export type TokenFinding = { file: string; line: number; literal: string; rule: string };

export const OwnedFrontendDirs = ["moltenterm-shell", "moltenterm-onboarding"];

const Weights = new Set(["400", "500", "600"]);
const Durations = new Set(["120", "180", "240"]);
const TwSizeNames = "xxs|xs|sm|base|lg|xl|[2-9]xl|title|default";
const TwRadiusSides = "t|b|l|r|tl|tr|bl|br|s|e|ss|se|es|ee";
const TwRadiusNames = "xs|sm|md|lg|xl|[2-4]xl";
// A Tailwind utility with any variants (hover:, md:, group-hover/x:) and an optional ! on either side.
const Variants = String.raw`(?<![\w\-\[/])(?:[\w\-\[\]/&>=*:.]+:)?!?`;
const End = String.raw`!?(?![\w\-\[/])`;

type TsRule = { rule: string; re: RegExp; bad?: (m: RegExpExecArray) => boolean };

const TsRules: TsRule[] = [
    { rule: "font size off the type scale", re: new RegExp(`${Variants}text-\\[\\d*\\.?\\d+(?:px|rem|em)\\]${End}`, "g") },
    { rule: "font size off the type scale", re: new RegExp(`${Variants}text-(?:${TwSizeNames})${End}`, "g") },
    { rule: "font weight off the scale", re: new RegExp(`${Variants}font-(?:thin|extralight|light|bold|extrabold|black)${End}`, "g") },
    {
        rule: "font weight off the scale",
        re: new RegExp(`${Variants}font-\\[(\\d+)\\]${End}`, "g"),
        bad: (m) => !Weights.has(m[1]),
    },
    {
        rule: "radius off the scale",
        re: new RegExp(`${Variants}rounded(?:-(?:${TwRadiusSides}))?(?:-(?:${TwRadiusNames}|\\[[^\\]]*\\]))?${End}`, "g"),
    },
    {
        rule: "transition duration off the scale",
        re: new RegExp(`${Variants}duration-(\\d+|\\[[^\\]]*\\])${End}`, "g"),
        bad: (m) => !Durations.has(m[1]),
    },
    { rule: "easing other than ease-mt", re: new RegExp(`${Variants}ease-(?:in|out|in-out|linear)${End}`, "g") },
    {
        rule: "inline font size or radius",
        re: /\b(?:fontSize|borderRadius)\s*:\s*(?:\d|["'`][^"'`]*\d(?:px|rem|em))/g,
    },
    {
        rule: "font weight off the scale",
        re: /\bfontWeight\s*:\s*["'`]?(\d+|bold|bolder|lighter)/g,
        bad: (m) => !Weights.has(m[1]),
    },
];

function lineOf(src: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index; i++) {
        if (src.charCodeAt(i) === 10) {
            line++;
        }
    }
    return line;
}

// Comments are blanked (newlines kept, so line numbers hold): a comment may name a utility it explains.
export function stripTsComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
        .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (c, pre: string) => pre + " ".repeat(c.length - pre.length));
}

export function stripCssComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

const TransitionUtility = /(?<![\w\-[])(?:[\w\-[\]/&>=*:.]+:)?transition(?:-(?!none\b)[\w[\],-]+)?(?![\w\-[])/;
const TokenDuration = /(?<![\w\-[])(?:[\w\-[\]/&>=*:.]+:)?duration-(?:120|180|240)(?![\w\-[])/;

export function lintTs(file: string, source: string): TokenFinding[] {
    const src = stripTsComments(source);
    const findings: TokenFinding[] = [];
    for (const { rule, re, bad } of TsRules) {
        re.lastIndex = 0;
        for (let m = re.exec(src); m != null; m = re.exec(src)) {
            if (bad != null && !bad(m)) {
                continue;
            }
            findings.push({ file, line: lineOf(src, m.index), literal: m[0], rule });
        }
    }
    // A Tailwind transition takes a token duration in the same class string: its default is 150 ms.
    const literals = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
    for (let m = literals.exec(src); m != null; m = literals.exec(src)) {
        const text = m[1] ?? m[2] ?? m[3];
        const t = TransitionUtility.exec(text);
        if (t != null && /\s/.test(text.trim()) && !TokenDuration.test(text)) {
            findings.push({ file, line: lineOf(src, m.index), literal: t[0], rule: "transition without a token duration" });
        }
    }
    return findings;
}

type Decl = { prop: string; value: string; index: number };

function cssDeclarations(src: string): Decl[] {
    const decls: Decl[] = [];
    const re = /([{;]\s*)([-\w]+)\s*:\s*([^;{}]+)(?=[;}])/g;
    for (let m = re.exec(src); m != null; m = re.exec(src)) {
        decls.push({ prop: m[2].toLowerCase(), value: m[3].trim(), index: m.index + m[1].length });
    }
    return decls;
}

// Splits on a separator outside parentheses.
function splitTop(value: string, sep: RegExp): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of value) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (depth === 0 && sep.test(ch)) {
            parts.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter((p) => p !== "");
}

const TimeRe = /^-?\d*\.?\d+m?s$/;

function badFontSize(value: string): boolean {
    return !/^(?:var\(--mt-(?:text|icon)-\d+\)|inherit|initial|unset|100%|1em)(?:\s*!important)?$/.test(value);
}

function badWeight(value: string): boolean {
    const v = value.replace(/\s*!important$/, "");
    return !(Weights.has(v) || /^(?:normal|inherit|var\(--mt-weight-[a-z]+\))$/.test(v));
}

function badRadius(value: string): string {
    const v = value.replace(/\s*!important$/, "");
    if (/^calc\(/.test(v) && /var\(--/.test(v)) {
        return null;
    }
    for (const part of splitTop(v, /[\s/]/)) {
        if (/^var\(--/.test(part) || part === "0" || /%$/.test(part) || /^(?:inherit|initial|unset)$/.test(part)) {
            continue;
        }
        const px = /^(\d*\.?\d+)px$/.exec(part);
        if (px != null && parseFloat(px[1]) >= 999) {
            continue;
        }
        return part;
    }
    return null;
}

// The duration of each transition: the first time of each comma-separated item (the second is its delay).
function badDurations(value: string): string[] {
    const bad: string[] = [];
    for (const item of splitTop(value, /,/)) {
        if (/^(?:none|inherit|initial|unset)(?:\s*!important)?$/.test(item)) {
            continue;
        }
        const duration = splitTop(item, /\s/).find((tok) => TimeRe.test(tok) || /^var\(--mt-duration-/.test(tok));
        if (duration == null || /^var\(--mt-duration-/.test(duration) || /^0m?s$/.test(duration)) {
            continue;
        }
        bad.push(duration);
    }
    return bad;
}

export function lintCss(file: string, source: string): TokenFinding[] {
    const src = stripCssComments(source);
    const findings: TokenFinding[] = [];
    const add = (d: Decl, literal: string, rule: string) =>
        findings.push({ file, line: lineOf(src, d.index), literal: `${d.prop}: ${literal}`, rule });
    for (const d of cssDeclarations(src)) {
        if (d.prop.startsWith("--")) {
            continue;
        }
        if (d.prop === "font-size" && badFontSize(d.value)) {
            add(d, d.value, "font size off the type scale");
        } else if (d.prop === "font" && /\d(?:px|rem|em)\b/.test(d.value)) {
            add(d, d.value, "font size off the type scale");
        } else if (d.prop === "font-weight" && badWeight(d.value)) {
            add(d, d.value, "font weight off the scale");
        } else if (/(?:^|-)radius$/.test(d.prop)) {
            const bad = badRadius(d.value);
            if (bad != null) {
                add(d, bad, "radius off the scale");
            }
        } else if (d.prop === "transition" || d.prop === "transition-duration") {
            for (const bad of badDurations(d.value)) {
                add(d, bad, "transition duration off the scale");
            }
        }
    }
    return findings;
}

export function lintFile(file: string, source: string): TokenFinding[] {
    if (/\.css$/.test(file)) {
        return lintCss(file, source);
    }
    if (/\.tsx?$/.test(file)) {
        return lintTs(file, source);
    }
    return [];
}

export function formatFinding(f: TokenFinding): string {
    return `${f.file}:${f.line}: ${f.literal} (${f.rule})`;
}
