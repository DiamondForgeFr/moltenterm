// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The collapsed rail's mark (FR-SHELL-079, #2384): what it shows, what its hover names and what its click opens.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CollapsedRailPx, headerProjectType, markAction, markFace, markProjectName } from "./collapsed-mark-model";

const ws = (meta: Record<string, unknown>) => ({ oid: "w1", meta }) as unknown as Workspace;

const Two = {
    "molten:projects": [
        { id: "p1", type: "Desktop", dir: "/x/Acme" },
        { id: "p2", type: "", dir: "/x/Acme-website" },
    ],
    "molten:currentproject": "p1",
    "molten:project": "/x/Acme",
    "molten:projecttype": "Desktop",
};

describe("the mark's face", () => {
    it("is the header's logo or the workspace's icon when the header shows one", () => {
        expect(markFace({ kind: "logo", logo: "/x/Acme/logo.svg" }, "Acme")).toEqual({
            kind: "logo",
            logo: "/x/Acme/logo.svg",
        });
        expect(markFace({ kind: "workspace" }, "Acme")).toEqual({ kind: "workspace" });
    });

    it("is the first letter of the workspace's name, capitalised, when the header shows no icon", () => {
        expect(markFace({ kind: "none" }, "acme")).toEqual({ kind: "initial", letter: "A" });
        expect(markFace({ kind: "none" }, "  éclair")).toEqual({ kind: "initial", letter: "É" });
    });

    it("takes a whole character, never half of a pair", () => {
        expect(markFace({ kind: "none" }, "😀 party")).toEqual({ kind: "initial", letter: "😀" });
    });

    it("falls back on the workspace's icon when the name has no letter to give", () => {
        expect(markFace({ kind: "none" }, "   ")).toEqual({ kind: "workspace" });
        expect(markFace({ kind: "none" }, "")).toEqual({ kind: "workspace" });
        expect(markFace({ kind: "none" }, null)).toEqual({ kind: "workspace" });
    });
});

describe("what the mark's click opens, as the expanded header does", () => {
    it("opens the project menu when the header shows a project chip", () => {
        expect(headerProjectType(ws(Two))).toBe("Desktop");
        expect(markAction(ws(Two))).toBe("project");
        expect(markAction(ws({ "molten:project": "/x/Acme", "molten:projecttype": "Desktop" }))).toBe("project");
    });

    it("shows the chip of a project without a type by its folder when the workspace holds several", () => {
        const second = {
            ...Two,
            "molten:currentproject": "p2",
            "molten:project": "/x/Acme-website",
            "molten:projecttype": "",
        };
        expect(headerProjectType(ws(second))).toBe("Acme-website");
        expect(markAction(ws(second))).toBe("project");
    });

    it("opens the workspace menu when the header has no chip: a lone project without a type, or none", () => {
        expect(headerProjectType(ws({ "molten:project": "/x/Acme" }))).toBe("");
        expect(markAction(ws({ "molten:project": "/x/Acme" }))).toBe("workspace");
        expect(markAction(ws({}))).toBe("workspace");
        expect(markAction(null)).toBe("workspace");
    });
});

describe("what the hover names", () => {
    it("names the current project, by its type or else its folder", () => {
        expect(markProjectName(ws(Two))).toBe("Desktop");
        expect(markProjectName(ws({ "molten:project": "/x/Acme" }))).toBe("Acme");
    });

    it("names no project for a workspace without one", () => {
        expect(markProjectName(ws({}))).toBe("");
        expect(markProjectName(null)).toBe("");
    });
});

describe("the rail's width", () => {
    const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");

    it("is the same number in the model and in the stylesheet", () => {
        expect(css).toContain(`--mt-rail-px: ${CollapsedRailPx}px;`);
    });

    it("is the room of its margin, the 3 px liseré, its gap and the 16 px mark", () => {
        expect(CollapsedRailPx).toBe(6 + 3 + 5 + 16);
    });
});
