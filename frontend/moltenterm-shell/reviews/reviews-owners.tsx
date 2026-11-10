// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Integration panel's owners (FR-REV-034, #2174): the bar that says whose work the view shows (the followed agents
// as chips, the proposal for an agent that joined, the count hidden), the owner on each card, the groups of work in
// progress under their lead, and the calm line for what outside the filter waits for the developer.

import { cn } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import type { ChainEdge } from "../agent-chain-store";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { foldName, OwnerFacts, ScopeChip, scopeChips } from "./reviews-owners-model";
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

function FollowedChip({ chip, onRemove }: { chip: ScopeChip; onRemove: () => void }) {
    const t = useT();
    const tc = useTCount();
    return (
        <span
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-accent/60 bg-accent/10 pr-1 pl-1 text-12 text-primary"
            title={t("reviews.owners.chipTitle", { name: chip.name })}
            data-testid="reviews-owners-chip"
            data-agent={chip.name}
        >
            <Initial name={chip.name} />
            <span>{chip.name}</span>
            {chip.subs > 0 ? (
                <span className="text-muted" data-testid="reviews-owners-chip-subs">
                    {tc("reviews.owners.chipSubs", chip.subs, { count: chip.subs })}
                </span>
            ) : null}
            <button
                type="button"
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hover hover:text-primary"
                aria-label={t("reviews.owners.chipRemove", { name: chip.name })}
                title={t("reviews.owners.chipRemove", { name: chip.name })}
                onClick={onRemove}
                data-testid="reviews-owners-chip-remove"
            >
                <i className="fa fa-solid fa-xmark text-10" aria-hidden />
            </button>
        </span>
    );
}

function ProposalChip({ name, onAdd, onIgnore }: { name: string; onAdd: () => void; onIgnore: () => void }) {
    const t = useT();
    return (
        <span
            className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border pr-1 pl-2.5 text-12 text-secondary"
            title={t("reviews.owners.proposeTitle", { name })}
            data-testid="reviews-owners-proposal"
            data-agent={name}
        >
            <span>{t("reviews.owners.propose", { name })}</span>
            <button
                type="button"
                className="molten-btn flex h-5 cursor-pointer items-center rounded-full px-2 text-11"
                onClick={onAdd}
                data-testid="reviews-owners-proposal-add"
            >
                {t("reviews.owners.add")}
                <MoltenWave />
            </button>
            <button
                type="button"
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hover hover:text-primary"
                aria-label={t("reviews.owners.ignore", { name })}
                title={t("reviews.owners.ignore", { name })}
                onClick={onIgnore}
                data-testid="reviews-owners-proposal-ignore"
            >
                <i className="fa fa-solid fa-xmark text-10" aria-hidden />
            </button>
        </span>
    );
}

// The menu of owners: each agent that owns work in the list, to follow or not, one or several at once.
function OwnersMenu({
    view,
    owners,
    label,
    onClose,
}: {
    view: ViewScopeState;
    owners: OwnerCount[];
    label: string;
    onClose: () => void;
}) {
    const t = useT();
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const away = (e: MouseEvent) => {
            if (ref.current != null && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const key = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        document.addEventListener("mousedown", away);
        document.addEventListener("keydown", key);
        return () => {
            document.removeEventListener("mousedown", away);
            document.removeEventListener("keydown", key);
        };
    }, [onClose]);
    const followed = new Set(view.scope.agents.map(foldName));
    const followedOnly = view.scope.agents.filter((a) => !owners.some((o) => foldName(o.name) === foldName(a)));
    const rows: OwnerCount[] = [...owners, ...followedOnly.map((name) => ({ name, count: 0, subs: 0 }))];
    const toggle = (name: string) => {
        if (followed.has(foldName(name))) {
            view.remove([name]);
        } else if (view.scope.agents.length > 0) {
            view.add(name);
        } else {
            view.only(name);
        }
    };
    return (
        <div
            ref={ref}
            role="menu"
            aria-label={label}
            className="absolute top-8 left-0 z-20 flex min-w-[220px] flex-col rounded-4 border border-border bg-panel p-1 shadow-lg"
            data-testid="reviews-owners-menu"
        >
            {rows.length === 0 ? (
                <div className="px-2 py-1.5 text-12 text-muted">{t("reviews.owners.menuEmpty")}</div>
            ) : null}
            {rows.map((o) => {
                const on = followed.has(foldName(o.name));
                return (
                    <button
                        key={foldName(o.name)}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={on}
                        className="flex cursor-pointer items-center gap-2 rounded-4 px-2 py-1 text-left text-12 text-primary hover:bg-hover"
                        onClick={() => toggle(o.name)}
                        data-testid="reviews-owners-menu-item"
                        data-agent={o.name}
                    >
                        <i
                            className={cn("fa fa-solid fa-check w-3 text-10", on ? "text-accent" : "opacity-0")}
                            aria-hidden
                        />
                        <span>{o.name}</span>
                        {o.subs > 0 ? (
                            <span className="text-muted">{t("reviews.owners.menuItemSubs", { count: o.subs })}</span>
                        ) : null}
                        {o.count > 0 ? <span className="ml-auto text-muted tabular-nums">{o.count}</span> : null}
                    </button>
                );
            })}
            {view.scope.agents.length > 0 ? (
                <button
                    type="button"
                    role="menuitem"
                    className="mt-1 cursor-pointer border-t border-border px-2 pt-1.5 pb-1 text-left text-12 text-accent hover:underline"
                    onClick={() => {
                        view.showAll();
                        onClose();
                    }}
                    data-testid="reviews-owners-menu-all"
                >
                    {t("reviews.owners.showAll")}
                </button>
            ) : null}
        </div>
    );
}

export function OwnersBar({
    view,
    edges,
    owners,
    hidden,
}: {
    view: ViewScopeState;
    edges: readonly ChainEdge[];
    owners: OwnerCount[];
    // The pull requests the filter hides in the project(s) the bar counts.
    hidden: number;
}) {
    const t = useT();
    const tc = useTCount();
    const [menu, setMenu] = useState(false);
    const on = view.scope.agents.length > 0;
    const chips = scopeChips(view.scope, edges);
    const label = t("reviews.owners.menuAria");
    return (
        <div
            className="relative flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
            role="group"
            aria-label={t("reviews.owners.bar")}
            data-testid="reviews-owners-bar"
            data-filtered={on ? "true" : "false"}
        >
            <span className="text-11 font-semibold tracking-[0.08em] text-muted uppercase">
                {t("reviews.owners.label")}
            </span>
            {chips.map((chip) => (
                <FollowedChip key={foldName(chip.name)} chip={chip} onRemove={() => view.remove([chip.name])} />
            ))}
            <span className="relative">
                <button
                    type="button"
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                    aria-haspopup="menu"
                    aria-expanded={menu}
                    aria-label={label}
                    onClick={() => setMenu((v) => !v)}
                    data-testid="reviews-owners-menu-button"
                >
                    {on ? t("reviews.owners.change") : t("reviews.owners.all", { count: owners.length })}
                    <i className="fa fa-solid fa-chevron-down text-10" aria-hidden />
                </button>
                {menu ? <OwnersMenu view={view} owners={owners} label={label} onClose={() => setMenu(false)} /> : null}
            </span>
            {view.proposed.map((name) => (
                <ProposalChip
                    key={foldName(name)}
                    name={name}
                    onAdd={() => view.add(name)}
                    onIgnore={() => view.ignore(name)}
                />
            ))}
            {!on && view.proposed.length === 0 && view.present.length === 0 ? (
                <span className="text-12 text-muted" data-testid="reviews-owners-none">
                    {t("reviews.owners.noAgents")}
                </span>
            ) : null}
            <span className="grow" />
            {on && hidden > 0 ? (
                <span className="text-12 text-secondary" data-testid="reviews-owners-hidden">
                    {tc("reviews.owners.hidden", hidden, { count: hidden })}
                    {" · "}
                    <button
                        type="button"
                        className="cursor-pointer text-accent hover:underline"
                        onClick={view.showAll}
                        data-testid="reviews-owners-show-all"
                    >
                        {t("reviews.owners.showAll")}
                    </button>
                </span>
            ) : null}
        </div>
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
