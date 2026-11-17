// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    briefProblem,
    BriefSchema,
    BriefSlugPattern,
    BriefVersion,
    MaxBriefItems,
    MaxBriefName,
    MaxBriefProblem,
    MaxBriefStack,
    MaxBriefStep,
    MaxBriefUsers,
} from "./brainstorm-brief-model";

const GoBrief = readFileSync(join(__dirname, "../../../pkg/molten/brainstorm/brief.go"), "utf8");

// A synthetic brief, as Brokk writes one.
const brief = () => ({
    name: "Forge Notes",
    slug: "forge-notes",
    pitch: "A notebook that keeps a workshop's decisions.",
    problem: "Decisions made at the bench are lost by the next morning.",
    users: "A small team of makers sharing one workshop.",
    scope: { in: ["Notes per bench", "Search"], out: ["Billing"] },
    stack: ["Go", "SQLite"],
    profile: "harness",
    profilereason: "It is a Go tool, not a web SaaS.",
    firststep: "Write the note model and its tests.",
    openquestions: ["Sync between two computers?"],
    language: "en",
});

// FR-BOSS-010 AC14, DS-BOSS-009 (#2250): the window checks the brief with wavesrv's rules before it sends his block.
describe("the project brief, ProjectBrief v1 (#2250)", () => {
    it("holds the contract's names and limits, as wavesrv does", () => {
        const goConst = (name: string) => new RegExp(`\\b${name}\\s*=\\s*([^\\n]+)`).exec(GoBrief)?.[1]?.trim();
        expect(goConst("BriefSchema")).toBe(`"${BriefSchema}"`);
        expect(goConst("BriefVersion")).toBe(String(BriefVersion));
        expect(goConst("MaxBriefName")).toBe(String(MaxBriefName));
        expect(goConst("MaxBriefProblem")).toBe(String(MaxBriefProblem));
        expect(goConst("MaxBriefUsers")).toBe(String(MaxBriefUsers));
        expect(goConst("MaxBriefStep")).toBe(String(MaxBriefStep));
        expect(goConst("MaxBriefItems")).toBe(String(MaxBriefItems));
        expect(goConst("MaxBriefStack")).toBe(String(MaxBriefStack));
        expect(GoBrief).toContain("`" + BriefSlugPattern.source + "`");
    });

    it("accepts a whole brief, and one with its lists and optional fields left out", () => {
        expect(briefProblem(brief())).toBe("");
        const { name, slug, pitch, problem, users } = brief();
        expect(briefProblem({ name, slug, pitch, problem, users })).toBe("");
        // A language that is not a tag is not a reason to drop it: wavesrv writes the brainstorm's instead.
        expect(briefProblem({ ...brief(), language: "French" })).toBe("");
    });

    it("names the field that breaks the contract, never its text", () => {
        const secret = "my secret plan";
        const cases: [Record<string, unknown>, string][] = [
            [{ name: "  " }, "name: empty"],
            [{ name: "n".repeat(81) + secret }, "name: over 80 characters"],
            [{ slug: "../" + secret }, "slug: invalid"],
            [{ slug: "Forge-Notes" }, "slug: invalid"],
            [{ pitch: 3 }, "pitch: not a text"],
            [{ problem: "p".repeat(601) }, "problem: over 600 characters"],
            [{ users: "" }, "users: empty"],
            [{ scope: { in: new Array(13).fill("x") } }, "scope.in: 13 items, over 12"],
            [{ scope: { out: [""] } }, "scope.out item 1: empty"],
            [{ scope: "everything" }, "scope: not an object"],
            [{ stack: ["s".repeat(81)] }, "stack item 1: over 80 characters"],
            [{ stack: "Go" }, "stack: not a list"],
            [{ profile: secret }, "profile: unknown"],
            [{ firststep: "f".repeat(301) }, "firststep: over 300 characters"],
            [{ openquestions: ["ok", " "] }, "openquestions item 2: empty"],
        ];
        for (const [change, want] of cases) {
            const problem = briefProblem({ ...brief(), ...change });
            expect(problem).toBe(want);
            expect(problem).not.toContain(secret);
        }
        expect(briefProblem(null)).toBe("not an object");
        expect(briefProblem(["x"])).toBe("not an object");
    });
});
