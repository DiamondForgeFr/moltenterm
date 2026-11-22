// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The controls the arranging mode lays over the dashboard (FR-SHELL-018, #2459, #2467): on each block's top border the
// handle (the keyboard's, and the pointer's), the eye, full width and the settings gear; on the usage attached to the main
// agent the handle that detaches it with the eye and the gear; the slim bar that holds the help, Reset to default and Done.
// The blocks themselves are the dashboard's own, with their real content: these controls are all the mode adds, and none
// of them changes a block's size. Loaded with the arranging mode, out of the startup bundle.

import { useLayoutEffect, useRef } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import type { ArrangeValue, BlockChrome } from "./companion-arrange-context";
import { handleTarget, moveRanked, positionOf, rankedIds, SectionNameKeys } from "./companion-arrange-model";
import type { ArrangeSession } from "./companion-arrange-session";
import { BlockTool } from "./companion-block";
import {
    BlockOption,
    BlockOptionKey,
    BlockPrefKey,
    optionAnnouncement,
    optionsOf,
    PrefDefaults,
    setLayoutOption,
} from "./companion-block-options";
import { BlockSettings } from "./companion-block-settings";
import { CompanionLayout, CompanionSectionId, isDefaultLayout, usageOf } from "./companion-layout";
import { useBlockPrefs } from "./companion-prefs";
import { CompactBlockPx } from "./companion-tasks";
import { hiddenRowsOf, setUsageRowHidden, windowChoices } from "./companion-usage-rows-model";

export type ArrangeChromeOptions = {
    arranging: boolean;
    session: ArrangeSession;
    flowRef: React.RefObject<HTMLDivElement>;
    // The block a pointer carries, and the handle of the attached usage that lifts it out.
    dragging: CompanionSectionId;
    onDetachDown: (e: React.PointerEvent<HTMLElement>) => void;
    // The flow's columns: the milestone block's width decides whether its groups open by themselves.
    columns: number;
    columnWidth: number;
    // The agent whose plan the usage shows, the key of the rows the layout hides.
    usageAgent: string;
};

export type ArrangeChrome = {
    // What the blocks read; null outside the mode.
    value: ArrangeValue;
    // The controls on the usage attached to the main agent; null when it is not.
    attached: React.ReactNode;
};

export function useArrangeChrome(o: ArrangeChromeOptions): ArrangeChrome {
    const t = useT();
    const { session, arranging } = o;
    const layout = session.layout;
    const { prefs, set: setPref } = useBlockPrefs();
    const focusAfter = useRef<{ id: CompanionSectionId; what: string }>(null);
    // After a move by the keyboard the handle that made it has the focus again, in its new place.
    useLayoutEffect(() => {
        const after = focusAfter.current;
        if (after == null) {
            return;
        }
        focusAfter.current = null;
        o.flowRef.current
            ?.querySelector<HTMLElement>(`[data-flow-id="${after.id}"] [data-arrange="${after.what}"]`)
            ?.focus();
    }, [layout]);
    if (!arranging) {
        return { value: null, attached: null };
    }
    const nameOf = (id: CompanionSectionId) => t(SectionNameKeys[id]);
    const optionOf = (id: CompanionSectionId, key: BlockOptionKey) => optionsOf(id).find((opt) => opt.key === key);
    // The Taken by others group opens by itself while the milestone block is wide (#2418): so it reads in its option.
    const tasksFull = layout.find((p) => p.id === "tasks")?.span === "full";
    const tasksWidth = o.columns >= 2 && tasksFull ? 0 : o.columnWidth;
    const defaults: PrefDefaults = { takenopen: !(tasksWidth > 0 && tasksWidth < CompactBlockPx) };
    const choices = windowChoices(session.windows, hiddenRowsOf(layout, o.usageAgent));
    // An option set, from the block's own buttons or its settings: a layout option is drafted with the layout, a
    // preference is saved as it is set; both are announced.
    const change = (id: CompanionSectionId, option: BlockOption, value: boolean) => {
        const name = nameOf(id);
        if (option.store === "layout") {
            session.setDraft(setLayoutOption(layout, id, option, value));
            session.announce(t(optionAnnouncement(option, value), { name }));
            return;
        }
        setPref(option.key as BlockPrefKey, value);
        session.announce(t(optionAnnouncement(option, value), { name, option: t(option.labelKey) }));
    };
    const move = (id: CompanionSectionId, to: number, what: string) => {
        const ranked = rankedIds(layout);
        const from = ranked.indexOf(id);
        const target = Math.max(0, Math.min(ranked.length - 1, to));
        if (target === from) {
            session.announce(
                t(from === 0 ? "companion.arrange.first" : "companion.arrange.last", { name: nameOf(id) })
            );
            return;
        }
        focusAfter.current = { id, what };
        session.setDraft(moveRanked(layout, id, target));
        session.announce(
            t("companion.arrange.moved", { name: nameOf(id), position: target + 1, total: ranked.length })
        );
    };
    const eye = (id: CompanionSectionId, shown: boolean) => (
        <BlockTool
            label={t("companion.arrange.show", { name: nameOf(id) })}
            pressed={shown}
            marker="show"
            onClick={() => change(id, optionOf(id, "shown"), !shown)}
            testId="companion-arrange-switch"
        >
            <i className={shown ? "fa fa-solid fa-eye" : "fa fa-solid fa-eye-slash"} aria-hidden="true" />
        </BlockTool>
    );
    const gear = (id: CompanionSectionId) => {
        const placement = layout.find((p) => p.id === id);
        return (
            <BlockSettings
                id={id}
                name={nameOf(id)}
                placement={placement}
                prefs={prefs}
                defaults={defaults}
                onChange={(option, value) => change(id, option, value)}
                rows={
                    id === "usage"
                        ? {
                              choices,
                              onSet: (key, hide) =>
                                  session.setDraft(
                                      setUsageRowHidden(
                                          layout,
                                          o.usageAgent,
                                          key,
                                          hide,
                                          session.windows.map((w) => w.id)
                                      )
                                  ),
                          }
                        : undefined
                }
            />
        );
    };
    const chromeOf = (id: string): BlockChrome => {
        const p = layout.find((placement) => placement.id === id);
        if (p == null) {
            return null;
        }
        const name = nameOf(p.id);
        const shown = p.hidden !== true;
        const attrs: Record<string, string> = { "data-section": p.id, "data-span": p.span };
        if (o.dragging === p.id) {
            attrs["data-dragging"] = "";
        }
        if (!shown) {
            attrs["data-hidden"] = "";
            return { grip: null, tools: eye(p.id, false), attrs };
        }
        const ranked = rankedIds(layout);
        const { position, total } = positionOf(layout, p.id);
        const full = p.span === "full";
        return {
            attrs,
            grip: (
                <button
                    type="button"
                    className="mt-cb-grip"
                    data-arrange="handle"
                    aria-label={t("companion.arrange.handleAt", { name, position, total })}
                    data-tip={t("companion.arrange.handleHelp")}
                    onKeyDown={(e) => {
                        const to = handleTarget(e.key, ranked.indexOf(p.id), ranked.length);
                        if (to == null) {
                            return;
                        }
                        e.preventDefault();
                        move(p.id, to, "handle");
                    }}
                    data-testid="companion-arrange-handle"
                >
                    <i className="fa-solid fa-ellipsis" aria-hidden="true" />
                </button>
            ),
            tools: (
                <>
                    {eye(p.id, true)}
                    <BlockTool
                        label={t("companion.arrange.wide", { name })}
                        pressed={full}
                        marker="wide"
                        onClick={() => change(p.id, optionOf(p.id, "wide"), !full)}
                        testId="companion-arrange-wide"
                    >
                        <i className="fa fa-solid fa-arrows-left-right" aria-hidden="true" />
                    </BlockTool>
                    {gear(p.id)}
                </>
            ),
        };
    };
    // The usage attached to the main agent is in its block, not in the flow: it has no rank, so it takes the handle
    // that detaches it, the eye and the gear, without full width.
    const attached = usageOf(layout).attached ? (
        <div
            className="mt-cdash-attached-chrome"
            role="group"
            aria-label={t("companion.arrange.attachedControls")}
            data-testid="companion-attached-controls"
        >
            <button
                type="button"
                className="mt-cb-grip"
                data-arrange="detach"
                aria-label={t("companion.arrange.detach", { name: nameOf("usage") })}
                data-tip={t("companion.arrange.detachHelp")}
                onPointerDown={o.onDetachDown}
                onClick={() => change("usage", optionOf("usage", "attached"), false)}
                data-testid="companion-arrange-detach"
            >
                <i className="fa-solid fa-link-slash" aria-hidden="true" />
            </button>
            <span className="mt-cdash-attached-tools">
                {eye("usage", true)}
                {gear("usage")}
            </span>
        </div>
    ) : null;
    return { value: { chromeOf }, attached };
}

// The help of the mode, as a slim bar laid over the top of the companion: it takes none of the dashboard's room, so that
// the blocks stand where they stood, and it stays in view while the companion scrolls (#2467).
export function ArrangeBar({
    layout,
    onReset,
    onDone,
    titleRef,
}: {
    layout: CompanionLayout;
    onReset: () => void;
    onDone: () => void;
    titleRef: React.RefObject<HTMLSpanElement>;
}) {
    const t = useT();
    const isDefault = isDefaultLayout(layout);
    const hint = t("companion.arrange.hint");
    return (
        <div className="mt-cdash-arrbar" data-testid="companion-arrange">
            <div className="mt-cdash-arrbar-in" role="region" aria-label={t("companion.arrange.title")}>
                <i className="fa fa-solid fa-table-columns mt-cdash-arrbar-icon" aria-hidden="true" />
                <span ref={titleRef} tabIndex={-1} className="mt-cdash-arrbar-hint outline-none" data-tip={hint}>
                    {hint}
                </span>
                <button
                    type="button"
                    className="mt-cdash-arrbar-btn molten-btn-ghost aria-disabled:cursor-default aria-disabled:opacity-40"
                    aria-disabled={isDefault}
                    onClick={() => {
                        if (!isDefault) {
                            onReset();
                        }
                    }}
                    data-testid="companion-arrange-reset"
                >
                    {t("companion.arrange.reset")}
                </button>
                <button
                    type="button"
                    className="mt-cdash-arrbar-btn molten-btn font-medium"
                    onClick={onDone}
                    data-testid="companion-arrange-done"
                >
                    {t("companion.arrange.done")}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}

// What assistive technology hears after each change of the mode.
export function ArrangeNote({ note }: { note: string }) {
    return (
        <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            data-testid="companion-arrange-note"
        >
            {note}
        </div>
    );
}
