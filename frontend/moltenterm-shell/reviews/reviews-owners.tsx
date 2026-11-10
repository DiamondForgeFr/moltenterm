// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Integration panel's owners (FR-REV-034, #2174, #2207): the owners menu the header's funnel button opens (whose
// work the view shows, the proposal for an agent that joined, the count hidden), the owner on each card, the groups of
// work in progress under their lead, and the calm line for what outside the filter waits for the developer.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useT, useTCount } from "../i18n/i18n";
import type { OwnersFilter } from "./reviews-owners-filter";
import { ownersNamesFitting } from "./reviews-owners-fit";
import { MinNamesShown, OwnerFacts, ownersFilterFacts } from "./reviews-owners-model";
import type { ViewScopeState } from "./reviews-owners-store";
import type { ElsewhereWaits } from "./reviews-workspace-model";

export type OwnerCount = { name: string; count: number; subs: number };

function Initial({ name, dashed }: { name: string; dashed?: boolean }) {
    return (
        <span
            className={cn(
                "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-11 font-semibold",
                dashed ? "border border-dashed border-border text-muted" : "bg-hover text-accent"
            )}
            aria-hidden
        >
            {dashed ? "?" : name.trim().slice(0, 1).toUpperCase()}
        </span>
    );
}

// Loaded on demand: the menu only shows once the developer opens it, so its code stays out of the JS every tab view
// loads up front (NFR-PERF-003, bundle.initialJsMB).
const OwnersMenu = lazy(() => import("./reviews-owners-menu").then((m) => ({ default: m.OwnersMenu })));

// Tells the header how many of the filter's names it has room for, now and whenever the panel is resized. It draws
// nothing: the header draws the names.
function OwnersNamesFit({ filter }: { filter: Pick<OwnersFilter, "blockId" | "factsAtom" | "shownAtom"> }) {
    const names = useAtomValue(filter.factsAtom).names;
    const key = names.join("\n");
    useLayoutEffect(() => {
        if (names.length <= MinNamesShown) {
            globalStore.set(filter.shownAtom, null);
            return;
        }
        const header = document.querySelector(
            `[data-blockid="${CSS.escape(filter.blockId)}"] .block-frame-default-header`
        );
        if (header == null) {
            return;
        }
        const fit = () => globalStore.set(filter.shownAtom, ownersNamesFitting(header, names));
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(header);
        const wrapper = header.querySelector(".block-frame-textelems-wrapper");
        if (wrapper != null) {
            observer.observe(wrapper);
        }
        return () => observer.disconnect();
    }, [filter, key]);
    return null;
}

// The owners menu of the panel's header button (FR-REV-034 AC12): drawn by the list the filter applies to, which knows
// the owners and what the filter hides, and hung from the button. It tells the header how many names fit, and draws
// nothing else; the button lives only while a list does.
export function OwnersFilterHost({
    filter,
    view,
    owners,
    hidden,
}: {
    filter: Pick<OwnersFilter, "blockId" | "factsAtom" | "listsAtom" | "menuAtom" | "shownAtom">;
    view: ViewScopeState;
    owners: OwnerCount[];
    // The pull requests the filter hides in the project(s) the list counts.
    hidden: number;
}) {
    const t = useT();
    const anchor = useAtomValue(filter.menuAtom);
    const shown = ownersFilterFacts(view.scope, view.present, true).shown;
    const close = useCallback(() => globalStore.set(filter.menuAtom, null), [filter]);
    useEffect(() => {
        globalStore.set(filter.listsAtom, (n) => n + 1);
        return () => {
            globalStore.set(filter.listsAtom, (n) => n - 1);
            close();
        };
    }, [filter, close]);
    useEffect(() => {
        if (!shown) {
            close();
        }
    }, [shown, close]);
    return (
        <>
            <OwnersNamesFit filter={filter} />
            {anchor != null && shown
                ? createPortal(
                      <Suspense fallback={null}>
                          <OwnersMenu
                              view={view}
                              owners={owners}
                              hidden={hidden}
                              label={t("reviews.owners.menuAria")}
                              anchor={anchor}
                              onClose={close}
                          />
                      </Suspense>,
                      document.body
                  )
                : null}
        </>
    );
}

// A card's owner: the agent, and the lead that handed it the work. Work nobody signed says so, in the list of a project
// where agents sign (showByHand).
export function OwnerChip({ owner, byHand }: { owner: OwnerFacts; byHand?: boolean }) {
    const t = useT();
    if (owner == null) {
        return byHand ? (
            <span
                className="shrink-0 rounded-full border border-dashed border-border px-2 text-11 leading-4 whitespace-nowrap text-muted"
                title={t("reviews.owners.byHandTitle")}
                data-testid="reviews-owner-chip"
                data-owner=""
            >
                {t("reviews.owners.byHand")}
            </span>
        ) : null;
    }
    const text = owner.lead ? t("reviews.owners.subOf", { name: owner.name, lead: owner.lead }) : owner.name;
    return (
        <span
            className="shrink-0 rounded-full border border-border px-2 text-11 leading-4 whitespace-nowrap text-secondary"
            data-testid="reviews-owner-chip"
            data-owner={owner.name}
        >
            {text}
        </span>
    );
}

// The head of a lead's group of work in progress, with the filter shortcut.
export function LeadGroupHeader({
    lead,
    subs,
    count,
    onFilter,
    open,
    onToggle,
}: {
    lead: string;
    subs: string[];
    count: number;
    onFilter?: () => void;
    // The group of work nobody owns folds.
    open?: boolean;
    onToggle?: () => void;
}) {
    const t = useT();
    const unowned = lead === "";
    const name = unowned ? t("reviews.owners.noAgentGroup") : lead;
    return (
        <div
            className="flex items-center gap-2 border-b border-border/60 bg-white/[0.02] px-3 py-1.5 text-13 last:border-b-0"
            data-testid="reviews-owners-group"
            data-lead={lead}
        >
            <Initial name={name} dashed={unowned} />
            <span className={cn("font-semibold", unowned ? "text-secondary" : "text-primary")}>{name}</span>
            {subs.length > 0 ? (
                <span className="text-muted">{t("reviews.owners.groupSubs", { names: subs.join(", ") })}</span>
            ) : null}
            <span className="text-muted tabular-nums">· {count}</span>
            {unowned ? <span className="truncate text-12 text-muted">· {t("reviews.owners.noAgentHint")}</span> : null}
            <span className="grow" />
            {onFilter != null ? (
                <button
                    type="button"
                    className="h-6 cursor-pointer rounded-full border border-border px-2.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                    onClick={onFilter}
                    data-testid="reviews-owners-group-filter"
                >
                    {t("reviews.owners.filterOn", { name: lead })}
                </button>
            ) : null}
            {onToggle != null ? (
                <button
                    type="button"
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-4 text-muted hover:bg-hover hover:text-primary"
                    aria-expanded={open}
                    aria-label={name}
                    onClick={onToggle}
                    data-testid="reviews-owners-group-toggle"
                >
                    <i
                        className={cn("fa fa-solid text-10", open ? "fa-chevron-down" : "fa-chevron-right")}
                        aria-hidden
                    />
                </button>
            ) : null}
        </div>
    );
}

// The calm line under the list: what the filter hides and waits for the developer (FR-REV-034 AC6).
export function OthersWaitLine({
    local,
    elsewhere = [],
    revealed,
    onToggle,
    onOpenProject,
}: {
    // The hidden pull requests that wait for the developer in this project, and in the workspace's other projects: the
    // line counts them all and names the other projects (FR-REV-034 with FR-SHELL-087).
    local: number;
    elsewhere?: ElsewhereWaits[];
    revealed: boolean;
    onToggle: () => void;
    onOpenProject?: (projectId: string) => void;
}) {
    const t = useT();
    const tc = useTCount();
    const count = local + elsewhere.reduce((sum, e) => sum + e.count, 0);
    if (count <= 0) {
        return null;
    }
    return (
        <div
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-6 border border-dashed border-border bg-white/[0.02] px-3 py-2 text-13 text-secondary"
            role="status"
            data-testid="reviews-owners-waits"
            data-count={count}
        >
            <i className="fa fa-solid fa-circle-exclamation text-12 text-[var(--mt-state-waiting)]" aria-hidden />
            <span>{tc("reviews.owners.waits", count, { count })}</span>
            {elsewhere.length > 0 ? (
                <span className="text-muted">
                    {"· "}
                    {elsewhere.map((e, i) => (
                        <span key={e.projectId}>
                            {i > 0 ? ", " : ""}
                            <button
                                type="button"
                                className="cursor-pointer text-muted hover:text-primary hover:underline"
                                title={t("reviews.owners.openProject", { project: e.label })}
                                onClick={() => onOpenProject?.(e.projectId)}
                                data-testid="reviews-owners-waits-project"
                                data-project={e.projectId}
                            >
                                {t("reviews.owners.inProject", { count: e.count, project: e.label })}
                            </button>
                        </span>
                    ))}
                </span>
            ) : null}
            <span className="grow" />
            {local > 0 ? (
                <button
                    type="button"
                    className="cursor-pointer text-accent hover:underline"
                    onClick={onToggle}
                    aria-pressed={revealed}
                    data-testid="reviews-owners-waits-toggle"
                >
                    {revealed ? t("reviews.owners.waitsHide") : t("reviews.owners.waitsShow")}
                </button>
            ) : null}
        </div>
    );
}
