// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The files the agent changed in the session (FR-SHELL-018), at the bottom of the companion and collapsed by default
// (#555): the count shows; expanded, a filter field narrows the list as you type. Each file shows its diff and opens
// in the preview at its first change.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { filterFiles } from "./companion-files-model";
import {
    CompanionDiff,
    CompanionDiffCommand,
    CompanionFile,
    CompanionRoute,
    diffLineKind,
    displayPath,
    firstChangedLine,
} from "./companion-model";
import { openChangedFile } from "./companion-open";
import { useCompanionPref } from "./companion-prefs";

const RpcTimeoutMs = 5000;

function diffCall(target: string, path: string): Promise<CompanionDiff> {
    return TabRpcClient.wshRpcCall(
        CompanionDiffCommand,
        { blockid: target, path },
        { route: CompanionRoute, timeout: RpcTimeoutMs }
    );
}

const KindLabels: Record<string, { text: string; className: string; titleKey: string }> = {
    add: { text: "A", className: "text-success", titleKey: "companion.files.added" },
    update: { text: "M", className: "text-warning", titleKey: "companion.files.modified" },
    delete: { text: "D", className: "text-error", titleKey: "companion.files.deleted" },
};

export function FilesSection({
    target,
    companionId,
    files,
    folder,
}: {
    target: string;
    companionId: string;
    files: CompanionFile[];
    folder: string;
}) {
    const t = useT();
    const [listOpen, setListOpen] = useCompanionPref("filesopen");
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState<string>(null);
    const [focusOnOpen, setFocusOnOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const count = files?.length ?? 0;
    const shown = filterFiles(files, query, folder);
    useEffect(() => {
        if (listOpen && focusOnOpen) {
            inputRef.current?.focus();
            setFocusOnOpen(false);
        }
    }, [listOpen, focusOnOpen]);
    const toggleList = () => {
        setFocusOnOpen(!listOpen);
        setListOpen(!listOpen);
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Escape") {
            if (query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
            }
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            listRef.current?.querySelector<HTMLButtonElement>("button[data-file-toggle]")?.focus();
            return;
        }
        if (e.key === "Enter" && shown.length > 0) {
            e.preventDefault();
            setOpen(open === shown[0].path ? null : shown[0].path);
        }
    };
    return (
        <section aria-label={t("companion.files.title")} className="pb-3" data-testid="companion-files-section">
            <button
                type="button"
                onClick={toggleList}
                aria-expanded={listOpen}
                className="flex w-full cursor-pointer items-center gap-2 px-3 pt-3 pb-1 text-left hover:text-primary"
                data-testid="companion-files-toggle"
            >
                <i
                    className={cn(
                        "fa fa-solid fa-fw text-11 text-muted",
                        listOpen ? "fa-chevron-down" : "fa-chevron-right"
                    )}
                    aria-hidden="true"
                />
                <span className="text-11 font-semibold tracking-wide text-muted uppercase">
                    {t("companion.files.title")}
                </span>
                <span className="ml-auto text-11 text-muted tabular-nums" data-testid="companion-files-count">
                    {count}
                </span>
            </button>
            {!listOpen ? null : count === 0 ? (
                <div className="px-3 text-12 text-muted">{t("companion.files.none")}</div>
            ) : (
                <>
                    <div className="px-3 pb-1">
                        <input
                            ref={inputRef}
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder={t("companion.files.filter")}
                            aria-label={t("companion.files.filterLabel")}
                            spellCheck={false}
                            className="w-full rounded-4 border border-border bg-transparent px-2 py-1 font-mono text-12 text-primary outline-none placeholder:text-muted focus:border-accent/70"
                            data-testid="companion-files-filter"
                        />
                    </div>
                    {shown.length === 0 ? (
                        <div className="px-3 text-12 text-muted">{t("companion.files.noMatch")}</div>
                    ) : (
                        <ul ref={listRef} className="flex flex-col px-1" data-testid="companion-files">
                            {shown.map((f) => (
                                <FileRow
                                    key={f.path}
                                    target={target}
                                    companionId={companionId}
                                    file={f}
                                    folder={folder}
                                    open={open === f.path}
                                    onToggle={() => setOpen(open === f.path ? null : f.path)}
                                />
                            ))}
                        </ul>
                    )}
                </>
            )}
        </section>
    );
}

function FileRow({
    target,
    companionId,
    file,
    folder,
    open,
    onToggle,
}: {
    target: string;
    companionId: string;
    file: CompanionFile;
    folder: string;
    open: boolean;
    onToggle: () => void;
}) {
    const t = useT();
    const kind = KindLabels[file.kind] ?? KindLabels.update;
    // The preview opens at the line the first change of the file starts.
    const openAtChange = () =>
        fireAndForget(async () => {
            let line = 0;
            try {
                line = firstChangedLine((await diffCall(target, file.path))?.diff);
            } catch {
                // Without its diff the file still opens, at its top.
            }
            openChangedFile(file.path, line, companionId);
        });
    return (
        <li className="flex flex-col">
            <div className="group flex items-center gap-2 rounded-6 px-2 py-1 hover:bg-hover">
                <button
                    type="button"
                    onClick={onToggle}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    title={file.path}
                    aria-expanded={open}
                    data-file-toggle=""
                >
                    <i
                        className={cn(
                            "fa fa-solid fa-fw text-11 text-muted",
                            open ? "fa-chevron-down" : "fa-chevron-right"
                        )}
                    />
                    <span
                        className={cn("w-3 shrink-0 font-mono text-11 font-semibold", kind.className)}
                        title={t(kind.titleKey)}
                    >
                        {kind.text}
                    </span>
                    <span className="truncate font-mono text-12 text-primary">{displayPath(file.path, folder)}</span>
                </button>
                <span className="shrink-0 font-mono text-11 tabular-nums">
                    <span className="text-success">+{file.added}</span>{" "}
                    <span className="text-error">−{file.removed}</span>
                </span>
                {file.kind !== "delete" ? (
                    <button
                        type="button"
                        onClick={openAtChange}
                        className="cursor-pointer rounded-6 px-1 text-11 text-secondary hover:text-primary"
                        title={t("companion.files.open")}
                        aria-label={t("companion.files.openPath", { path: file.path })}
                    >
                        <i className="fa fa-solid fa-arrow-up-right-from-square" />
                    </button>
                ) : null}
            </div>
            {open ? <FileDiffView target={target} path={file.path} edits={file.edits} /> : null}
        </li>
    );
}

// The diff is fetched when opened, and again when the agent edits the file once more.
function FileDiffView({ target, path, edits }: { target: string; path: string; edits: number }) {
    const t = useT();
    const [diff, setDiff] = useState<CompanionDiff>(null);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const d = await diffCall(target, path);
                if (!cancelled) {
                    setDiff(d);
                    setError(null);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(serverErrorText(e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [target, path, edits]);
    if (error) {
        return <div className="px-3 text-12 text-error">{error}</div>;
    }
    if (diff == null) {
        return <div className="px-3 text-12 text-muted">{t("companion.loading")}</div>;
    }
    const lines = diff.diff ? diff.diff.replace(/\n$/, "").split("\n") : [];
    return (
        <div
            className="mx-2 mb-2 overflow-x-auto rounded-4 border border-border bg-black/20"
            data-testid="companion-diff"
        >
            {diff.truncated ? (
                <div className="px-2 py-1 text-11 text-muted">{t("companion.files.truncated")}</div>
            ) : null}
            {lines.length === 0 ? (
                <div className="px-2 py-1 text-11 text-muted">{t("companion.files.noDiff")}</div>
            ) : null}
            <pre className="m-0 py-1 font-mono text-11 leading-[1.45]">
                {lines.map((line, i) => (
                    <div key={i} className={cn("px-2 whitespace-pre", DiffLineClasses[diffLineKind(line)])}>
                        {line || " "}
                    </div>
                ))}
            </pre>
        </div>
    );
}

const DiffLineClasses: Record<string, string> = {
    add: "bg-success/10 text-success",
    del: "bg-error/10 text-error",
    hunk: "text-accent/80",
    meta: "text-muted",
    ctx: "text-secondary",
};
