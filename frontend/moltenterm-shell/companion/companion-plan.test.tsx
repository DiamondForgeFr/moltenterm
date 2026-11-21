// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import type { CompanionTodo } from "./companion-model";
import { PlanSection } from "./companion-plan";

const Now = 1_000_000_000;

function steps(...statuses: CompanionTodo["status"][]): CompanionTodo[] {
    return statuses.map((status, i) => ({
        text: `Step ${i + 1}`,
        status,
        at: status === "pending" ? undefined : Now - 60_000,
    }));
}

function markup(todos: CompanionTodo[], extra: Partial<Parameters<typeof PlanSection>[0]> = {}): string {
    return renderToStaticMarkup(
        <PlanSection todos={todos} name="Flore" now={Now} updatedAt={Now - 120_000} {...extra} />
    );
}

describe("PlanSection (#2430)", () => {
    it("names the agent, counts its steps and says when the plan changed", () => {
        const html = markup(steps("completed", "in_progress", "pending"));
        expect(html).toContain('data-testid="companion-plan"');
        expect(html).toContain("Plan of Flore");
        expect(html).toContain("1 / 3");
        expect(html).toContain("updated 2 min ago");
    });

    it("shows one row per step still to come with its state, and the strip one segment per step", () => {
        const html = markup(steps("completed", "in_progress", "pending"));
        expect(html.match(/data-testid="companion-plan-step"/g)).toHaveLength(2);
        expect(html).toContain("1 step done");
        expect(html).toContain('data-state="current"');
        expect(html).toContain('data-state="todo"');
        expect(html.match(/class="mt-plan-seg"/g)).toHaveLength(3);
    });

    it("gives the current step its duration and a done step its time", () => {
        const html = markup(steps("completed", "in_progress", "pending"));
        expect(html).toContain("in progress · 1 min");
    });

    it("folds the done steps into one line that unfolds, and keeps the current step and those to do (#2441)", () => {
        const html = markup(steps("completed", "completed", "completed", "completed", "in_progress", "pending"));
        expect(html).toContain('data-testid="companion-plan-folded"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain("4 steps done");
        expect(html.match(/data-testid="companion-plan-step"/g)).toHaveLength(2);
        expect(html).toContain('data-state="current"');
        expect(html).toContain("Plan · 4 / 6");
    });

    it("shows nothing for a plan without steps", () => {
        expect(markup([])).toBe("");
    });

    it("keeps the link ends of the steps, so a line can join a step to its agent", () => {
        const html = markup(steps("in_progress"), {
            links: new Map([[0, { id: "a1", name: "Ann", state: "working", ticket: 0, description: "" }]]),
        });
        expect(html).toContain('data-link-end="todo:0"');
    });

    it("writes in French", () => {
        const i18n = I18nModel.getInstance();
        i18n.setLanguageSetting("fr");
        try {
            const html = markup(steps("completed", "in_progress"));
            expect(html).toContain("Plan de Flore");
            expect(html).toContain("mis à jour il y a 2 min");
            expect(html).toContain("en cours · 1 min");
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});
