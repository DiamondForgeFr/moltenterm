// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// One row of the command palette and of the new view chooser (FR-SHELL-013, FR-SHELL-089): the entry's icon, its label
// with the typed letters highlighted, the hidden search word a result was found through (#2312), its detail and the
// key or command at the right.

import { cn, makeIconClass } from "@/util/util";
import React from "react";
import { EngineMark } from "../browser/engine-mark";
import { FaviconMark } from "../favicon/favicon-mark";
import { ViewCube } from "../sidebar/view-cube";
import { isGlyphCube, isGlyphFavicon } from "../sidebar/view-menu-model";
import { WorkspaceIcon } from "../workspace-icon";
import { entryMatch, highlightRuns, PaletteEntry } from "./palette-model";

export function Highlighted({ text, indices }: { text: string; indices: number[] }) {
    if (!indices?.length) {
        return <>{text}</>;
    }
    return (
        <>
            {highlightRuns(text, indices).map((run, i) =>
                run.hit ? (
                    <span key={i} className="text-accent" data-role="palette-hit">
                        {run.text}
                    </span>
                ) : (
                    <React.Fragment key={i}>{run.text}</React.Fragment>
                )
            )}
        </>
    );
}

export type PaletteRowProps = {
    entry: PaletteEntry;
    index: number;
    selected: boolean;
    query: string;
    onHover: (index: number) => void;
    onOpen: (entry: PaletteEntry, right: boolean) => void;
};

export function PaletteRow({ entry, index, selected, query, onHover, onOpen }: PaletteRowProps) {
    const match = query && entry.group !== "web" ? entryMatch(query, entry) : null;
    const indices = match?.indices ?? [];
    const aside = [entry.keyPath ?? entry.cli ?? entry.hint, entry.shortcut].filter((s) => s).join("  ·  ");
    return (
        <div
            role="option"
            aria-selected={selected}
            data-index={index}
            data-entry={entry.id}
            onMouseMove={() => onHover(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => onOpen(entry, e.altKey || e.metaKey)}
            title={entry.cli && !entry.keyPath ? `${entry.label} — ${entry.cli}` : entry.label}
            className={cn(
                "flex cursor-pointer items-center gap-2.5 px-3.5 py-1.5 text-13",
                selected ? "molten-palette-selected text-primary" : "text-secondary"
            )}
        >
            {entry.badge?.image || entry.badge?.logo ? (
                <span className="flex w-4 shrink-0 items-center justify-center" data-role="palette-workspace-badge">
                    <WorkspaceIcon source={entry.badge} className="text-11" />
                </span>
            ) : entry.mark ? (
                <EngineMark letters={entry.mark} />
            ) : (
                <i
                    className={cn(
                        makeIconClass(entry.icon, true, { defaultIcon: "browser" }),
                        "w-4 shrink-0 text-center",
                        entry.color && "molten-glyph-tone"
                    )}
                    style={entry.color ? ({ "--mt-glyph-color": entry.color } as React.CSSProperties) : undefined}
                />
            )}
            <span className="shrink-0 whitespace-nowrap" data-role="palette-label">
                <Highlighted text={entry.label} indices={indices} />
            </span>
            {match?.keyword ? (
                <span className="shrink-0 whitespace-nowrap text-12 text-muted" data-role="palette-keyword">
                    {"· "}
                    <Highlighted text={match.keyword} indices={match.keywordIndices} />
                </span>
            ) : null}
            {entry.panelIcons?.length ? (
                <span className="flex shrink-0 items-center gap-1 text-11 text-muted" aria-hidden>
                    {entry.panelIcons.map((icon, i) =>
                        isGlyphCube(icon) ? (
                            <ViewCube key="cube" cube={icon} small />
                        ) : isGlyphFavicon(icon) ? (
                            <FaviconMark key={i} url={icon.url} dark={icon.dark} />
                        ) : (
                            <i key={i} className={makeIconClass(icon, true)} />
                        )
                    )}
                </span>
            ) : null}
            {entry.detail && (
                <span className="min-w-0 truncate text-12 text-muted" data-role="palette-detail">
                    <Highlighted text={entry.detail} indices={match?.detailIndices} />
                </span>
            )}
            {aside && (
                <span
                    className={cn(
                        "ml-auto max-w-[45%] shrink-0 truncate pl-3 font-mono text-11",
                        selected ? "text-secondary" : "text-muted"
                    )}
                >
                    {aside}
                </span>
            )}
        </div>
    );
}
