// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The favourites row on top of the new view chooser (FR-SHELL-089, DS-SHELL-128): 2 to 4 equal, flat choices, the
// selected one in the accent, each with its direct shortcut.

import { cn, makeIconClass } from "@/util/util";
import type React from "react";
import { useT } from "../i18n/i18n";
import type { PaletteEntry } from "../palette/palette-model";

type FavoritesRowProps = {
    favorites: PaletteEntry[];
    // Each favourite's direct shortcut as shown ("⌥⌘1"), by position.
    keys: string[];
    // -1: the selection is in the list below.
    selected: number;
    onHover: (index: number) => void;
    onOpen: (entry: PaletteEntry) => void;
};

export function FavoritesRow({ favorites, keys, selected, onHover, onOpen }: FavoritesRowProps) {
    const t = useT();
    if (!favorites?.length) {
        return null;
    }
    return (
        <div
            role="listbox"
            aria-label={t("newView.favoritesAria")}
            data-testid="new-view-favorites"
            className="grid gap-2 px-3.5 pt-3 pb-2.5"
            style={{ gridTemplateColumns: `repeat(${favorites.length}, minmax(0, 1fr))` }}
        >
            {favorites.map((entry, i) => {
                const on = i === selected;
                return (
                    <div
                        key={entry.id}
                        role="option"
                        aria-selected={on}
                        data-testid="new-view-favorite"
                        data-favorite={entry.id}
                        data-mt-shortcut={keys[i] ? "new-view-favorite" : undefined}
                        data-mt-shortcut-n={keys[i] ? i + 1 : undefined}
                        onMouseMove={() => onHover(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onOpen(entry)}
                        title={entry.label}
                        className={cn(
                            "flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-6 border px-2 pt-3 pb-2 transition-colors duration-120",
                            on
                                ? "border-accent bg-accent/10 text-primary"
                                : "border-border bg-surface-2 text-secondary hover:bg-white/[0.06] hover:text-primary"
                        )}
                    >
                        <i
                            className={cn(
                                makeIconClass(entry.icon, true, { defaultIcon: "browser" }),
                                "text-15",
                                on ? "text-accent" : entry.color && "molten-glyph-tone"
                            )}
                            style={
                                !on && entry.color
                                    ? ({ "--mt-glyph-color": entry.color } as React.CSSProperties)
                                    : undefined
                            }
                        />
                        <span className="max-w-full truncate text-13">{entry.label}</span>
                        {keys[i] ? <span className="font-mono text-11 text-muted">{keys[i]}</span> : null}
                    </div>
                );
            })}
        </div>
    );
}
