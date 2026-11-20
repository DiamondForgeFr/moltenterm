// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's arranging mode (FR-SHELL-018, #2395), in place of the sections while it is on: one row per section
// of the registry (companion-layout.ts) with a handle, a switch for shown or hidden, and a choice of column. The
// changes are drafted here and saved when the mode is left, however it is left (Done, Escape, the Arrange button, the
// pane closing). Nothing reorders by itself. Loaded on demand, out of the startup bundle (companion-view.tsx).

import { cn } from "@/util/util";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { useFlipMove } from "../molten-motion";
import { ToggleGroup } from "../suite/suite";
import { usePointerReorder } from "../workspace-views/template-drag";
import {
    ColumnChoices,
    handleTarget,
    makeLayoutCommit,
    moveSection,
    resetLayout,
    SectionNameKeys,
    setSectionColumn,
    setSectionHidden,
} from "./companion-arrange-model";
import "./companion-arrange.css";
import {
    CompanionColumn,
    CompanionLayout,
    CompanionSectionId,
    isDefaultLayout,
    normalizeLayout,
    TwoColumnMinWidth,
} from "./companion-layout";

// A zero-width space: appended to a sentence, it makes the live region's text new without changing what is read.
const InvisibleMark = String.fromCharCode(0x200b);

const ColumnLabelKeys: Record<CompanionColumn, string> = {
    full: "companion.arrange.columnFull",
    left: "companion.arrange.columnLeft",
    right: "companion.arrange.columnRight",
};

// The side of a row a dragged section would land on: below a row that stands after it, above one that stands before.
function dropSide(drag: { from: number; over: number }, i: number): string {
    if (drag == null || drag.over !== i || drag.from === i) {
        return undefined;
    }
    return drag.from < i ? "after" : "before";
}

export type CompanionArrangeProps = {
    // The layout in force when the mode opens.
    layout: CompanionLayout;
    // Called with the drafted layout when the mode is left with changes; the caller keeps it.
    onSave: (layout: CompanionLayout) => void;
    // The Done button and Escape: the caller turns the mode off.
    onDone: () => void;
};

export function CompanionArrange({ layout, onSave, onDone }: CompanionArrangeProps) {
    const t = useT();
    const [draft, setDraft] = useState<CompanionLayout>(() => normalizeLayout(layout));
    const [note, setNote] = useState("");
    const titleId = useId();
    const helpId = useId();
    const titleRef = useRef<HTMLHeadingElement>(null);
    const focusAfter = useRef<CompanionSectionId>(null);
    const announced = useRef(false);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const committer = useRef<(draft: CompanionLayout) => boolean>(null);
    committer.current ??= makeLayoutCommit(draft, (next) => onSaveRef.current(next));

    // Leaving the mode saves the draft (once, and only when it changed): by Done, Escape, the Arrange button, or the
    // pane closing, which all end with this component going away.
    const commit = () => committer.current(draftRef.current);
    useEffect(() => {
        titleRef.current?.focus({ preventScroll: true });
        return () => {
            commit();
        };
    }, []);
    const leave = () => {
        commit();
        onDone();
    };

    // The same sentence twice in a row is not read again by a screen reader: the second one carries an invisible mark.
    const announce = (text: string) => {
        announced.current = !announced.current;
        setNote(announced.current ? `${text}${InvisibleMark}` : text);
    };
    const nameOf = (id: CompanionSectionId) => t(SectionNameKeys[id]);
    const place = (next: CompanionLayout, id: CompanionSectionId) => {
        setDraft(next);
        const at = next.findIndex((p) => p.id === id);
        announce(t("companion.arrange.moved", { name: nameOf(id), position: at + 1, total: next.length }));
    };

    const { containerRef, drag, onPointerDown } = usePointerReorder("data-arrange-row", (from, to) => {
        place(moveSection(draft, from, to), draft[from].id);
    });

    // Moving the row may take the focus with its old place: the handle gets it back.
    useFlipMove(containerRef, [draft.map((p) => p.id).join(",")]);
    useLayoutEffect(() => {
        const id = focusAfter.current;
        if (id == null) {
            return;
        }
        focusAfter.current = null;
        containerRef.current?.querySelector<HTMLElement>(`[data-arrange-handle="${id}"]`)?.focus();
    }, [draft]);

    const onHandleKey = (e: React.KeyboardEvent, index: number) => {
        const target = handleTarget(e.key, index, draft.length);
        if (target == null) {
            return;
        }
        e.preventDefault();
        const id = draft[index].id;
        if (target === index) {
            announce(t(index === 0 ? "companion.arrange.first" : "companion.arrange.last", { name: nameOf(id) }));
            return;
        }
        focusAfter.current = id;
        place(moveSection(draft, index, target), id);
    };

    const isDefault = isDefaultLayout(draft);
    const reset = () => {
        if (isDefault) {
            return;
        }
        setDraft(resetLayout());
        announce(t("companion.arrange.resetDone"));
    };

    return (
        <section
            className="mt-carr"
            aria-labelledby={titleId}
            data-testid="companion-arrange"
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    leave();
                }
            }}
        >
            <div className="mt-carr-head">
                <h3
                    id={titleId}
                    ref={titleRef}
                    tabIndex={-1}
                    className="min-w-0 flex-1 text-13 leading-5 font-medium text-primary outline-none"
                >
                    {t("companion.arrange.title")}
                </h3>
                <button
                    type="button"
                    className="molten-btn inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-3 text-12 font-medium"
                    onClick={leave}
                    data-testid="companion-arrange-done"
                >
                    {t("companion.arrange.done")}
                    <MoltenWave />
                </button>
            </div>
            <p className="text-12 text-secondary">{t("companion.arrange.hint")}</p>
            <p className="text-11 text-muted">
                {t("companion.arrange.columnsHint", { width: TwoColumnMinWidth })} {t("companion.arrange.saves")}
            </p>
            <span id={helpId} className="sr-only">
                {t("companion.arrange.handleHelp")}
            </span>
            <ol
                ref={containerRef as React.RefObject<HTMLOListElement>}
                className="mt-carr-list"
                aria-label={t("companion.arrange.list")}
                data-testid="companion-arrange-list"
            >
                {draft.map((p, i) => {
                    const name = nameOf(p.id);
                    const shown = !p.hidden;
                    return (
                        <li
                            key={p.id}
                            className="mt-carr-row"
                            data-motion-key={p.id}
                            data-arrange-row={i}
                            data-section={p.id}
                            data-column={p.column}
                            data-hidden={shown ? undefined : ""}
                            data-dragging={drag?.from === i ? "" : undefined}
                            data-drop={dropSide(drag, i)}
                            data-testid="companion-arrange-row"
                            onPointerDown={(e) => onPointerDown(e, i)}
                        >
                            <button
                                type="button"
                                className="mt-carr-handle"
                                data-drag-handle=""
                                data-arrange-handle={p.id}
                                aria-label={t("companion.arrange.handle", { name })}
                                aria-describedby={helpId}
                                title={t("companion.arrange.handle", { name })}
                                onKeyDown={(e) => onHandleKey(e, i)}
                                data-testid="companion-arrange-handle"
                            >
                                <i className="fa-solid fa-grip-vertical" aria-hidden="true" />
                            </button>
                            <span className="mt-carr-name">{name}</span>
                            <ToggleGroup<CompanionColumn>
                                label={t("companion.arrange.column", { name })}
                                options={ColumnChoices.map((value) => ({ value, label: t(ColumnLabelKeys[value]) }))}
                                selected={p.column}
                                onSelect={(column) => {
                                    setDraft(setSectionColumn(draft, p.id, column));
                                    announce(
                                        t("companion.arrange.columnNow", {
                                            name,
                                            column: t(ColumnLabelKeys[column]),
                                        })
                                    );
                                }}
                                className="mt-carr-columns"
                            />
                            <span className="mt-carr-visible">
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={shown}
                                    aria-label={t("companion.arrange.show", { name })}
                                    className="mt-carr-switch"
                                    onClick={() => {
                                        setDraft(setSectionHidden(draft, p.id, shown));
                                        announce(
                                            t(shown ? "companion.arrange.hiddenNow" : "companion.arrange.shownNow", {
                                                name,
                                            })
                                        );
                                    }}
                                    data-testid="companion-arrange-switch"
                                />
                                <span className={cn("mt-carr-state", shown ? "text-secondary" : "text-muted")}>
                                    {shown ? t("companion.arrange.shown") : t("companion.arrange.hidden")}
                                </span>
                            </span>
                        </li>
                    );
                })}
            </ol>
            <div>
                <button
                    type="button"
                    className="molten-btn-ghost inline-flex h-row cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12 aria-disabled:cursor-default aria-disabled:opacity-40"
                    aria-disabled={isDefault}
                    onClick={reset}
                    data-testid="companion-arrange-reset"
                >
                    <i className="fa-solid fa-rotate-left" aria-hidden="true" />
                    {t("companion.arrange.reset")}
                </button>
            </div>
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
                data-testid="companion-arrange-note"
            >
                {note}
            </div>
        </section>
    );
}
