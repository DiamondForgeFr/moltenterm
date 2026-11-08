// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import {
    ActiveScope,
    Material,
    materialLargeVisual,
    materialProjectName,
    materialsInScope,
    MaterialsNoProject,
    MaterialsProject,
    materialVisual,
    otherProjects,
    projectDisplayName,
    validScope,
} from "./materials-model";

function lookup(dict: any, key: string): unknown {
    return key.split(".").reduce((node, part) => node?.[part], dict);
}

function mat(id: string, project: string, over: Partial<Material> = {}): Material {
    return { id, project, title: id, kind: "page", source: "published", created: 1, updated: 1, ...over };
}

const Sasu: MaterialsProject = { key: "sasu", folder: "/work/SASU", name: "SASU" };
const Term: MaterialsProject = { key: "term", folder: "/work/SASU/APPS/MoltenTerm", name: "MoltenTerm" };
const Forge: MaterialsProject = { key: "forge", folder: "/work/SASU/APPS/DiamondForge/diamondforge" };
const None: MaterialsProject = { key: MaterialsNoProject };
const Projects = [Sasu, Term, Forge, None];

const Pool = [
    mat("a", "sasu"),
    mat("b", "term"),
    mat("c", "term"),
    mat("d", "forge"),
    mat("e", MaterialsNoProject),
    mat("f", "sasu", { source: "named" }),
];

describe("which project's materials (#1816)", () => {
    it("lists the workspace's project by default, and only its own", () => {
        expect(materialsInScope(Pool, ActiveScope, "sasu").map((m) => m.id)).toEqual(["a", "f"]);
        expect(materialsInScope(Pool, ActiveScope, "term").map((m) => m.id)).toEqual(["b", "c"]);
    });

    it("lists one other project, every project, or the materials of none", () => {
        expect(materialsInScope(Pool, { kind: "project", key: "term" }, "sasu").map((m) => m.id)).toEqual(["b", "c"]);
        expect(materialsInScope(Pool, { kind: "all" }, "sasu")).toHaveLength(6);
        expect(materialsInScope(Pool, { kind: "none" }, "sasu").map((m) => m.id)).toEqual(["e"]);
        expect(materialsInScope(undefined, { kind: "all" }, "sasu")).toEqual([]);
    });

    it("never gives a material of another project to the workspace's", () => {
        const recovered = mat("r", "term", { source: "named", agent: undefined, workspaceid: undefined });
        expect(materialsInScope([recovered], ActiveScope, "sasu")).toEqual([]);
    });

    it("offers the other projects that hold materials, by name", () => {
        const others = otherProjects(Projects, Pool, "sasu");
        expect(others.map((p) => [p.key, p.name, p.count])).toEqual([
            ["forge", "diamondforge", 1],
            ["term", "MoltenTerm", 2],
        ]);
        expect(otherProjects(Projects, Pool, "term").map((p) => p.key)).toEqual(["forge", "sasu"]);
        expect(otherProjects(Projects, [], "sasu")).toEqual([]);
    });

    it("falls back to the workspace's project when the chosen one is gone", () => {
        const others = otherProjects(Projects, Pool, "sasu");
        expect(validScope({ kind: "project", key: "term" }, others, "sasu")).toEqual({ kind: "project", key: "term" });
        expect(validScope({ kind: "project", key: "nope" }, others, "sasu")).toEqual(ActiveScope);
        expect(validScope({ kind: "project", key: "sasu" }, others, "sasu")).toEqual(ActiveScope);
        expect(validScope({ kind: "all" }, others, "sasu")).toEqual({ kind: "all" });
    });

    it("offers project counts without downloading their materials", () => {
        const summaries = Projects.map((p) => ({ ...p, count: p.key === "term" ? 250 : 0 }));
        expect(otherProjects(summaries, undefined, "sasu")).toEqual([
            { key: "term", name: "MoltenTerm", folder: Term.folder, count: 250 },
        ]);
        expect(
            validScope({ kind: "project", key: "term" }, otherProjects(summaries, undefined, "sasu"), "sasu")
        ).toEqual({ kind: "project", key: "term" });
    });

    it("names a project by its name, else by its folder, and No project by none", () => {
        expect(projectDisplayName(Term)).toBe("MoltenTerm");
        expect(projectDisplayName(Forge)).toBe("diamondforge");
        expect(projectDisplayName(None)).toBe("");
        expect(materialProjectName(mat("x", "term"), "sasu", "SASU", Projects)).toBe("MoltenTerm");
        expect(materialProjectName(mat("x", "sasu"), "sasu", "Workspace name", Projects)).toBe("Workspace name");
        expect(materialProjectName(mat("x", MaterialsNoProject), "sasu", "SASU", Projects)).toBe("");
        expect(materialProjectName(mat("x", "unknown"), "sasu", "SASU", Projects)).toBe("");
    });

    it("has every scope string in both languages with the same placeholders", () => {
        const keys = [
            "scope.label",
            "scope.other",
            "scope.all",
            "scope.none",
            "scope.pick",
            "scope.noOther",
            "scopeEmptyTitle",
            "scopeEmpty",
            "projectChip",
            "detail.label",
            "detail.close",
        ];
        for (const key of keys) {
            const e = lookup(en, `library.materials.${key}`) as string;
            const f = lookup(fr, `library.materials.${key}`) as string;
            expect(typeof e, key).toBe("string");
            expect(typeof f, key).toBe("string");
            expect(f.match(/\{\w+\}/g) ?? [], key).toEqual(e.match(/\{\w+\}/g) ?? []);
        }
    });
});

describe("real previews (#1816)", () => {
    it("shows an image's own pixels, from the smallest file that has them", () => {
        const kept = { copy: "kept", copypath: "/d/v1/a.png", versions: [{ n: 1, at: 1, size: 3 }] };
        expect(materialVisual(mat("i", "p", { kind: "image", thumbpath: "/d/t.png", ...kept }))).toEqual({
            path: "/d/t.png",
        });
        expect(materialVisual(mat("i", "p", { kind: "image", ...kept }))).toEqual({ path: "/d/v1/a.png" });
        expect(materialVisual(mat("i", "p", { kind: "image", original: "/tmp/shot.png" }))).toEqual({
            path: "/tmp/shot.png",
        });
        expect(materialVisual(mat("i", "p", { kind: "image", original: "/tmp/shot.png", originalgone: true }))).toEqual(
            {}
        );
    });

    it("opens the selected image at full size, and a page at the capture its card shows", () => {
        const kept = { copy: "kept", copypath: "/d/v1/a.png", versions: [{ n: 1, at: 1, size: 3 }] };
        expect(materialLargeVisual(mat("i", "p", { kind: "image", thumbpath: "/d/t.png", ...kept }))).toEqual({
            path: "/d/v1/a.png",
        });
        expect(
            materialLargeVisual(mat("i", "p", { kind: "image", thumbpath: "/d/t.png", original: "/tmp/s.png" }))
        ).toEqual({
            path: "/tmp/s.png",
        });
        expect(materialLargeVisual(mat("i", "p", { kind: "image", thumbpath: "/d/t.png" }))).toEqual({
            path: "/d/t.png",
        });
        const page = mat("g", "p", {
            link: "https://claude.ai/x",
            thumb: true,
            thumbpanel: true,
            thumbpath: "/d/g.png",
            thumbat: 9,
        });
        expect(materialLargeVisual(page)).toEqual({ path: "/d/g.png", version: 9 });
        expect(materialVisual(page)).toEqual({ path: "/d/g.png", version: 9 });
    });

    it("keeps the icon for a page or a link with no capture, and ignores a preview that is not a capture", () => {
        expect(materialVisual(mat("g", "p", { link: "https://claude.ai/x" }))).toEqual({});
        expect(
            materialLargeVisual(mat("g", "p", { link: "https://claude.ai/x", thumb: true, thumbpath: "/d/g.png" }))
        ).toEqual({});
    });
});
