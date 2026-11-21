// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan of the main agent, "Plan of <first name>" (#2430), in the Agents block under the agent and its sub-agents:
// the steps the agent published with `molten agent plan`, or its native task list. A progress strip, then the steps on
// a vertical rail: done (a patina check, its time), the current step (the working arc, "in progress · N min"), to do (a
// hollow iron dot). The rail turns from patina to iron at the current step. Display only.

import { cn } from "@/util/util";
import { useState, type CSSProperties } from "react";
import { getLocale, useT, useTCount } from "../i18n/i18n";
import { durationText } from "../reviews/reviews-upcoming-model";
import { StateMark, StateMarkKind } from "../state-mark";
import { heatOf, LinkAgent, todoEnd } from "./companion-milestone-model";
import type { CompanionTodo } from "./companion-model";
import { relativeTime, todoCounts } from "./companion-model";
import { planStrip, planView, railStop, type PlanRow } from "./companion-plan-model";
import "./companion-plan.css";
import { endAttrs, EndMarks, LinkChip } from "./companion-tasks";

// The state each step's link end takes when no agent works on it: a step's own state.
const StepHeat: Record<string, StateMarkKind> = { completed: "ready", in_progress: "running", pending: "draft" };

const NoMarks: EndMarks = { chips: false, lit: new Set(), ends: new Set() };

export function PlanSection({
    todos,
    name,
    updatedAt,
    now,
    links,
    marks,
}: {
    todos: CompanionTodo[];
    name: string;
    updatedAt?: number;
    now: number;
    // The agent each step works with (its link to the agent drawn by the work area), by step index.
    links?: ReadonlyMap<number, LinkAgent>;
    marks?: EndMarks;
}) {
    const t = useT();
    const tc = useTCount();
    const [unfolded, setUnfolded] = useState(false);
    if (todos == null || todos.length === 0) {
        return null;
    }
    const { done, total } = todoCounts(todos);
    // The hero's plan folds every done step into one line that unfolds (#2441).
    const view = planView(todos, unfolded ? total : 0);
    const stop = railStop(view);
    const strip = planStrip(todos);
    const locale = getLocale();
    const linkMarks = marks ?? NoMarks;
    const current = todos.find((todo) => todo.status === "in_progress");
    const updated = updatedAt ? t("companion.plan.updated", { time: relativeTime(updatedAt, now) }) : "";
    const time = current
        ? current.at > 0
            ? t("companion.plan.inProgressFor", { duration: durationText(t, now - current.at) })
            : t("companion.plan.inProgress")
        : updated;
    const doneCount = todos.filter((todo) => todo.status === "completed").length;
    return (
        <section
            className="mt-cdash-plan mt-plan"
            data-section="plan"
            data-testid="companion-plan"
            aria-label={t("companion.plan.title", { name })}
        >
            <div className="mt-cdash-plan-head">
                <span className="truncate">{t("companion.plan.head", { done, total })}</span>
                {time ? (
                    <span
                        className="mt-cdash-plan-time truncate"
                        data-quiet={current ? undefined : ""}
                        title={updated || undefined}
                        data-testid="companion-plan-updated"
                    >
                        {time}
                    </span>
                ) : null}
            </div>
            <div className="mt-plan-strip" aria-hidden="true">
                {strip.map((status, i) => (
                    <span key={i} className="mt-plan-seg" data-state={status} />
                ))}
            </div>
            <ol className="mt-plan-list" style={{ "--mt-plan-stop": `${stop}%` } as CSSProperties}>
                {doneCount > 0 ? (
                    <li>
                        <button
                            type="button"
                            className="mt-plan-fold mt-plan-fold-button"
                            aria-expanded={unfolded}
                            onClick={(e) => {
                                e.stopPropagation();
                                setUnfolded(!unfolded);
                            }}
                            data-testid="companion-plan-folded"
                        >
                            <span>{tc("companion.plan.folded", doneCount, { count: doneCount })}</span>
                            <i
                                className={cn("fa fa-solid", unfolded ? "fa-chevron-up" : "fa-chevron-down")}
                                aria-hidden="true"
                            />
                        </button>
                    </li>
                ) : null}
                {view.rows.map((row) => (
                    <PlanStep key={row.index} row={row} now={now} locale={locale} links={links} marks={linkMarks} />
                ))}
            </ol>
        </section>
    );
}

function PlanStep({
    row,
    now,
    locale,
    links,
    marks,
}: {
    row: PlanRow;
    now: number;
    locale: string;
    links?: ReadonlyMap<number, LinkAgent>;
    marks: EndMarks;
}) {
    const t = useT();
    const { todo, kind, index } = row;
    const at = todo.at ?? 0;
    const agent = links?.get(index);
    const heat = agent != null ? heatOf(agent.state) : (StepHeat[todo.status] ?? "draft");
    const meta =
        kind === "done" && at > 0
            ? new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
            : kind === "current"
              ? at > 0
                  ? t("companion.plan.inProgressFor", { duration: durationText(t, now - at) })
                  : t("companion.plan.inProgress")
              : "";
    return (
        <li
            className="mt-plan-step"
            data-state={kind}
            data-testid="companion-plan-step"
            {...endAttrs(todoEnd(index), heat, marks)}
        >
            <span className="mt-plan-mark">
                {kind === "done" ? <DoneMark label={t("companion.plan.done")} /> : null}
                {kind === "current" ? <StateMark kind="running" label={t("companion.plan.current")} /> : null}
                {kind === "todo" ? <StateMark kind="draft" label={t("companion.plan.todo")} /> : null}
            </span>
            <span className="mt-plan-text truncate" title={todo.text}>
                {todo.text}
            </span>
            {marks.chips && agent != null ? <LinkChip agent={agent} /> : null}
            {meta ? <span className="mt-plan-meta">{meta}</span> : null}
        </li>
    );
}

function DoneMark({ label }: { label: string }) {
    return (
        <svg className="mt-plan-check" width="12" height="12" viewBox="0 0 12 12" role="img" aria-label={label}>
            <circle cx="6" cy="6" r="5.5" />
            <path d="m3.6 6.1 1.6 1.6 3.2-3.3" />
        </svg>
    );
}
