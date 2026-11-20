// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { CompanionTodo } from "./companion-model";
import { PlanDoneShown, planStrip, planView, railStop } from "./companion-plan-model";

function steps(...statuses: CompanionTodo["status"][]): CompanionTodo[] {
    return statuses.map((status, i) => ({ text: `step ${i + 1}`, status }));
}

describe("planView", () => {
    it("lists every step when at most PlanDoneShown are done", () => {
        const view = planView(steps("completed", "completed", "in_progress", "pending"));
        expect(view.folded).toBe(0);
        expect(view.rows.map((r) => r.kind)).toEqual(["done", "done", "current", "todo"]);
        expect(view.rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    });

    it("folds the earlier done steps beyond PlanDoneShown and keeps the latest ones", () => {
        const todos = steps("completed", "completed", "completed", "completed", "completed", "in_progress", "pending");
        const view = planView(todos);
        expect(PlanDoneShown).toBe(3);
        expect(view.folded).toBe(2);
        expect(view.rows.map((r) => r.index)).toEqual([2, 3, 4, 5, 6]);
    });

    it("always shows the current step, however many steps are done", () => {
        const todos = steps(...Array.from({ length: 12 }, () => "completed" as const), "in_progress");
        const view = planView(todos);
        expect(view.rows.at(-1)?.kind).toBe("current");
        expect(view.folded).toBe(9);
    });

    it("shows nothing for an empty plan", () => {
        expect(planView([])).toEqual({ folded: 0, rows: [] });
        expect(planView(undefined as unknown as CompanionTodo[])).toEqual({ folded: 0, rows: [] });
    });
});

describe("planStrip", () => {
    it("gives one status per step, in order", () => {
        expect(planStrip(steps("pending", "in_progress", "completed"))).toEqual([
            "pending",
            "in_progress",
            "completed",
        ]);
    });
});

describe("railStop", () => {
    it("turns at the middle of the current step", () => {
        // four steps, the second current: the boundary is 1.5 of 4 slots
        expect(railStop(planView(steps("completed", "in_progress", "pending", "pending")))).toBe(37.5);
    });

    it("counts the fold line as a slot", () => {
        // six done steps: three fold into the line, three are listed, then the current step and one to do:
        // 1 (the line) + 3 + 0.5 of 6 slots
        const todos = steps(...Array.from({ length: 6 }, () => "completed" as const), "in_progress", "pending");
        expect(railStop(planView(todos))).toBe(75);
    });

    it("turns after the done steps when none is current", () => {
        expect(railStop(planView(steps("completed", "completed", "pending", "pending")))).toBe(50);
        expect(railStop(planView(steps("pending", "pending")))).toBe(0);
        expect(railStop(planView(steps("completed", "completed")))).toBe(100);
    });

    it("is zero for an empty plan", () => {
        expect(railStop(planView([]))).toBe(0);
    });
});
