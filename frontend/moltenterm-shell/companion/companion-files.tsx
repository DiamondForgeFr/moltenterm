// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The files the agent changed in the session (FR-SHELL-018, #555, #2441), as a block of the dashboard: the project's
// files by their path relative to it (the folder quiet, the name bright), six then "Show all", then the files outside
// the project grouped last and tagged. The filter in the block's tools narrows the list as you type. Each file shows
// its diff and opens in the preview at its first change.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { DominoLoader } from "../suite/suite";
import { MoreButton } from "./companion-block";
import { fileGroups, filterFiles, ShownFile } from "./companion-files-model";
import {
    CompanionDiff,
    CompanionDiffCommand,
    CompanionFile,
    CompanionRoute,
    diffLineKind,
    firstChangedLine,
} from "./companion-model";
import { openChangedFile } from "./companion-open";
import { useCompanionPref } from "./companion-prefs";

const RpcTimeoutMs = 5000;
// The project's files the block lists before "Show all".
export const FilesShown = 6;

function diffCall(target: string, path: string): Promise<CompanionDiff> {
    return TabRpcClient.wshRpcCall(
        CompanionDiffCommand,
        { blockid: target, path },
        { route: CompanionRoute, timeout: RpcTimeoutMs }
    );
}

const KindLabels: Record<string, { text: string; titleKey: string }> = {
    add: { text: "A", titleKey: "companion.files.added" },
    update: { text: "M", titleKey: "companion.files.modified" },
    delete: { text: "D", titleKey: "companion.files.deleted" },
};

export type FilesFrame = (parts: { tools: React.ReactNode; body: React.ReactNode; count: number }) => React.ReactNode;

export function FilesSection({
    target,
    companionId,
    files,
    folder,
    home,
    frame,
}: {
    target: string;
    companionId: string;
    files: CompanionFile[];
    folder: string;
    // The home folder, for the files outside the project.
    home?: string;
    frame: FilesFrame;
}) {
    const t = useT();
    const [all, setAll] = useCompanionPref("filesopen");
    const [filtering, setFiltering] = useState(false);
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState<string>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const count = files?.length ?? 0;
    const matched = filterFiles(files, query, folder);
    const groups = fileGroups(matched, folder, home ?? "");
    const capped = !all && !query && groups.inside.length > FilesShown + 1;
    const inside = capped ? groups.inside.slice(0, FilesShown) : groups.inside;
    useEffect(() => {
        if (filtering) {
            inputRef.current?.focus();
        }
    }, [filtering]);
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (query) {
                setQuery("");
            } else {
                setFiltering(false);
            }
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            listRef.current?.querySelector<HTMLButtonElement>("button[data-file-toggle]")?.focus();
            return;
        }
        if (e.key === "Enter" && matched.length > 0) {
            e.preventDefault();
            setOpen(open === matched[0].path ? null : matched[0].path);
        }
    };
    const row = (f: ShownFile) => (
        <FileRow
            key={f.file.path}
            target={target}
            companionId={companionId}
            shown={f}
            open={open === f.file.path}
            onToggle={() => setOpen(open === f.file.path ? null : f.file.path)}
        />
    );
    const tools =
        count > 0 ? (
            <button
                type="button"
                className="mt-cb-tool"
                aria-label={t("companion.files.filterLabel")}
                title={t("companion.files.filterLabel")}
                aria-pressed={filtering}
                onClick={(e) => {
                    e.stopPropagation();
                    setFiltering(!filtering);
                    if (filtering) {
                        setQuery("");
                    }
                }}
                data-testid="companion-files-toggle"
            >
                <i className="fa fa-solid fa-magnifying-glass" aria-hidden="true" />
            </button>
        ) : null;
    const body =
        count === 0 ? (
            <div className="mt-cb-empty" data-testid="companion-files-section">
                {t("companion.files.none")}
            </div>
        ) : (
            <div className="flex flex-col gap-2" data-testid="companion-files-section">
                {filtering ? (
                    <input
                        ref={inputRef}
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder={t("companion.files.filter")}
                        aria-label={t("companion.files.filterLabel")}
                        spellCheck={false}
                        className="mt-cdash-filter"
                        data-testid="companion-files-filter"
                    />
                ) : null}
                {matched.length === 0 ? (
                    <div className="mt-cb-empty">{t("companion.files.noMatch")}</div>
                ) : (
                    <div ref={listRef} className="mt-cwork-flush" data-bare="" data-testid="companion-files">
                        {inside.map(row)}
                        {groups.inside.length > FilesShown + 1 && !query ? (
                            <MoreButton
                                more={groups.inside.length - inside.length}
                                open={all}
                                onToggle={() => setAll(!all)}
                                label={t("companion.dash.filesAll", { count: groups.inside.length })}
                                lessLabel={t("companion.dash.showLess")}
                                testId="companion-files-all"
                            />
                        ) : null}
                        {groups.outside.length > 0 ? (
                            <section data-testid="companion-files-outside">
                                <div className="mt-cwork-sec mt-cdash-sec-top">
                                    <span>{t("companion.dash.outside")}</span>
                                    <span className="mt-cwork-n">{groups.outside.length}</span>
                                </div>
                                {groups.outside.map(row)}
                            </section>
                        ) : null}
                    </div>
                )}
            </div>
        );
    return <>{frame({ tools, body, count })}</>;
}

function FileRow({
    target,
    companionId,
    shown,
    open,
    onToggle,
}: {
    target: string;
    companionId: string;
    shown: ShownFile;
    open: boolean;
    onToggle: () => void;
}) {
    const t = useT();
    const file = shown.file;
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
        <div className="mt-cdash-file" data-testid="companion-file" data-outside={shown.outside ? "" : undefined}>
            <div className="mt-cdash-frow">
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggle();
                    }}
                    className="mt-cdash-fbutton"
                    title={shown.dir + shown.name}
                    aria-expanded={open}
                    data-file-toggle=""
                >
                    <span className="mt-cdash-fkind" data-kind={file.kind} title={t(kind.titleKey)}>
                        {kind.text}
                    </span>
                    <span className="mt-cdash-fpath">
                        <span className="mt-cdash-fdir">{shown.dir}</span>
                        <span className="mt-cdash-fname">{shown.name}</span>
                    </span>
                </button>
                {shown.outside ? <span className="mt-cdash-tag">{t("companion.dash.outsideTag")}</span> : null}
                <span className="mt-cdash-fdelta">
                    <span data-add="">+{file.added}</span> <span data-del="">−{file.removed}</span>
                </span>
                {file.kind !== "delete" ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            openAtChange();
                        }}
                        className="mt-cb-tool mt-cdash-fopen"
                        title={t("companion.files.open")}
                        aria-label={t("companion.files.openPath", { path: shown.dir + shown.name })}
                    >
                        <i className="fa fa-solid fa-arrow-up-right-from-square" aria-hidden="true" />
                    </button>
                ) : null}
            </div>
            {open ? <FileDiffView target={target} path={file.path} edits={file.edits} /> : null}
        </div>
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
        return <div className="px-(--mt-companion-inset) pb-2 text-12 text-danger">{error}</div>;
    }
    if (diff == null) {
        return (
            <div className="px-(--mt-companion-inset) pb-2 text-12 text-muted">
                <DominoLoader className="mr-1.5" />
                {t("companion.loading")}
            </div>
        );
    }
    const lines = diff.diff ? diff.diff.replace(/\n$/, "").split("\n") : [];
    return (
        <div
            className="mx-(--mt-companion-inset) mb-2 overflow-x-auto rounded-4 border border-border bg-black/20"
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
    del: "bg-error/10 text-danger",
    hunk: "text-accent/80",
    meta: "text-muted",
    ctx: "text-secondary",
};
