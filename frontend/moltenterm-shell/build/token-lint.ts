// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The design tokens' lint (FR-SHELL-044 AC1, DS-SHELL-077, TC-SHELL-093): MoltenTerm-owned CSS, TSX and TS write font
// sizes, weights, radii, icon sizes and transition durations only through the tokens of tokens.css, and no hex colour
// outside the token definitions on :root (FR-SHELL-119). Each finding
// names the file, the line and the literal. token-lint.test.ts runs it over frontend/moltenterm-shell and
// frontend/moltenterm-onboarding.

export type TokenFinding = { file: string; line: number; literal: string; rule: string };

export const OwnedFrontendDirs = ["moltenterm-shell", "moltenterm-onboarding"];

const Weights = new Set(["400", "500", "600"]);
const Durations = new Set(["120", "180", "240"]);
// The two radii (FR-SHELL-118): rounded-4 is --mt-radius-control, rounded-6 --mt-radius-panel.
const Radii = new Set(["4", "6"]);
// A hex colour (FR-SHELL-119): #rgb, #rgba, #rrggbb or #rrggbbaa, not part of a longer word.
const HexRe = /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
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
        rule: "radius off the scale",
        re: new RegExp(`${Variants}rounded(?:-(?:${TwRadiusSides}))?-(\\d+)${End}`, "g"),
        bad: (m) => !Radii.has(m[1]),
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

// Files whose hex values are data, not the interface's look (FR-SHELL-119): the colours a developer can give a
// workspace, the colour arithmetic that picks black or white text over one, and the ANSI palette of the CI log pane,
// which renders a program's own colours. Each one is listed with its reason; nothing else may hold a hex.
export const ColourDataFiles: Record<string, string> = {
    "moltenterm-shell/workspace-colour.ts": "the workspace colour palette a developer picks from",
    "moltenterm-shell/accent.ts": "the default workspace colour and the black or white text computed over a workspace colour",
    "moltenterm-shell/window-texture.ts": "the black or white ink a texture tile is drawn with",
    "moltenterm-shell/mission/ci-model.ts": "the ANSI palette of a CI log's own colour codes",
    "moltenterm-onboarding/onboarding-project-model.ts": "the workspace colours offered at onboarding",
};

// In a string, a hex is a colour when it has a letter or six or eight digits, or sits in a Tailwind arbitrary value
// (text-[#333]): "#1107" or "[#490]" is a ticket number.
function isHexColour(hex: string, before: string): boolean {
    return /[a-fA-F]/.test(hex) || hex.length === 7 || hex.length === 9 || /-\[$/.test(before);
}

function tsHexFindings(file: string, src: string): TokenFinding[] {
    if (ColourDataFiles[file.split("\\").join("/")] != null) {
        return [];
    }
    const findings: TokenFinding[] = [];
    const literals = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
    for (let m = literals.exec(src); m != null; m = literals.exec(src)) {
        const text = m[1] ?? m[2] ?? m[3];
        const start = m.index + 1;
        HexRe.lastIndex = 0;
        for (let h = HexRe.exec(text); h != null; h = HexRe.exec(text)) {
            if (!isHexColour(h[0], text.slice(Math.max(0, h.index - 2), h.index))) {
                continue;
            }
            findings.push({ file, line: lineOf(src, start + h.index), literal: h[0], rule: "hard-coded colour (use a token)" });
        }
    }
    return findings;
}

export function lintTs(file: string, source: string): TokenFinding[] {
    const src = stripTsComments(source);
    const findings: TokenFinding[] = tsHexFindings(file, src);
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

// The DiamondForge suite kit (suite/suite.css, #658) reads its own --df-* slots, which tokens.css maps onto the
// --mt-* scale: a kit size, weight or duration is a token too.
function badFontSize(value: string): boolean {
    return !/^(?:var\(--mt-(?:text|icon)-\d+\)|var\(--df-text-[a-z-]+\)|inherit|initial|unset|100%|1em)(?:\s*!important)?$/.test(
        value
    );
}

function badWeight(value: string): boolean {
    const v = value.replace(/\s*!important$/, "");
    return !(Weights.has(v) || /^(?:normal|inherit|var\(--(?:mt|df)-weight-[a-z]+\))$/.test(v));
}

const TokenDurationVar = /^var\(--(?:mt|df)-duration-/;

// A radius reads the two tokens, the suite kit's slots (which tokens.css maps onto the control radius) or the panel
// radius Wave's blocks read; any other variable could hold a third value.
const RadiusVar = /^var\(--(?:mt-radius-(?:control|panel)|radius-[46]|df-radius-(?:sm|md|lg)|mt-panel-radius|block-border-radius|modal-border-radius)\b/;

function badRadius(value: string): string {
    const v = value.replace(/\s*!important$/, "");
    for (const part of splitTop(v, /[\s/]/)) {
        if (RadiusVar.test(part) || part === "0" || /%$/.test(part) || /^(?:inherit|initial|unset)$/.test(part)) {
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
        const duration = splitTop(item, /\s/).find((tok) => TimeRe.test(tok) || TokenDurationVar.test(tok));
        if (duration == null || TokenDurationVar.test(duration) || /^0m?s$/.test(duration)) {
            continue;
        }
        bad.push(duration);
    }
    return bad;
}

// The token definitions: custom properties declared on the root, where tokens.css, moltenterm-shell.css and the
// suite kit define them. A custom property on any other selector is a colour hard-coded under a local name.
const TokenRootSelector = /^(?::root\b|:where\(:root\))/;

// A mask reads only the alpha of its gradient, so #fff or #000 there is coverage, not a colour.
const MaskProps = /^(?:-webkit-)?mask(?:-image)?$/;

// The selector of the rule each declaration sits in, by the declaration's index.
function ruleSelectors(src: string): { start: number; end: number; selector: string }[] {
    const rules: { start: number; end: number; selector: string }[] = [];
    const re = /([^{};]*)\{([^{}]*)\}/g;
    for (let m = re.exec(src); m != null; m = re.exec(src)) {
        const open = m.index + m[1].length;
        rules.push({ start: open, end: m.index + m[0].length, selector: m[1].trim() });
    }
    return rules;
}

function hexFindings(file: string, src: string): TokenFinding[] {
    const findings: TokenFinding[] = [];
    const rules = ruleSelectors(src);
    for (const d of cssDeclarations(src)) {
        if (d.prop.startsWith("--")) {
            const rule = rules.find((r) => d.index > r.start && d.index < r.end);
            if (rule != null && TokenRootSelector.test(rule.selector)) {
                continue;
            }
        }
        if (MaskProps.test(d.prop)) {
            continue;
        }
        HexRe.lastIndex = 0;
        for (let m = HexRe.exec(d.value); m != null; m = HexRe.exec(d.value)) {
            findings.push({
                file,
                line: lineOf(src, d.index),
                literal: `${d.prop}: ${m[0]}`,
                rule: "hard-coded colour (use a token)",
            });
        }
    }
    return findings;
}

export function lintCss(file: string, source: string): TokenFinding[] {
    const src = stripCssComments(source);
    const findings: TokenFinding[] = hexFindings(file, src);
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
