// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { InputReport, WebviewInputGate } from "./moltenterm-webview-input-gate";

const event = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    isTrusted: true,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...extra,
});

describe("the page's input gate (#971: taking over is explicit)", () => {
    it("holds back the user's whole click and leaves the agent's through", () => {
        const agentPoint = { x: 10, y: 20 };
        const asked: InputReport[] = [];
        const gate = new WebviewInputGate((report) => {
            asked.push(report);
            return report.type === "mousedown" && report.x === agentPoint.x && report.y === agentPoint.y;
        });
        const user = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].map((type) =>
            event(type, { button: 0, clientX: 300, clientY: 40 })
        );
        expect(user.map((e) => gate.handle(e))).toEqual([true, true, true, true, true]);
        expect(user[0].preventDefault).toHaveBeenCalled();
        expect(user[4].stopImmediatePropagation).toHaveBeenCalled();
        const agent = ["pointerdown", "mousedown", "mouseup", "click"].map((type) =>
            event(type, { button: 0, clientX: 10, clientY: 20 })
        );
        expect(agent.map((e) => gate.handle(e))).toEqual([false, false, false, false]);
        expect(asked).toEqual([
            { type: "mousedown", button: 0, x: 300, y: 40 },
            { type: "mousedown", button: 0, x: 10, y: 20 },
        ]);
    });

    it("holds back the user's key with its keypress and keyup, and only that key", () => {
        const gate = new WebviewInputGate((report) => report.type === "keydown" && report.key === "Enter");
        expect(gate.handle(event("keydown", { key: "a", code: "KeyA" }))).toBe(true);
        expect(gate.handle(event("keypress", { key: "a", code: "KeyA" }))).toBe(true);
        expect(gate.handle(event("keydown", { key: "Enter", code: "Enter" }))).toBe(false);
        expect(gate.handle(event("keyup", { key: "a", code: "KeyA" }))).toBe(true);
        expect(gate.handle(event("keyup", { key: "a", code: "KeyA" }))).toBe(false);
        expect(gate.handle(event("keyup", { key: "Enter", code: "Enter" }))).toBe(false);
    });

    it("lets everything through when the page takes all input, and ignores the page's own synthetic events", () => {
        const ask = vi.fn(() => true);
        const gate = new WebviewInputGate(ask);
        for (const type of ["pointerdown", "mousedown", "mouseup", "click", "keydown", "keypress", "keyup"]) {
            expect(gate.handle(event(type, { key: "a", code: "KeyA" }))).toBe(false);
        }
        expect(gate.handle({ ...event("pointerdown"), isTrusted: false })).toBe(false);
        expect(ask).toHaveBeenCalledTimes(2);
    });
});
