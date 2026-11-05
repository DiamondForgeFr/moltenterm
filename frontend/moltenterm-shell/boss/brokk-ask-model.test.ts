// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    askedAfter,
    BrokkExpression,
    BrokkSituation,
    callPending,
    CallYieldMs,
    expressionAfterAnswer,
    handledAfter,
    rose,
    speaksOnOpen,
} from "./brokk-ask-model";

function situation(partial: Partial<BrokkSituation> = {}): BrokkSituation {
    return { working: 0, waiting: 0, cardOpen: false, ...partial };
}

describe("the call the round makes when the count rises (FR-BOSS-007, AC3)", () => {
    const call = { expression: "call" as BrokkExpression, cue: 3 };

    it("plays the call just asked, once the round can show it", () => {
        expect(callPending(call, 2, false)).toBe(true);
        expect(callPending(call, 3, false)).toBe(false);
        expect(callPending(null, 0, false)).toBe(false);
    });

    it("plays no other gesture at rest: the round makes the call and nothing else", () => {
        for (const expression of ["smile", "doubtful", "frown", "nod"] as BrokkExpression[]) {
            expect(callPending({ expression, cue: 9 }, 0, false)).toBe(false);
        }
    });

    it("does not play a call it could not show, later: it is spent when it is asked", () => {
        expect(callPending(call, 2, true)).toBe(false);
        expect(handledAfter(2, call, true)).toBe(3);
        expect(callPending(call, handledAfter(2, call, true), false)).toBe(false);
    });

    it("keeps the newest cue it has handled, and plays the next call asked", () => {
        expect(handledAfter(5, call, true)).toBe(5);
        expect(handledAfter(2, call, false)).toBe(2);
        expect(handledAfter(2, null, true)).toBe(2);
        expect(callPending({ expression: "call", cue: 6 }, 5, false)).toBe(true);
    });
});

describe("the gesture asked", () => {
    it("is the first one asked, with a cue of its own each time, the same gesture twice included", () => {
        const first = askedAfter(null, "smile", 1000);
        expect(first).toEqual({ expression: "smile", cue: 1, at: 1000 });
        expect(askedAfter(first, "smile", 2000)).toEqual({ expression: "smile", cue: 2, at: 2000 });
        expect(askedAfter(first, "nod", 2000)).toEqual({ expression: "nod", cue: 2, at: 2000 });
    });

    it("lets a gesture that tells why win over the call asked in the same moment, whichever comes first", () => {
        const frown = askedAfter(null, "frown", 1000);
        expect(askedAfter(frown, "call", 1000 + CallYieldMs - 1)).toBe(frown);
        const call = askedAfter(null, "call", 1000);
        expect(askedAfter(call, "frown", 1001)).toEqual({ expression: "frown", cue: 2, at: 1001 });
    });

    it("plays the call again once the moment has passed, and a call after a call", () => {
        const frown = askedAfter(null, "frown", 1000);
        expect(askedAfter(frown, "call", 1000 + CallYieldMs)).toEqual({
            expression: "call",
            cue: 2,
            at: 1000 + CallYieldMs,
        });
        const call = askedAfter(null, "call", 1000);
        expect(askedAfter(call, "call", 1001)).toEqual({ expression: "call", cue: 2, at: 1001 });
    });
});

describe("the count rising", () => {
    it("tells a rise since the last reading, and none at the first", () => {
        expect(rose(null, 3)).toBe(false);
        expect(rose(0, 1)).toBe(true);
        expect(rose(2, 2)).toBe(false);
        expect(rose(3, 1)).toBe(false);
    });
});

describe("speaking when the card opens", () => {
    it("speaks on opening the card when it opens on items to handle, not on an empty card", () => {
        expect(speaksOnOpen(situation({ cardOpen: true, waiting: 1 }))).toBe(true);
        expect(speaksOnOpen(situation({ cardOpen: true, working: 2 }))).toBe(false);
        expect(speaksOnOpen(situation({ cardOpen: true }))).toBe(false);
    });

    it("never reads an expression from what an agent writes: the situation holds three numbers and a flag", () => {
        expect(Object.keys(situation()).sort()).toEqual(["cardOpen", "waiting", "working"]);
    });
});

describe("what the developer's answer tells him", () => {
    it("smiles at a hand-off approved, once or always", () => {
        expect(expressionAfterAnswer({ kind: "handoff", decision: "once" })).toBe("smile");
        expect(expressionAfterAnswer({ kind: "handoff", decision: "always" })).toBe("smile");
    });

    it("says nothing of a hand-off refused or dismissed", () => {
        expect(expressionAfterAnswer({ kind: "handoff", decision: "block" })).toBeNull();
        expect(expressionAfterAnswer({ kind: "handoff", decision: "dismiss" })).toBeNull();
    });

    it("nods at an answer given to an agent", () => {
        expect(expressionAfterAnswer({ kind: "answer" })).toBe("nod");
    });

    it("says nothing of the other buttons", () => {
        for (const kind of ["rerun", "done", "later", "goto", "integration", "external", "open", "brief"]) {
            expect(expressionAfterAnswer({ kind })).toBeNull();
        }
    });
});

describe("what the bubble loads up front (the perf budget of the entry's JavaScript)", () => {
    // Every module the entry reaches adds to bundle.initialJsMB, which is gated to the byte almost (scripts/perf). The
    // animated portrait is the part that must load on the first opening, so the up-front files import none of it.
    const upFront = ["brokk-ask-model.ts", "brokk-expressions.ts", "use-brokk-live.ts", "boss-portrait.tsx"];
    const later = [
        "./brokk-state-model",
        "./brokk-expression-model",
        "./brokk-moments",
        "./brokk-portrait",
        "./brokk-live",
        "./portrait/brokk",
        "@diamondforge/character",
    ];
    const isLater = (specifier: string) => later.some((name) => specifier === name || specifier.startsWith(`${name}/`));

    // The modules a file loads when it does: every `from "..."` and `import "..."`, but the type-only imports, which the
    // build erases.
    function loaded(file: string): string[] {
        const source = readFileSync(join(__dirname, file), "utf8");
        const all = [...source.matchAll(/\bfrom "([^"]+)"/g), ...source.matchAll(/^import "([^"]+)"/gm)].map(
            (m) => m[1]
        );
        const erased = [...source.matchAll(/import type [^;]*?\bfrom "([^"]+)"/g)].map((m) => m[1]);
        for (const specifier of erased) {
            all.splice(all.indexOf(specifier), 1);
        }
        return all;
    }

    it("import neither the package, nor his manifest, nor the portrait's models, nor the portrait itself", () => {
        for (const file of upFront) {
            for (const specifier of loaded(file)) {
                // His still is the one asset the round shows at rest.
                if (file === "boss-portrait.tsx" && specifier.endsWith("brokk.jpg")) {
                    continue;
                }
                expect(isLater(specifier), `${file} loads ${specifier}`).toBe(false);
            }
        }
    });

    it("reach the portrait only through a dynamic import, on the first opening", () => {
        const source = readFileSync(join(__dirname, "boss-portrait.tsx"), "utf8");
        expect(source).toMatch(/lazy\(\(\) => import\("\.\/brokk-live"\)/);
    });

    it("keep the bubble and the card from loading the portrait or its rules, whatever the file", () => {
        for (const file of ["boss-bubble.tsx", "boss-card.tsx"]) {
            for (const specifier of loaded(file)) {
                expect(isLater(specifier), `${file} loads ${specifier}`).toBe(false);
            }
        }
    });
});
