// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    canCreate,
    choiceAmong,
    geargrimOffered,
    hasProjectProposal,
    nameProblem,
    projectCardOf,
    ProjectNamePattern,
    ProjectRefusals,
    projectRequest,
    refusalKey,
} from "./brainstorm-project-model";

const GoProject = readFileSync(join(__dirname, "../../../pkg/molten/brainstorm/project.go"), "utf8");

const brief = {
    schema: "projectbrief",
    version: 1,
    id: "b1",
    source: "brokk",
    brainstorm: "id-kids",
    created: 1,
    name: "Safe Kids Videos",
    slug: "safe-kids-videos",
    pitch: "A video app where parents validate every video.",
    problem: "Children's apps play what nobody chose.",
    users: "Parents of children from 3 to 10.",
};

const proposal = { id: "make-it", kind: "proposal", text: "Make it a project", status: "proposed", action: "project" };

const state = (extra: Record<string, unknown> = {}) =>
    ({
        allowed: true,
        open: true,
        version: 1,
        swap: 1,
        brainstorm: {
            id: "id-kids",
            slug: "kids",
            title: "Kids",
            dir: "/synthetic/Brainstorms/kids",
            created: 1,
            updated: 2,
            turns: 4,
        },
        graph: {
            schema: 1,
            rev: 3,
            centre: "c",
            nodes: [{ id: "c", kind: "topic", text: "Kids", status: "open" }],
            links: [],
        },
        ...extra,
    }) as any;

// FR-BOSS-010 AC15 (#2250): what the project card is, from the state wavesrv shares.
describe("the project card (#2250)", () => {
    it("shows once he concluded, waits when he proposed first, and says done once the project is made", () => {
        expect(projectCardOf(state())).toEqual({ kind: "none" });
        expect(projectCardOf(null)).toEqual({ kind: "none" });
        const graph = { ...state().graph, nodes: [...state().graph.nodes, proposal] };
        expect(projectCardOf(state({ graph }))).toEqual({ kind: "waiting" });
        expect(projectCardOf(state({ brief }))).toEqual({ kind: "ready", brief });
        const promoted = state({
            brief,
            brainstorm: {
                ...state().brainstorm,
                state: "promoted",
                promotedto: { dir: "/synthetic/Projects/safe-kids-videos", at: 3 },
            },
        });
        expect(projectCardOf(promoted)).toMatchObject({
            kind: "done",
            promotion: { dir: "/synthetic/Projects/safe-kids-videos" },
        });
        // Outside the mode, nothing shows.
        expect(projectCardOf(state({ brief, open: false }))).toEqual({ kind: "none" });
    });

    it("counts only his project proposal, not one set aside or of another action", () => {
        expect(hasProjectProposal({ ...state().graph, nodes: [proposal] })).toBe(true);
        expect(hasProjectProposal({ ...state().graph, nodes: [{ ...proposal, status: "aside" }] })).toBe(false);
        expect(hasProjectProposal({ ...state().graph, nodes: [{ ...proposal, action: "handoff" }] })).toBe(false);
        expect(hasProjectProposal(null)).toBe(false);
    });

    // AC14, AC-5: Hand to Geargrim is absent while DiamondForge does not offer it.
    it("offers no Hand to Geargrim while DiamondForge does not", () => {
        expect(geargrimOffered(state({ brief }))).toBe(false);
        expect(GoProject).toMatch(/func GeargrimOffered\(\) bool \{\s*return false\s*\}/);
    });

    it("checks the folder name with wavesrv's rule", () => {
        expect(GoProject).toContain("`" + ProjectNamePattern.source + "`");
        for (const good of ["safe-kids-videos", "Forge.Notes_2", "a"]) {
            expect(nameProblem(good)).toBe("");
        }
        for (const bad of ["", "..", ".hidden", "../outside", "a/b", "forge.", "with space", "é-accent"]) {
            expect(nameProblem(bad)).toBe("badname");
        }
    });

    it("words each refusal in one sentence, and an unknown one as a failure", () => {
        for (const code of ProjectRefusals) {
            expect(GoProject.includes(`"${code}"`) || code === "failed").toBe(true);
            expect(refusalKey(code)).toBe(`boss.brainstorm.project.refused.${code}`);
        }
        expect(refusalKey("link")).toBe("boss.brainstorm.project.refused.link");
        expect(refusalKey("<script>")).toBe("boss.brainstorm.project.refused.failed");
    });

    it("keeps an existing workspace only while it is there", () => {
        const options = [{ id: "ws-1", name: "Atelier" }];
        expect(choiceAmong({ kind: "existing", id: "ws-1" }, options)).toEqual({ kind: "existing", id: "ws-1" });
        expect(choiceAmong({ kind: "existing", id: "gone" }, options)).toEqual({ kind: "new" });
        expect(choiceAmong(null, options)).toEqual({ kind: "new" });
    });

    it("lets wavesrv take boss:projectsdir and the brief's slug unless the developer changed them", () => {
        expect(projectRequest("", "", "safe-kids-videos")).toEqual({});
        expect(projectRequest("", "safe-kids-videos", "safe-kids-videos")).toEqual({});
        expect(projectRequest(" /synthetic/Projects ", "Kids", "safe-kids-videos")).toEqual({
            parent: "/synthetic/Projects",
            name: "Kids",
        });
    });

    // AC-2: the click goes only with a path, no refusal, a name that holds, and nothing running.
    it("lets the click go only on a clean preview", () => {
        const preview = { parent: "/p", name: "kids", path: "/p/kids", docs: "docs/brainstorm.md" };
        expect(canCreate(preview, "", false)).toBe(true);
        expect(canCreate(preview, "kids", true)).toBe(false);
        expect(canCreate({ ...preview, refusal: "notempty" }, "", false)).toBe(false);
        expect(canCreate({ ...preview, path: undefined }, "", false)).toBe(false);
        expect(canCreate(preview, "../x", false)).toBe(false);
        expect(canCreate(null, "", false)).toBe(false);
    });
});
