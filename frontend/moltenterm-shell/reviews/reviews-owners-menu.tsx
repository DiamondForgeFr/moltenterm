// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The menu of the Integration panel's owners bar (FR-REV-034, #2174), loaded when the developer opens it (#2194).

import { cn } from "@/util/util";
import { useEffect, useRef } from "react";
import { useT } from "../i18n/i18n";
import type { OwnerCount } from "./reviews-owners";
import { foldName } from "./reviews-owners-model";
import type { ViewScopeState } from "./reviews-owners-store";

// The menu of owners: each agent that owns work in the list, to follow or not, one or several at once.
export function OwnersMenu({
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
