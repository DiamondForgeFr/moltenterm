// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the plan section of the agents block (#2430): which steps show, which fold, where the rail turns from
// patina to iron. Pure, so they are tested without a window.

import type { CompanionTodo, TodoStatus } from "./companion-model";

// The done steps the section lists; the earlier ones fold into one line ("N steps done").
export const PlanDoneShown = 3;

export type PlanRowKind = "done" | "current" | "todo";

export type PlanRow = { kind: PlanRowKind; todo: CompanionTodo; index: number };

export type PlanView = {
    // folded: how many done steps the fold line counts (0 when none folds).
    folded: number;
    rows: PlanRow[];
};

const RowKinds: Record<TodoStatus, PlanRowKind> = { completed: "done", in_progress: "current", pending: "todo" };

export function planRowKind(status: TodoStatus): PlanRowKind {
    return RowKinds[status] ?? "todo";
}

// The steps to list: the current step and every step to do always, the last PlanDoneShown done steps, the earlier done
// ones folded. The hero folds every done step until the developer unfolds them (doneShown, #2441).
export function planView(todos: CompanionTodo[], doneShown: number = PlanDoneShown): PlanView {
    const list = todos ?? [];
    const done = list.flatMap((todo, index) => (todo.status === "completed" ? [index] : []));
    const folded = new Set(done.slice(0, Math.max(0, done.length - doneShown)));
    const rows: PlanRow[] = [];
    list.forEach((todo, index) => {
        if (!folded.has(index)) {
            rows.push({ kind: planRowKind(todo.status), todo, index });
        }
    });
    return { folded: folded.size, rows };
}

// The strip above the list: one segment per step, in order.
export function planStrip(todos: CompanionTodo[]): TodoStatus[] {
    return (todos ?? []).map((todo) => todo.status);
}

// Where the rail turns from patina (done) to iron (to do), in percent of its height. The fold line is the first slot
// when steps fold; the boundary is the current step's middle, or the end of the done steps when none is current.
export function railStop(view: PlanView): number {
    const slots = view.rows.length + (view.folded > 0 ? 1 : 0);
    if (slots === 0) {
        return 0;
    }
    const offset = view.folded > 0 ? 1 : 0;
    const current = view.rows.findIndex((row) => row.kind === "current");
    let boundary: number;
    if (current >= 0) {
        boundary = offset + current + 0.5;
    } else {
        const doneRows = view.rows.filter((row) => row.kind === "done").length;
        boundary = offset + doneRows;
    }
    return Math.round((boundary / slots) * 1000) / 10;
}
