// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    checkWorkspaceName,
    colourName,
    dangerAction,
    iconName,
    isFreshIntent,
    moveRadio,
    parseIntent,
    radioTabStop,
} from "./workspace-edit-model";
import { LastWorkspaceReason } from "./workspace-reset-model";

// wavesrv's lists (pkg/wcore/workspace.go): every colour has a name and every icon a readable one.
const WorkspaceGo = readFileSync(join(__dirname, "../../pkg/wcore/workspace.go"), "utf8");

function goList(name: string): string[] {
    const body = new RegExp(`var ${name} = \\[\\.\\.\\.\\]string\\{([^}]*)\\}`).exec(WorkspaceGo)?.[1] ?? "";
    return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("workspace name (FR-SHELL-030-AC9)", () => {
    it("saves the trimmed name", () => {
        expect(checkWorkspaceName("  Client A ")).toBe("Client A");
    });

    it("refuses an empty name, so the previous one stays saved", () => {
        expect(checkWorkspaceName("")).toBeNull();
        expect(checkWorkspaceName("   ")).toBeNull();
        expect(checkWorkspaceName(null)).toBeNull();
    });
});

describe("names for screen readers (NFR-SHELL-014)", () => {
    it("names every colour wavesrv offers, never by its code alone", () => {
        const colours = goList("WorkspaceColors");
        expect(colours.length).toBeGreaterThan(0);
        for (const colour of colours) {
            expect(colourName(colour), colour).toMatch(/^[A-Z][a-z]+$/);
        }
        expect(colourName("#ff7c0d")).toBe("Orange");
        expect(colourName("#123456")).toBe("#123456");
        expect(colourName("")).toBe("No colour");
    });

    it("names every icon wavesrv offers in words", () => {
        const icons = goList("WorkspaceIcons");
        expect(icons.length).toBeGreaterThan(0);
        for (const icon of icons) {
            expect(iconName(icon), icon).toMatch(/^[A-Z][a-z ]+$/);
        }
        expect(iconName("custom@wave-logo-solid")).toBe("Wave");
        expect(iconName("graduation-cap")).toBe("Graduation cap");
        expect(iconName("rocket")).toBe("Rocket");
        expect(iconName("solid@paper-plane")).toBe("Paper plane");
    });
});

describe("radio groups move with the arrow keys (TC-SHELL-044)", () => {
    it("moves forward and back, wrapping at the ends", () => {
        expect(moveRadio("ArrowRight", 0, 3)).toBe(1);
        expect(moveRadio("ArrowDown", 2, 3)).toBe(0);
        expect(moveRadio("ArrowLeft", 0, 3)).toBe(2);
        expect(moveRadio("ArrowUp", 1, 3)).toBe(0);
    });

    it("jumps to the ends with Home and End", () => {
        expect(moveRadio("Home", 2, 5)).toBe(0);
        expect(moveRadio("End", 0, 5)).toBe(4);
    });

    it("ignores other keys and empty groups", () => {
        expect(moveRadio("Enter", 1, 3)).toBe(-1);
        expect(moveRadio("Tab", 1, 3)).toBe(-1);
        expect(moveRadio("ArrowRight", 0, 0)).toBe(-1);
    });

    it("moves from the first option when the focus is outside the group", () => {
        expect(moveRadio("ArrowRight", -1, 3)).toBe(1);
    });

    it("gives the tab stop to the selected option, else the first", () => {
        expect(radioTabStop(["a", "b", "c"], "b")).toBe(1);
        expect(radioTabStop(["a", "b", "c"], "z")).toBe(0);
        expect(radioTabStop([], "a")).toBe(0);
    });
});

describe("danger zone (FR-SHELL-030-AC8, #222)", () => {
    it("offers Delete when another workspace remains", () => {
        expect(dangerAction(true)).toMatchObject({ kind: "delete", label: "Delete workspace" });
    });

    it("offers Reset with #222's reason on the last workspace", () => {
        const action = dangerAction(false);
        expect(action).toMatchObject({ kind: "reset", label: "Reset workspace…" });
        expect(action.text).toContain(LastWorkspaceReason);
    });
});

describe("a double-click handed over between tab views (DS-SHELL-035)", () => {
    it("reads only well-formed intents", () => {
        expect(parseIntent('{"workspaceId":"w1","at":5}')).toEqual({ workspaceId: "w1", at: 5 });
        expect(parseIntent("")).toBeNull();
        expect(parseIntent(null)).toBeNull();
        expect(parseIntent("not json")).toBeNull();
        expect(parseIntent('{"workspaceId":"","at":5}')).toBeNull();
        expect(parseIntent('{"workspaceId":"w1"}')).toBeNull();
    });

    it("is fresh only for its workspace and within its age", () => {
        const intent = { workspaceId: "w1", at: 1000 };
        expect(isFreshIntent(intent, "w1", 1400, 500)).toBe(true);
        expect(isFreshIntent(intent, "w1", 1600, 500)).toBe(false);
        expect(isFreshIntent(intent, "w2", 1100, 500)).toBe(false);
        expect(isFreshIntent(intent, "w1", 900, 500)).toBe(false);
        expect(isFreshIntent(null, "w1", 1000, 500)).toBe(false);
    });
});
