// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The settings screen (FR-SHELL-050, DS-SHELL-091): the sections on the left, a search over label, key and
// description, and on the right the rows of a section, each with its label, a one-line description, its control and a
// reset when changed. A change writes settings.json through SetConfigCommand, as an edit of the file would; the
// workspace's own settings write its meta and carry a pill with its name. Advanced lists the JSON files, which open
// in Wave's editor in place (settings-view.tsx).

import { atoms, getApi, globalStore } from "@/app/store/global";
import { isMacOS } from "@/util/platformutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { writeSettings } from "../command-panel/bindings";
import "../command-panel/command-panel.css";
import { themeOptions } from "../command-panel/providers/terminal";
import { EmptyState } from "../empty-state";
import { platformShortcuts } from "../shortcuts/registry";
import { filterShortcuts } from "../shortcuts/shortcuts-search";
import { ShortcutSections } from "../shortcuts/shortcuts-sheet";
import {
    ProjectMetaKey,
    readWorkspaceFolder,
    readWorkspaceProject,
    WorkspaceFolderMetaKey,
} from "../workspace-project";
import { linkWorkspaceProject, setWorkspaceFolder, unlinkWorkspaceProject } from "../workspace-project-store";
import {
    clampSetting,
    effectiveSetting,
    groupEntries,
    isChanged,
    jsonSummary,
    searchSettings,
    sectionEntries,
    sectionTitle,
    SettingEntry,
    SettingOption,
    settingsCatalog,
    SettingsSectionId,
    SettingsSections,
} from "./settings-catalog";

export type SettingsFile = { path: string; name: string; description?: string };

export type SettingsScreenProps = {
    blockId: string;
    files: SettingsFile[];
    onOpenFile: (path: string) => void;
};

// The files' one-liners where Wave gives none.
const FileDescriptions: Record<string, string> = {
    "settings.json": "Every setting of this screen, and the ones it does not show.",
    "connections.json": "SSH hosts and their options.",
    "widgets.json": "The custom tools of the rail.",
    "backgrounds.json": "The backgrounds tabs can use.",
    secrets: "Values kept in the system's keychain.",
};

// Wave's file names in sentence case (DS-SHELL-079).
const FileNames: Record<string, string> = {
    "backgrounds.json": "Tab backgrounds",
};

// An empty field says what empty means: a number the app picks itself, a text nobody set.
const PlaceholderFor: Partial<Record<string, string>> = { number: "Auto", text: "Not set" };

const InputClass =
    "h-row rounded-4 border border-line-strong bg-transparent px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent";
const GhostButton =
    "molten-btn-ghost inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-6 px-2 text-12";

// The section each screen was last on, so a remount (a tab switch) keeps it.
const LastSection = new Map<string, SettingsSectionId>();

function platformName(): string {
    const p = getApi().getPlatform();
    return p === "win32" ? "windows" : p;
}

function readValue(entry: SettingEntry, settings: Record<string, unknown>, ws: Workspace): unknown {
    if (entry.scope === "workspace") {
        if (entry.key === WorkspaceFolderMetaKey) {
            return readWorkspaceFolder(ws) || undefined;
        }
        if (entry.key === ProjectMetaKey) {
            return readWorkspaceProject(ws).dir || undefined;
        }
        return (ws?.meta as Record<string, unknown>)?.[entry.key];
    }
    return settings?.[entry.key];
}

// Writing null clears the key: settings.json loses it, as when deleting the line, and the default applies again.
async function writeValue(entry: SettingEntry, value: unknown): Promise<void> {
    if (entry.scope !== "workspace") {
        await writeSettings({ [entry.key]: value ?? null });
        return;
    }
    const ws = globalStore.get(atoms.workspace);
    if (ws == null) {
        return;
    }
    if (entry.key === WorkspaceFolderMetaKey) {
        await setWorkspaceFolder(ws.oid, (value as string) || null);
        return;
    }
    if (entry.key === ProjectMetaKey) {
        if (!value) {
            await unlinkWorkspaceProject(ws.oid);
            return;
        }
        await linkWorkspaceProject(ws, value as string);
    }
}

function Toggle({ entry, on, onSet }: { entry: SettingEntry; on: boolean; onSet: (v: unknown) => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={entry.label}
            onClick={() => onSet(!on)}
            className="inline-flex h-row cursor-pointer items-center rounded-6 px-1"
        >
            <span className={cn("molten-cmdpanel-switch", on && "is-on")} aria-hidden />
        </button>
    );
}

function Select({
    entry,
    value,
    options,
    onSet,
}: {
    entry: SettingEntry;
    value: unknown;
    options: SettingOption[];
    onSet: (v: unknown) => void;
}) {
    const current = value == null ? "" : String(value);
    const list = [...options];
    if (current !== "" && !list.some((o) => o.value === current)) {
        list.unshift({ value: current, label: current });
    }
    return (
        <select
            aria-label={entry.label}
            value={current}
            onChange={(e) => onSet(e.target.value === "" ? null : e.target.value)}
            className={cn(InputClass, "max-w-56 cursor-pointer bg-surface-2 pr-1")}
        >
            {entry.unsetLabel != null || current === "" ? (
                <option value="">{entry.unsetLabel ?? "Default"}</option>
            ) : null}
            {list.map((o) => (
                <option key={o.value} value={o.value}>
                    {o.label}
                </option>
            ))}
        </select>
    );
}

// A text field commits on Enter or when it loses focus; Escape puts the saved value back.
function TextField({
    entry,
    value,
    onSet,
    parse,
    className,
    placeholder,
}: {
    entry: SettingEntry;
    value: unknown;
    onSet: (v: unknown) => void;
    parse?: (raw: string) => unknown;
    className?: string;
    placeholder?: string;
}) {
    const saved = value == null ? "" : String(value);
    const [draft, setDraft] = useState(saved);
    useEffect(() => setDraft(saved), [saved]);
    const commit = () => {
        const trimmed = draft.trim();
        let next: unknown = trimmed === "" ? null : trimmed;
        if (parse != null && next != null) {
            next = parse(trimmed);
            if (next == null) {
                setDraft(saved);
                return;
            }
        }
        if (String(next ?? "") === saved) {
            setDraft(saved);
            return;
        }
        onSet(next);
    };
    return (
        <input
            type="text"
            aria-label={entry.label}
            value={draft}
            spellCheck={false}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    commit();
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setDraft(saved);
                }
            }}
            className={cn(InputClass, className)}
        />
    );
}

function NumberField({ entry, value, onSet }: { entry: SettingEntry; value: unknown; onSet: (v: unknown) => void }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            <TextField
                entry={entry}
                value={value}
                onSet={onSet}
                parse={(raw) => clampSetting(entry, raw)}
                className="w-20 text-right tabular-nums"
                placeholder={entry.defaultValue != null ? String(entry.defaultValue) : PlaceholderFor[entry.control]}
            />
            {entry.unit ? <span className="text-12 text-muted">{entry.unit}</span> : null}
        </span>
    );
}

// The slider writes at most every 60 ms while it moves, and always its last value.
function Slider({ entry, value, onSet }: { entry: SettingEntry; value: unknown; onSet: (v: unknown) => void }) {
    const saved = Number(value ?? entry.range?.min ?? 0);
    const [draft, setDraft] = useState<number>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    const last = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);
    const shown = draft ?? saved;
    const write = (v: number) => {
        setDraft(v);
        clearTimeout(timer.current);
        const wait = 60 - (Date.now() - last.current);
        const run = () => {
            last.current = Date.now();
            fireAndForget(async () => {
                await onSet(v);
                setDraft(null);
            });
        };
        if (wait <= 0) {
            run();
        } else {
            timer.current = setTimeout(run, wait);
        }
    };
    const range = entry.range ?? { min: 0, max: 1, step: 0.05 };
    const percent = range.max <= 1;
    return (
        <span className="inline-flex items-center gap-2">
            <input
                type="range"
                aria-label={entry.label}
                min={range.min}
                max={range.max}
                step={range.step}
                value={shown}
                onChange={(e) => write(Number(e.target.value))}
                className="h-4 w-28 cursor-pointer accent-[var(--mt-accent)]"
            />
            <span className="w-10 text-right text-12 tabular-nums text-secondary">
                {percent ? `${Math.round(shown * 100)} %` : shown}
            </span>
        </span>
    );
}

function MultiChoice({ entry, value, onSet }: { entry: SettingEntry; value: unknown; onSet: (v: unknown) => void }) {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    return (
        <span role="group" aria-label={entry.label} className="inline-flex flex-wrap justify-end gap-1">
            {(entry.options ?? []).map((o) => {
                const on = chosen.includes(o.value);
                return (
                    <button
                        key={o.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                            const next = on ? chosen.filter((v) => v !== o.value) : [...chosen, o.value];
                            onSet(next.length ? next : null);
                        }}
                        className={cn(
                            "inline-flex h-row cursor-pointer items-center gap-1.5 rounded-6 border px-2 text-12 transition-colors duration-120 ease-mt",
                            on
                                ? "border-accent/60 bg-accent/15 text-primary"
                                : "border-line-strong text-secondary hover:bg-surface-2 hover:text-primary"
                        )}
                    >
                        {on ? <i className="fa fa-solid fa-check text-11" aria-hidden /> : null}
                        {o.label}
                    </button>
                );
            })}
        </span>
    );
}

function Control({
    entry,
    value,
    themes,
    onSet,
    onOpenJson,
}: {
    entry: SettingEntry;
    value: unknown;
    themes: SettingOption[];
    onSet: (v: unknown) => void;
    onOpenJson: () => void;
}) {
    const shown = effectiveSetting(entry, value);
    switch (entry.control) {
        case "toggle":
            return <Toggle entry={entry} on={!!shown} onSet={onSet} />;
        case "select":
            return (
                <Select
                    entry={entry}
                    value={shown}
                    options={entry.optionsFrom === "termthemes" ? themes : (entry.options ?? [])}
                    onSet={onSet}
                />
            );
        case "number":
            return <NumberField entry={entry} value={value} onSet={onSet} />;
        case "slider":
            return <Slider entry={entry} value={shown} onSet={onSet} />;
        case "text":
            return (
                <TextField
                    entry={entry}
                    value={value}
                    onSet={onSet}
                    className="w-72"
                    placeholder={
                        entry.defaultValue != null ? String(entry.defaultValue) : PlaceholderFor[entry.control]
                    }
                />
            );
        case "path":
            return (
                <TextField
                    entry={entry}
                    value={value}
                    onSet={onSet}
                    className="w-64 font-mono text-11"
                    placeholder="Not set"
                />
            );
        case "multi":
            return <MultiChoice entry={entry} value={value} onSet={onSet} />;
        default:
            return (
                <span className="inline-flex items-center gap-2">
                    <span className="text-12 text-muted">{jsonSummary(value)}</span>
                    <button type="button" className={GhostButton} onClick={onOpenJson}>
                        Edit in JSON
                    </button>
                </span>
            );
    }
}

function WorkspacePill({ name }: { name: string }) {
    return (
        <span
            className="molten-cmdpanel-scope inline-flex h-5 max-w-40 shrink-0 items-center gap-1 rounded-full px-2 text-11"
            title={`Applies to the workspace ${name} only`}
        >
            <i className="fa fa-solid fa-layer-group text-11" aria-hidden />
            <span className="truncate">{name}</span>
            <span className="sr-only">workspace only</span>
        </span>
    );
}

type RowProps = {
    entry: SettingEntry;
    rowId: string;
    value: unknown;
    workspaceName: string;
    themes: SettingOption[];
    highlighted: boolean;
    onOpenJson: () => void;
};

const SettingRow = memo(({ entry, rowId, value, workspaceName, themes, highlighted, onOpenJson }: RowProps) => {
    const [error, setError] = useState<string>(null);
    const changed = isChanged(entry, value);
    const set = async (v: unknown) => {
        setError(null);
        try {
            await writeValue(entry, v);
        } catch (e) {
            console.error("settings: write failed", entry.key, e);
            setError(
                entry.scope === "workspace"
                    ? "This folder could not be used. Check that it exists."
                    : "This value was not saved. Check settings.json under Advanced."
            );
        }
    };
    return (
        <div
            id={rowId}
            data-setting={entry.key}
            className={cn(
                "molten-settings-row flex items-center gap-4 rounded-6 border-b border-line px-2 py-2.5 transition-colors duration-240 ease-mt last:border-b-0",
                highlighted && "bg-surface-2"
            )}
        >
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-12 font-medium text-primary" title={entry.key}>
                        {entry.label}
                    </span>
                    {entry.scope === "workspace" ? <WorkspacePill name={workspaceName} /> : null}
                </div>
                {entry.description ? (
                    <div className="truncate text-12 text-muted" title={entry.description}>
                        {entry.description}
                    </div>
                ) : null}
                {error ? (
                    <div role="alert" className="text-12 text-danger">
                        {error}
                    </div>
                ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
                {changed ? (
                    <button
                        type="button"
                        className={cn(GhostButton, "px-1.5")}
                        aria-label={`Reset ${entry.label}`}
                        title="Reset to the default"
                        onClick={() => fireAndForget(() => set(null))}
                    >
                        <i className="fa fa-solid fa-rotate-left text-icon-14" aria-hidden />
                    </button>
                ) : null}
                <span data-setting-control className="contents">
                    <Control entry={entry} value={value} themes={themes} onSet={set} onOpenJson={onOpenJson} />
                </span>
            </div>
        </div>
    );
});

SettingRow.displayName = "SettingRow";

function GroupHeading({ children }: { children: React.ReactNode }) {
    return <h3 className="px-2 pt-6 pb-1 text-11 font-semibold tracking-wide text-muted uppercase">{children}</h3>;
}

function FileRows({ files, onOpenFile }: { files: SettingsFile[]; onOpenFile: (path: string) => void }) {
    return (
        <section aria-label="JSON files">
            <GroupHeading>JSON files</GroupHeading>
            {files.map((f) => (
                <div
                    key={f.path}
                    className="flex items-center gap-4 border-b border-line px-2 py-2.5 last:border-b-0"
                    data-file={f.path}
                >
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate text-12 font-medium text-primary">
                                {FileNames[f.path] ?? f.name}
                            </span>
                            {f.path !== "secrets" ? (
                                <span className="truncate font-mono text-11 text-muted">{f.path}</span>
                            ) : null}
                        </div>
                        <div className="truncate text-12 text-muted">
                            {FileDescriptions[f.path] ?? f.description ?? ""}
                        </div>
                    </div>
                    <button type="button" className={GhostButton} onClick={() => onOpenFile(f.path)}>
                        Open
                        <i className="fa fa-solid fa-arrow-right text-11" aria-hidden />
                    </button>
                </div>
            ))}
        </section>
    );
}

function KeyboardShortcuts() {
    const mac = isMacOS();
    const sections = useMemo(() => filterShortcuts(platformShortcuts(mac), "", mac), [mac]);
    return (
        <section aria-label="Shortcuts" className="flex flex-col gap-3 px-2">
            <h3 className="pt-6 text-11 font-semibold tracking-wide text-muted uppercase">Shortcuts</h3>
            <ShortcutSections sections={sections} mac={mac} headingClass="pb-1 text-12 font-medium text-secondary" />
        </section>
    );
}

export function SettingsScreen({ blockId, files, onOpenFile }: SettingsScreenProps) {
    const settings = useAtomValue(atoms.settingsAtom) as Record<string, unknown>;
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const workspace = useAtomValue(atoms.workspace);
    const [section, setSectionState] = useState<SettingsSectionId>(LastSection.get(blockId) ?? "general");
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const [highlight, setHighlight] = useState<string>(null);
    const [jumpTo, setJumpTo] = useState<string>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const catalog = useMemo(() => settingsCatalog(platformName()), []);
    const themes = useMemo(
        () => themeOptions(fullConfig?.termthemes).map((o) => ({ value: String(o.value), label: o.label })),
        [fullConfig?.termthemes]
    );
    const results = useMemo(() => searchSettings(catalog, query), [catalog, query]);
    const searching = query.trim() !== "";
    const workspaceName = workspace?.name || "This workspace";
    const rowId = (key: string) => `molten-setting-${blockId}-${key.replace(/[^a-z0-9]/gi, "-")}`;
    const openSettingsJson = () => onOpenFile("settings.json");

    const setSection = (id: SettingsSectionId) => {
        LastSection.set(blockId, id);
        setSectionState(id);
        contentRef.current?.scrollTo({ top: 0 });
    };

    useEffect(() => setActive(0), [query]);

    // After a jump the row is rendered in its section: bring it to the middle, focus its control, light it briefly.
    useEffect(() => {
        if (jumpTo == null) {
            return;
        }
        const row = document.getElementById(rowId(jumpTo));
        const scroller = contentRef.current;
        // scrollIntoView would also scroll the block frame and the tab around the screen, so only the column moves.
        if (row != null && scroller != null) {
            const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            scroller.scrollTo({ top: scroller.scrollTop + offset - scroller.clientHeight / 2 + row.clientHeight / 2 });
        }
        row?.querySelector<HTMLElement>("[data-setting-control] :is(input, select, button)")?.focus({
            preventScroll: true,
        });
        setHighlight(jumpTo);
        setJumpTo(null);
        const t = setTimeout(() => setHighlight(null), 1600);
        return () => clearTimeout(t);
    }, [jumpTo]);

    const jump = (entry: SettingEntry) => {
        LastSection.set(blockId, entry.section);
        setSectionState(entry.section);
        setQuery("");
        setJumpTo(entry.key);
    };

    const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown" && results.length) {
            e.preventDefault();
            setActive((a) => Math.min(results.length - 1, a + 1));
        } else if (e.key === "ArrowUp" && results.length) {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
        } else if (e.key === "Enter" && results[active]) {
            e.preventDefault();
            jump(results[active]);
        } else if (e.key === "Escape" && query !== "") {
            e.preventDefault();
            e.stopPropagation();
            setQuery("");
        }
    };

    const onRootKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
            e.preventDefault();
            searchRef.current?.focus();
            searchRef.current?.select();
        }
    };

    const entries = sectionEntries(catalog, section);
    const activeId = searching && results[active] ? `${rowId(results[active].key)}-result` : undefined;

    return (
        <div className="@container flex h-full w-full min-h-0 bg-surface-1 text-primary" onKeyDown={onRootKey}>
            <nav
                aria-label="Settings sections"
                className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2 @max-w600:w-12"
            >
                {SettingsSections.map((s) => {
                    const current = !searching && s.id === section;
                    return (
                        <button
                            key={s.id}
                            type="button"
                            aria-current={current ? "page" : undefined}
                            title={s.title}
                            onClick={() => {
                                setQuery("");
                                setSection(s.id);
                            }}
                            className={cn(
                                "flex h-row w-full cursor-pointer items-center gap-2 rounded-6 px-2 text-left text-12 transition-colors duration-120 ease-mt",
                                current
                                    ? "bg-surface-2 font-medium text-primary"
                                    : "text-secondary hover:bg-surface-2 hover:text-primary"
                            )}
                        >
                            <i className={`fa fa-solid fa-${s.icon} w-4 text-center text-icon-14`} aria-hidden />
                            <span className="truncate @max-w600:hidden">{s.title}</span>
                        </button>
                    );
                })}
            </nav>
            <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto">
                <div className="flex w-full max-w-[720px] flex-col px-6 pt-4 pb-10 @max-w600:px-3">
                    <div className="relative">
                        <i
                            className="fa fa-solid fa-magnifying-glass pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-11 text-muted"
                            aria-hidden
                        />
                        <input
                            ref={searchRef}
                            type="text"
                            role="combobox"
                            aria-expanded={searching}
                            aria-controls={`molten-settings-results-${blockId}`}
                            aria-activedescendant={activeId}
                            aria-label="Search settings"
                            placeholder="Search settings"
                            value={query}
                            spellCheck={false}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={onSearchKey}
                            className={cn(InputClass, "h-row-lg w-full pl-7 text-13")}
                        />
                    </div>
                    {searching ? (
                        results.length === 0 ? (
                            <EmptyState
                                compact
                                className="pt-10"
                                icon="magnifying-glass"
                                title={`No setting matches "${query.trim()}"`}
                                hint="Try another word, or edit the JSON files under Advanced."
                                secondary={{ label: "Clear the search", onClick: () => setQuery("") }}
                            />
                        ) : (
                            <>
                                <div className="px-2 pt-4 pb-1 text-11 text-muted" aria-live="polite">
                                    {results.length === 1 ? "1 setting" : `${results.length} settings`}
                                </div>
                                <ul
                                    id={`molten-settings-results-${blockId}`}
                                    role="listbox"
                                    aria-label="Matching settings"
                                    className="flex flex-col"
                                >
                                    {results.map((entry, i) => (
                                        <li
                                            key={entry.key}
                                            id={`${rowId(entry.key)}-result`}
                                            role="option"
                                            aria-selected={i === active}
                                            onMouseMove={() => setActive(i)}
                                            onClick={() => jump(entry)}
                                            className={cn(
                                                "flex cursor-pointer items-center gap-4 rounded-6 px-2 py-2",
                                                i === active ? "bg-surface-2" : ""
                                            )}
                                        >
                                            <div className="min-w-0 flex-1">
                                                <div className="flex min-w-0 items-center gap-2">
                                                    <span className="truncate text-12 font-medium text-primary">
                                                        {entry.label}
                                                    </span>
                                                    {entry.scope === "workspace" ? (
                                                        <WorkspacePill name={workspaceName} />
                                                    ) : null}
                                                </div>
                                                <div className="truncate text-12 text-muted">{entry.description}</div>
                                            </div>
                                            <span className="shrink-0 text-11 text-muted">
                                                {sectionTitle(entry.section)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )
                    ) : (
                        <>
                            <h2 className="px-2 pt-6 text-20 font-semibold text-primary">{sectionTitle(section)}</h2>
                            {section === "advanced" ? <FileRows files={files} onOpenFile={onOpenFile} /> : null}
                            {groupEntries(entries).map((g) => (
                                <section key={g.group} aria-label={g.group}>
                                    <GroupHeading>{g.group}</GroupHeading>
                                    {g.entries.map((entry) => (
                                        <SettingRow
                                            key={entry.key}
                                            entry={entry}
                                            rowId={rowId(entry.key)}
                                            value={readValue(entry, settings, workspace)}
                                            workspaceName={workspaceName}
                                            themes={themes}
                                            highlighted={highlight === entry.key}
                                            onOpenJson={openSettingsJson}
                                        />
                                    ))}
                                </section>
                            ))}
                            {section === "keyboard" ? <KeyboardShortcuts /> : null}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
