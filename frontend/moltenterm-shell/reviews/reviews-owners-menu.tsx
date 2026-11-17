// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The menu of the Integration panel's owners filter (FR-REV-034, #2174, #2207), loaded when the developer opens it
// (#2194). It hangs from the header's funnel button: the owners to follow or not, the agents that joined the view and
// wait for an answer, and, while a filter is on, what it hides and the way back to everything.

import { cn } from "@/util/util";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import type { OwnerCount } from "./reviews-owners";
import { OwnersMenuAnchor, OwnersTriggerSelector } from "./reviews-owners-filter";
import { foldName } from "./reviews-owners-model";
import type { ViewScopeState } from "./reviews-owners-store";

const EdgeMarginPx = 8;
const BelowButtonPx = 4;

// An agent that joined the view: nothing changes until the developer adds it; ignoring it removes the proposal for good
// in this view (FR-REV-034 AC4).
function ProposalRow({ name, onAdd, onIgnore }: { name: string; onAdd: () => void; onIgnore: () => void }) {
    const t = useT();
    return (
        <div
            className="flex items-center gap-2 rounded-4 px-2 py-1 text-12 text-secondary"
            title={t("reviews.owners.proposeTitle", { name })}
            data-testid="reviews-owners-proposal"
            data-agent={name}
        >
            <span className="mr-auto">{t("reviews.owners.propose", { name })}</span>
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
        </div>
    );
}

// The menu of owners: each agent that owns work in the list, to follow or not, one or several at once.
export function OwnersMenu({
    view,
    owners,
    hidden,
    label,
    anchor,
    onClose,
}: {
    view: ViewScopeState;
    owners: OwnerCount[];
    // The pull requests the filter hides in the project(s) the list counts.
    hidden: number;
    label: string;
    anchor: OwnersMenuAnchor;
    onClose: () => void;
}) {
    const t = useT();
    const tc = useTCount();
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const away = (e: MouseEvent) => {
            const target = e.target as Element;
            if (ref.current != null && !ref.current.contains(target) && !target.closest?.(OwnersTriggerSelector)) {
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
    // Right edge on the button's, kept inside the window; placed before the first paint.
    useLayoutEffect(() => {
        const el = ref.current;
        if (el == null) {
            return;
        }
        const left = Math.min(anchor.right - el.offsetWidth, window.innerWidth - el.offsetWidth - EdgeMarginPx);
        el.style.left = `${Math.max(EdgeMarginPx, left)}px`;
        el.style.top = `${anchor.bottom + BelowButtonPx}px`;
    });
    const followed = new Set(view.scope.agents.map(foldName));
    const followedOnly = view.scope.agents.filter((a) => !owners.some((o) => foldName(o.name) === foldName(a)));
    const rows: OwnerCount[] = [...owners, ...followedOnly.map((name) => ({ name, count: 0, subs: 0 }))];
    const on = view.scope.agents.length > 0;
    const toggle = (name: string) => {
        if (followed.has(foldName(name))) {
            view.remove([name]);
        } else if (on) {
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
            className="fixed z-[1000] flex max-h-[70vh] min-w-[220px] max-w-[calc(100vw-16px)] flex-col overflow-auto rounded-4 border border-border bg-panel p-1 shadow-lg"
            data-testid="reviews-owners-menu"
        >
            {rows.length === 0 ? (
                <div className="px-2 py-1.5 text-12 text-muted">{t("reviews.owners.menuEmpty")}</div>
            ) : null}
            {rows.map((o) => {
                const checked = followed.has(foldName(o.name));
                return (
                    <button
                        key={foldName(o.name)}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={checked}
                        className="flex cursor-pointer items-center gap-2 rounded-4 px-2 py-1 text-left text-12 text-primary hover:bg-hover"
                        onClick={() => toggle(o.name)}
                        data-testid="reviews-owners-menu-item"
                        data-agent={o.name}
                    >
                        <i
                            className={cn("fa fa-solid fa-check w-3 text-10", checked ? "text-accent" : "opacity-0")}
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
            {on ? (
                <div className="mt-1 flex flex-col border-t border-border pt-1">
                    {hidden > 0 ? (
                        <div className="px-2 py-1 text-12 text-muted" data-testid="reviews-owners-hidden">
                            {tc("reviews.owners.hidden", hidden, { count: hidden })}
                        </div>
                    ) : null}
                    <button
                        type="button"
                        role="menuitem"
                        className="cursor-pointer rounded-4 px-2 py-1 text-left text-12 text-accent hover:bg-hover hover:underline"
                        onClick={() => {
                            view.showAll();
                            onClose();
                        }}
                        data-testid="reviews-owners-menu-all"
                    >
                        {t("reviews.owners.showAll")}
                    </button>
                </div>
            ) : null}
            {view.proposed.length > 0 ? (
                <div className="mt-1 flex flex-col border-t border-border pt-1" role="group">
                    {view.proposed.map((name) => (
                        <ProposalRow
                            key={foldName(name)}
                            name={name}
                            onAdd={() => view.add(name)}
                            onIgnore={() => view.ignore(name)}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    );
}
