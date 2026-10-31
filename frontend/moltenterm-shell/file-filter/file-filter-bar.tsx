// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useT } from "../i18n/i18n";
import { FileFilter, fileFilterSetBy, FileSearchMaxMatches } from "./file-filter";

export type FileFilterBarProps = {
    // The pattern shown ("" while the developer is about to type one).
    search: string;
    filter: FileFilter;
    truncated: boolean;
    onClear: () => void;
};

// The file panel's filter field (FR-FILE-002 AC-6): the pattern, who set it when it was not the developer, and the
// way to clear it. The developer edits it by typing in the panel; Esc clears it too.
export function FileFilterBar({ search, filter, truncated, onClear }: FileFilterBarProps) {
    const t = useT();
    const setBy = fileFilterSetBy(t, filter);
    let text = t("wave.files.searchHint");
    if (search !== "") {
        text = filter?.recursive
            ? t("fileFilter.searchingRecursive", { search })
            : t("wave.files.searching", { search });
    }
    return (
        <div
            className="flex items-center gap-2 rounded-4 py-1 px-2 bg-warning text-[var(--mt-state-warning-fg)]"
            data-testid="file-filter-bar"
        >
            <span className="min-w-0 truncate">{text}</span>
            {setBy && (
                <span
                    className="shrink-0 rounded-4 border border-current/40 px-1.5 text-11 font-medium leading-[16px]"
                    data-testid="file-filter-setby"
                >
                    {setBy}
                </span>
            )}
            {truncated && (
                <span className="shrink-0 text-11 opacity-80" data-testid="file-filter-truncated">
                    {t("fileFilter.truncated", { count: FileSearchMaxMatches })}
                </span>
            )}
            <button
                type="button"
                aria-label={t("fileFilter.clear")}
                title={t("fileFilter.clear")}
                className={cn(
                    "ml-auto flex shrink-0 cursor-pointer items-center justify-center rounded-4 border-none bg-transparent p-0.5 text-inherit",
                    "hover:bg-hoverbg focus:bg-hoverbg"
                )}
                onClick={onClear}
            >
                <i className="fa-solid fa-xmark" />
            </button>
        </div>
    );
}
