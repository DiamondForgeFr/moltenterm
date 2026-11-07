// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    BrokkExpression,
    BrokkSituation,
    callPending,
    handledAfter,
    handledKindOf,
    restingPose,
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

describe("his resting pose (FR-BOSS-007, AC2 and AC15, #1959)", () => {
    it("looks up when the card opens, even while agents work, and keeps to his work otherwise", () => {
        expect(restingPose(situation({ working: 2 }))).toBe("thinking");
        expect(restingPose(situation({ working: 2, cardOpen: true }))).toBe("listening");
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

describe("what the developer's answer tells him (FR-BOSS-007, AC14, #1959)", () => {
    it("takes a hand-off allowed, once or always, for an approval: a nod, the smile is kept for success", () => {
        expect(handledKindOf({ kind: "handoff", decision: "once" })).toBe("handoff");
        expect(handledKindOf({ kind: "handoff", decision: "always" })).toBe("handoff");
    });

    it("says nothing of a hand-off refused or dismissed", () => {
        expect(handledKindOf({ kind: "handoff", decision: "block" })).toBeNull();
        expect(handledKindOf({ kind: "handoff", decision: "dismiss" })).toBeNull();
    });

    it("takes an answer given to an agent, a CI rerun and a Done for the developer's own action", () => {
        expect(handledKindOf({ kind: "answer" })).toBe("answer");
        expect(handledKindOf({ kind: "rerun" })).toBe("rerun");
        expect(handledKindOf({ kind: "done" })).toBe("done");
    });

    it("says nothing of the buttons that only go somewhere or set aside", () => {
        for (const kind of ["later", "goto", "integration", "external", "open", "brief"]) {
            expect(handledKindOf({ kind })).toBeNull();
        }
    });
});

describe("what the bubble loads up front (the perf budget of the entry's JavaScript)", () => {
    // Every module the entry reaches adds to bundle.initialJsMB, which is gated to the byte almost (scripts/perf). The
    // animated portrait is the part that must load on the first opening, so the up-front files import none of it.
    const upFront = [
        "brokk-ask-model.ts",
        "brokk-queue.ts",
        "brokk-mood.ts",
        "brokk-scene.ts",
        "brokk-watch.ts",
        "brokk-expressions.ts",
        "use-brokk-live.ts",
        "boss-portrait.tsx",
        "brokk-visit.ts",
        "brokk-gate.ts",
        "brokk-visit-events.ts",
        "brokk-visit-share.ts",
        "brokk-visit-scene-model.ts",
        "brokk-hub.ts",
        "brokk-hub-feed.ts",
        "brokk-hub-feed-store.ts",
        "brokk-hub-store.ts",
        "brokk-hub-host.tsx",
        "brokk-avatar-model.ts",
        "brokk-avatar.tsx",
        "brokk-peek.tsx",
        "brokk-caption.ts",
        "use-brokk-hub.ts",
        "brokk-group-model.ts",
        "brokk-notes-model.ts",
        "brokk-rows-model.ts",
        "brokk-usage-model.ts",
    ];
    const later = [
        "./brokk-state-model",
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

    it("keep the avatar, its host and the card from loading the portrait or its rules, whatever the file", () => {
        for (const file of ["brokk-avatar.tsx", "brokk-hub-host.tsx", "brokk-group.tsx"]) {
            for (const specifier of loaded(file)) {
                expect(isLater(specifier), `${file} loads ${specifier}`).toBe(false);
            }
        }
    });

    it("leave the visit scene, which carries his clips, to the first visit", () => {
        const sidebar = readFileSync(join(__dirname, "..", "sidebar", "workspace-sidebar.tsx"), "utf8");
        expect(sidebar).toMatch(/lazy\(\(\) => import\("\.\.\/boss\/brokk-visit-scene"\)/);
        expect(sidebar).not.toMatch(/from "\.\.\/boss\/brokk-visit-scene"/);
        for (const file of upFront) {
            expect(loaded(file), file).not.toContain("./brokk-visit-scene");
        }
    });
});
