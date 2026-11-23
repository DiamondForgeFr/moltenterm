// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The emblem picker (FR-SHELL-158, #2476): Lucide's icons (the selection of emblem-catalog.ts), searched as the developer
// types, never an emoji. It opens on a few suggestions; the grid is one radio group with a single tab stop, moved with the
// arrow keys.

import { cn } from "@/util/util";
import { useMemo, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { Emblem } from "./emblem";
import { EmblemCatalog } from "./emblem-catalog";
import { EmblemColumns, gridMove, matchEmblems } from "./emblem-model";

const Names = Object.keys(EmblemCatalog);

export function EmblemPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
    const t = useT();
    const [query, setQuery] = useState("");
    const gridRef = useRef<HTMLDivElement>(null);
    const matches = useMemo(() => matchEmblems(Names, query), [query]);
    // The one tab stop: the chosen emblem when it shows, else the first.
    const stop = matches.shown.includes(value) ? value : (matches.shown[0] ?? "");

    const onKeyDown = (e: React.KeyboardEvent) => {
        const buttons = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-emblem]") ?? []);
        const at = buttons.findIndex((b) => b === document.activeElement);
        const to = at < 0 ? null : gridMove(at, e.key, EmblemColumns, buttons.length);
        if (to == null) {
            return;
        }
        e.preventDefault();
        buttons[to].focus();
    };

    return (
        <div className="flex flex-col gap-2" data-testid="emblem-picker">
            <input
                type="search"
                value={query}
                aria-label={t("contexts.emblem.search")}
                placeholder={t("contexts.emblem.searchPlaceholder")}
                data-testid="emblem-search"
                className="h-8 rounded-4 border border-border bg-black/25 px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent"
                onChange={(e) => setQuery(e.target.value)}
            />
            {matches.shown.length === 0 ? (
                <p className="py-3 text-12 text-muted">{t("contexts.emblem.none", { query: query.trim() })}</p>
            ) : (
                <div
                    ref={gridRef}
                    role="radiogroup"
                    aria-label={t("contexts.emblem.choose")}
                    className="grid max-h-44 gap-1 overflow-y-auto"
                    style={{ gridTemplateColumns: `repeat(${EmblemColumns}, minmax(0, 1fr))` }}
                    onKeyDown={onKeyDown}
                >
                    {matches.shown.map((name) => (
                        <button
                            key={name}
                            type="button"
                            role="radio"
                            aria-checked={name === value}
                            aria-label={name}
                            title={name}
                            data-emblem={name}
                            tabIndex={name === stop ? 0 : -1}
                            className={cn(
                                "flex h-8 cursor-pointer items-center justify-center rounded-4 border border-transparent text-secondary hover:bg-hover hover:text-primary",
                                name === value && "border-accent bg-hover text-primary"
                            )}
                            onClick={() => onChange(name)}
                        >
                            <Emblem name={name} size={16} />
                        </button>
                    ))}
                </div>
            )}
            {matches.hidden > 0 ? (
                <p className="text-11 text-muted">{t("contexts.emblem.more", { count: matches.hidden })}</p>
            ) : null}
        </div>
    );
}
