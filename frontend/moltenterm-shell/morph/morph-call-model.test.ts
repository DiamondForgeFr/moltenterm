// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { morphCall, morphCallText, morphTarget, workspaceMorphTarget } from "./morph-call-model";

function lookup(dict: any, key: string): unknown {
    return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

const a = (blockid: string, extra: any) => ({ blockid, workspaceid: "w", version: 1, ...extra });

describe("morph call (#1653, #1672)", () => {
    it("types each agent's own morph call followed by a space, never Enter", () => {
        expect(morphCallText("claude")).toBe("/morph ");
        expect(morphCallText("codex")).toBe("$morph ");
        expect(morphCallText("kimi")).toBe("/skill:morph ");
        expect(morphCallText("gemini")).toBe("/morph ");
        expect(morphCallText(undefined)).toBe("/morph ");
        expect(morphCall("codex")).toBe("$morph");
    });

    it("adds what was typed in the launcher, never anything that would send it", () => {
        expect(morphCallText("claude", "kanban board")).toBe("/morph kanban board");
        expect(morphCallText("codex", "  kanban  ")).toBe("$morph kanban");
        expect(morphCallText("kimi", "a\r\nb\tc\u0003d\u007f")).toBe("/skill:morph a b c d");
        expect(morphCallText("claude", "board\r")).not.toMatch(/[\r\n]/);
    });
});

describe("morph target (#1653, #1672)", () => {
    it("picks the current view's agent, then a free prompt, then the latest", () => {
        const busyHere = a("b1", { tabid: "t1", state: "working", started: 1 });
        const freeThere = a("b2", { tabid: "t2", state: "idle", started: 2 });
        const freeLater = a("b3", { tabid: "t2", state: "done", started: 3 });
        const background = a("b4", { tabid: "t3", state: "working", background: true, started: 0 });
        expect(morphTarget([freeThere, busyHere], "t1").blockid).toBe("b1");
        expect(morphTarget([busyHere, freeThere, freeLater], "t9").blockid).toBe("b3");
        expect(morphTarget([busyHere, background], "t9").blockid).toBe("b4");
        expect(morphTarget([], "t1")).toBeNull();
        expect(morphTarget(null, "t1")).toBeNull();
    });

    it("only looks in the current workspace", () => {
        const here = a("b1", { tabid: "t1", state: "idle", started: 1 });
        const elsewhere = { ...a("b2", { tabid: "t2", state: "idle", started: 2 }), workspaceid: "other" };
        const data: any = { states: { b1: here, b2: elsewhere } };
        expect(workspaceMorphTarget(data, "w", "t9").blockid).toBe("b1");
        expect(workspaceMorphTarget(data, "none", "t9")).toBeNull();
        expect(workspaceMorphTarget(null, "w", "t9")).toBeNull();
    });
});

describe("launcher hint texts (#1672)", () => {
    it("has its texts in both languages with the same placeholders", () => {
        for (const key of ["ask", "askTitle", "noAgent", "start", "startTitle"]) {
            const e = lookup(en, `newView.morph.${key}`) as string;
            const f = lookup(fr, `newView.morph.${key}`) as string;
            expect(e, key).toBeTruthy();
            expect(f, key).toBeTruthy();
            const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
            expect(holes(f), key).toEqual(holes(e));
        }
    });
});
