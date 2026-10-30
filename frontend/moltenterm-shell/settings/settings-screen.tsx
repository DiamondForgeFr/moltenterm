// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The settings screen (FR-SHELL-050, DS-SHELL-091): the sections on the left, a search over label, key and
// description, and on the right the rows of a section, each with its label, a one-line description, its control and a
// reset when changed. A change writes settings.json through SetConfigCommand, as an edit of the file would. Every block
// states who it applies to, and the workspace's own settings live in its sheet, which General links to (FR-SHELL-101).
// Advanced lists the JSON files, which open in Wave's editor in place (settings-view.tsx). Workspaces and views,
// Notifications, Browser's per-site lists and Tips follow the Spaces model (FR-SHELL-106).

import { ClientModel } from "@/app/store/client-model";
import { atoms, getApi, globalStore } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { MoltentermProductName } from "@/util/moltenterm-identity";
import { isMacOS } from "@/util/platformutil";
import { cn, fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { addLanguageRequest } from "../../molten/morph-templates";
import { currentBuildIdentity } from "../build/current-build";
import { writeSettings } from "../command-panel/bindings";
import "../command-panel/command-panel.css";
import { themeOptions } from "../command-panel/providers/terminal";
import { IntegrateOffKey } from "../companion/companion-integration-model";
import { EmptyState } from "../empty-state";
import { I18nModel, useT } from "../i18n/i18n";
import { languageName } from "../i18n/i18n-core";
import { SleepPolicySetting } from "../keepawake-model";
import { KeepAwakeDetails } from "../keepawake-ui";
import { NewViewOpenKey } from "../newview/new-view-model";
import { NewViewChoicesOptions, NewViewFavorites, useNewViewChoices } from "../newview/new-view-settings";
import { NotificationPanelCard, NotificationSubjectsCard } from "../notification-settings";
import { platformShortcuts } from "../shortcuts/registry";
import { filterShortcuts } from "../shortcuts/shortcuts-search";
import { ShortcutSections } from "../shortcuts/shortcuts-sheet";
import { SuiteSignature } from "../suite/suite";
import { suiteIcon } from "../suite/suite-icons";
import { TipsCards } from "../tips/tips-view";
import { View360SettingKey } from "../view360/view360-decision";
import { workspaceShownName } from "../workspace-default-name";
import { openCurrentWorkspaceEditor } from "../workspace-edit";
import { NewWorkspaceViewsCard } from "../workspace-views/workspace-views-settings";
import {
    clampSetting,
    effectiveSetting,
    groupEntries,
    groupSlug,
    isChanged,
    jsonSummary,
    localizeCatalog,
    localizeSection,
    multiOptionOn,
    multiToggled,
    searchSettings,
    sectionEntries,
    sectionTitle,
    SettingChoice,
    settingChoices,
    SettingEntry,
    SettingOption,
    settingsCatalog,
    SettingsSectionId,
    SettingsSections,
} from "./settings-catalog";
import { ChoiceRows } from "./settings-choice-rows";
import { settingsGroupIcon, SettingsSectionConcepts } from "./settings-icons";
import { IntegrationRuns } from "./settings-integration-runs";
import { ModsSection } from "./settings-mods";
import { readSettingsKey, readSettingsSection, SettingsKeyMetaKey, SettingsSectionMetaKey } from "./settings-open";
import { settingOverriders } from "./settings-overrides";
import { flowColumnsClass, PageCard, pageColumns, PageFill, PageFlow, PageHeader } from "./settings-page";
import { OverriddenNotice, ScopeLine } from "./settings-scope";
import { SecretsSection } from "./settings-secrets";
import { SiteList } from "./settings-site-lists";
import { isSiteListKey } from "./settings-sites";
import { SettingsSlider, useSliderWrites } from "./settings-slider";
import { SidebarModeRows, SidebarTintKey, TopRowCard } from "./settings-spaces";
import { View360Screens } from "./settings-view360-screens";

export type SettingsFile = { path: string; name: string; description?: string };

export type SettingsScreenProps = {
    blockId: string;
    files: SettingsFile[];
    onOpenFile: (path: string) => void;
    // Wave's settings model, for the Secrets section (#534); without it the section says it is not available.
    model?: WaveConfigViewModel;
    // The section a block opened on a file that is now a section (file "secrets") shows first.
    initialSection?: SettingsSectionId;
};

// The files' one-liners where Wave gives none, as keys under settings.files.
const FileDescriptionKeys: Record<string, string> = {
    "settings.json": "settings.files.settings.description",
    "connections.json": "settings.files.connections.description",
    "widgets.json": "settings.files.widgets.description",
    "backgrounds.json": "settings.files.backgrounds.description",
    secrets: "settings.files.secrets.description",
};

// Wave's file names in sentence case (DS-SHELL-079).
const FileNameKeys: Record<string, string> = {
    "settings.json": "settings.files.settings.name",
    "connections.json": "settings.files.connections.name",
    "widgets.json": "settings.files.widgets.name",
    "backgrounds.json": "settings.files.backgrounds.name",
};

// An empty field says what empty means: a number the app picks itself, a text nobody set.
const PlaceholderKeyFor: Partial<Record<string, string>> = { number: "settings.auto", text: "settings.notSet" };

// The select filled with the interface languages (settingsmeta.OptionsLanguages).
const LanguagesOptions = "languages";

const InputClass =
    "h-row max-w-full min-w-0 rounded-4 border border-line-strong bg-transparent px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent";
const GhostButton =
    "molten-btn-ghost inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12";
// A labelled action of a row (Open →, Edit in JSON, Add a language): the calm button, which keeps its outline at rest.
const SecondaryButton =
    "molten-btn-secondary inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12";

// The section each screen was last on, so a remount (a tab switch) keeps it.
const LastSection = new Map<string, SettingsSectionId>();

function openedOnSection(blockId: string): SettingsSectionId {
    const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    return readSettingsSection(block?.meta?.[SettingsSectionMetaKey]);
}

function platformName(): string {
    const p = getApi().getPlatform();
    return p === "win32" ? "windows" : p;
}

// Writing null clears the key: settings.json loses it, as when deleting the line, and the default applies again. The
// rows are the app's settings only: the workspace's are edited in its sheet (FR-SHELL-101).
async function writeValue(entry: SettingEntry, value: unknown): Promise<void> {
    await writeSettings({ [entry.key]: value ?? null });
}

// Every workspace object, kept live: the override notices count the ones that replace an app setting.
function useAllWorkspaces(): Workspace[] {
    const current = useAtomValue(atoms.workspace);
    const [ids, setIds] = useState<string[]>([]);
    useEffect(() => {
        let gone = false;
        const refresh = () =>
            fireAndForget(async () => {
                const list = (await WorkspaceService.ListWorkspaces()) ?? [];
                if (!gone) {
                    setIds(list.map((e) => e.workspaceid));
                }
            });
        refresh();
        const unsubscribe = waveEventSubscribeSingle({ eventType: "workspace:update", handler: refresh });
        return () => {
            gone = true;
            unsubscribe();
        };
    }, [current?.oid]);
    const all = useMemo(
        () =>
            jotai.atom((get) =>
                ids.map((id) => get(WOS.getWaveObjectAtom<Workspace>(WOS.makeORef("workspace", id)))).filter(Boolean)
            ),
        [ids]
    );
    return useAtomValue(all);
}

function useClientMeta(): Record<string, any> {
    const client = useAtomValue(ClientModel.getInstance().clientAtom);
    return client?.meta;
}

function Toggle({ entry, on, onSet }: { entry: SettingEntry; on: boolean; onSet: (v: unknown) => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={entry.label}
            onClick={() => onSet(!on)}
            className="inline-flex h-row cursor-pointer items-center rounded-4 px-1"
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
    const t = useT();
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
                <option value="">{entry.unsetLabel ?? t("settings.default")}</option>
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
    const t = useT();
    return (
        <span className="inline-flex items-center gap-1.5">
            <TextField
                entry={entry}
                value={value}
                onSet={onSet}
                parse={(raw) => clampSetting(entry, raw)}
                className="w-20 text-right tabular-nums"
                placeholder={entry.defaultValue != null ? String(entry.defaultValue) : t(PlaceholderKeyFor.number)}
            />
            {entry.unit ? <span className="text-12 text-muted">{entry.unit}</span> : null}
        </span>
    );
}

function MultiChoice({ entry, value, onSet }: { entry: SettingEntry; value: unknown; onSet: (v: unknown) => void }) {
    return (
        <span role="group" aria-label={entry.label} className="inline-flex flex-wrap justify-end gap-1">
            {(entry.options ?? []).map((o) => {
                const on = multiOptionOn(entry, value, o.value);
                return (
                    <button
                        key={o.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onSet(multiToggled(entry, value, o.value))}
                        className={cn(
                            "inline-flex h-row cursor-pointer items-center gap-1.5 rounded-4 border px-2 text-12 transition-colors duration-120 ease-mt",
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

// A language MoltenTerm does not ship comes from the developer's agent (FR-I18N-002): the button copies the ready
// /morph request of the language pack template.
function AddLanguageButton() {
    const t = useT();
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 2000);
        return () => clearTimeout(timer);
    }, [copied]);
    const onClick = () => {
        fireAndForget(async () => {
            await navigator.clipboard.writeText(addLanguageRequest());
            setCopied(true);
        });
    };
    return (
        <button type="button" className={SecondaryButton} title={t("language.addHint")} onClick={onClick}>
            <i className={cn("fa-solid", copied ? "fa-check" : "fa-language")} />
            {copied ? t("language.addCopied") : t("language.add")}
        </button>
    );
}

function Control({
    entry,
    value,
    themes,
    onSet,
    onOpenJson,
    flushSlider,
}: {
    entry: SettingEntry;
    value: unknown;
    themes: SettingOption[];
    onSet: (v: unknown) => void;
    onOpenJson: () => void;
    flushSlider: () => void;
}) {
    const t = useT();
    const languages = useAtomValue(I18nModel.getInstance().languagesAtom, { store: globalStore });
    const systemLocale = useAtomValue(I18nModel.getInstance().systemLocaleAtom, { store: globalStore });
    const newViewChoices = useNewViewChoices();
    const newViewOptions = newViewChoices.map((c) => ({ value: c.id, label: c.label }));
    const shown = effectiveSetting(entry, value);
    switch (entry.control) {
        case "toggle":
            return <Toggle entry={entry} on={!!shown} onSet={onSet} />;
        case "select": {
            if (entry.optionsFrom === LanguagesOptions) {
                // Each language in its own name; the empty choice follows the OS and stores nothing (FR-I18N-001).
                return (
                    <span className="inline-flex items-center gap-2">
                        <Select
                            entry={{ ...entry, unsetLabel: t("language.system", { name: languageName(systemLocale) }) }}
                            value={shown}
                            options={languages.map((l) => ({ value: l.code, label: l.name }))}
                            onSet={onSet}
                        />
                        <AddLanguageButton />
                    </span>
                );
            }
            return (
                <Select
                    entry={entry}
                    value={shown}
                    options={
                        entry.optionsFrom === "termthemes"
                            ? themes
                            : entry.optionsFrom === NewViewChoicesOptions
                              ? newViewOptions
                              : (entry.options ?? [])
                    }
                    onSet={onSet}
                />
            );
        }
        case "number":
            return <NumberField entry={entry} value={value} onSet={onSet} />;
        case "slider":
            return <SettingsSlider entry={entry} value={shown} onSet={onSet} flush={flushSlider} />;
        case "text":
            return (
                <TextField
                    entry={entry}
                    value={value}
                    onSet={onSet}
                    className="w-72"
                    placeholder={entry.defaultValue != null ? String(entry.defaultValue) : t(PlaceholderKeyFor.text)}
                />
            );
        case "path":
            return (
                <TextField
                    entry={entry}
                    value={value}
                    onSet={onSet}
                    className="w-64 font-mono text-11"
                    placeholder={t("settings.notSet")}
                />
            );
        case "multi":
            return <MultiChoice entry={entry} value={value} onSet={onSet} />;
        default:
            // A per-site setting is edited in its list under the row (FR-SHELL-106), which keeps Edit in JSON.
            if (isSiteListKey(entry.key)) {
                return <span className="text-12 text-muted">{jsonSummary(value, t)}</span>;
            }
            return (
                <span className="inline-flex items-center gap-2">
                    <span className="text-12 text-muted">{jsonSummary(value, t)}</span>
                    <button type="button" className={SecondaryButton} onClick={onOpenJson}>
                        {t("settings.editInJson")}
                    </button>
                </span>
            );
    }
}

function SectionIcon({ id, className }: { id: SettingsSectionId; className?: string }) {
    const Icon = suiteIcon(SettingsSectionConcepts[id]);
    return <Icon className={className} aria-hidden />;
}

// General is for the whole app (FR-SHELL-101): the workspace's own folder and project are edited in its sheet, which
// this block opens.
function WorkspaceSheetCard({ name }: { name: string }) {
    const t = useT();
    return (
        <PageCard title={t("settings.groups.thisWorkspace")} icon={suiteIcon("workspace")} scope="workspace">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3" data-workspace-sheet-link>
                <div className="min-w-0 flex-1 basis-60 text-12 text-muted">
                    {t("settings.workspaceSheet.text", { name })}
                </div>
                <button
                    type="button"
                    className={cn(SecondaryButton, "ml-auto")}
                    onClick={(e) => openCurrentWorkspaceEditor(e.currentTarget)}
                >
                    {t("settings.workspaceSheet.open")}
                    <i className="fa fa-solid fa-chevron-right text-10" aria-hidden />
                </button>
            </div>
        </PageCard>
    );
}

type RowProps = {
    entry: SettingEntry;
    rowId: string;
    value: unknown;
    // The workspaces that replace this app setting with their own value.
    overriddenIn: string[];
    themes: SettingOption[];
    highlighted: boolean;
    onOpenJson: () => void;
};

function useChoices(entry: SettingEntry): SettingChoice[] {
    const t = useT();
    const languages = useAtomValue(I18nModel.getInstance().languagesAtom, { store: globalStore });
    const systemLocale = useAtomValue(I18nModel.getInstance().systemLocaleAtom, { store: globalStore });
    return settingChoices(entry, languages, t("language.system", { name: languageName(systemLocale) }));
}

const SettingRow = memo(({ entry, rowId, value, overriddenIn, themes, highlighted, onOpenJson }: RowProps) => {
    const t = useT();
    const [errorKey, setErrorKey] = useState<string>(null);
    const { writer, state } = useSliderWrites(entry, value, (v) => writeValue(entry, v));
    const choices = useChoices(entry);
    const shownValue = state.intent != null ? state.intent.value : value;
    const changed = isChanged(entry, shownValue);
    const error = state.failed ? t("settings.error.sliderNotSaved") : errorKey != null ? t(errorKey) : null;
    const set = async (v: unknown) => {
        if (writer != null) {
            writer.select(v as number);
            return;
        }
        setErrorKey(null);
        try {
            await writeValue(entry, v);
        } catch (e) {
            console.error("settings: write failed", entry.key, e);
            setErrorKey("settings.error.notSaved");
        }
    };
    const reset = changed ? (
        <button
            type="button"
            className={cn(GhostButton, "px-1.5")}
            aria-label={t("settings.reset.label", { label: entry.label })}
            title={t("settings.reset.title")}
            onClick={() => fireAndForget(() => set(null))}
        >
            <i className="fa fa-solid fa-rotate-left text-icon-14" aria-hidden />
        </button>
    ) : null;
    return (
        <div
            id={rowId}
            data-setting={entry.key}
            aria-busy={state.intent != null && !state.failed ? true : undefined}
            className={cn(
                "molten-settings-row flex flex-col transition-colors duration-240 ease-mt",
                highlighted && "bg-surface-2"
            )}
        >
            <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-5", choices ? "pt-3 pb-2" : "py-3")}>
                {/* 240 px before the control wraps under it: in a column of a wide page (#674) a wide field would
                    otherwise squeeze the label to a few letters. */}
                <div className="min-w-0 flex-1 basis-60">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-12 font-medium text-primary" title={entry.key}>
                            {entry.label}
                        </span>
                    </div>
                    {entry.description ? (
                        <div className="truncate text-12 text-muted" title={entry.description}>
                            {entry.description}
                        </div>
                    ) : null}
                    <OverriddenNotice names={overriddenIn} />
                    {error ? (
                        <div role="alert" className="text-12 text-danger">
                            {error}
                            {state.failed ? (
                                <button type="button" className={GhostButton} onClick={writer.retry}>
                                    {t("settings.retry")}
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
                <div className="ml-auto flex max-w-full shrink-0 items-center gap-1">
                    {reset}
                    {choices == null ? (
                        <span data-setting-control className="contents">
                            <Control
                                entry={entry}
                                value={shownValue}
                                themes={themes}
                                onSet={set}
                                onOpenJson={onOpenJson}
                                flushSlider={writer?.flush}
                            />
                        </span>
                    ) : entry.optionsFrom === LanguagesOptions ? (
                        <AddLanguageButton />
                    ) : null}
                </div>
            </div>
            {choices != null ? (
                <ChoiceRows entry={entry} name={`${rowId}-choice`} choices={choices} value={value} onSet={set} />
            ) : null}
            {isSiteListKey(entry.key) ? (
                <SiteList entryKey={entry.key} label={entry.label} value={value} onOpenJson={onOpenJson} />
            ) : null}
        </div>
    );
});

SettingRow.displayName = "SettingRow";

function FileRows({ files, onOpenFile }: { files: SettingsFile[]; onOpenFile: (path: string) => void }) {
    const t = useT();
    return (
        <PageCard
            title={t("settings.files.title")}
            hint={t("settings.files.hint")}
            icon={suiteIcon("files")}
            scope="app"
        >
            {files
                .filter((f) => f.path !== "secrets")
                .map((f) => (
                    <div key={f.path} className="flex items-center gap-4 px-5 py-3" data-file={f.path}>
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-baseline gap-2">
                                <span className="truncate text-12 font-medium text-primary">
                                    {FileNameKeys[f.path] != null ? t(FileNameKeys[f.path]) : f.name}
                                </span>
                                {f.path !== "secrets" ? (
                                    <span className="truncate font-mono text-11 text-muted">{f.path}</span>
                                ) : null}
                            </div>
                            <div className="truncate text-12 text-muted">
                                {FileDescriptionKeys[f.path] != null
                                    ? t(FileDescriptionKeys[f.path])
                                    : (f.description ?? "")}
                            </div>
                        </div>
                        <button type="button" className={SecondaryButton} onClick={() => onOpenFile(f.path)}>
                            {t("common.open")}
                            <i className="fa fa-solid fa-arrow-right text-11" aria-hidden />
                        </button>
                    </div>
                ))}
        </PageCard>
    );
}

function KeyboardShortcuts() {
    const t = useT();
    const mac = isMacOS();
    const sections = useMemo(() => filterShortcuts(platformShortcuts(mac), "", mac), [mac]);
    return (
        <PageCard
            title={t("settings.shortcuts.title")}
            hint={t("settings.shortcuts.hint")}
            icon={suiteIcon("keyboard")}
            scope="app"
        >
            <div className={cn("px-5 pt-3 [&>section]:pb-3", flowColumnsClass(3))}>
                <ShortcutSections
                    sections={sections}
                    mac={mac}
                    headingClass="pb-1 text-12 font-medium text-secondary"
                />
            </div>
        </PageCard>
    );
}

export function SettingsScreen({ blockId, files, onOpenFile, model, initialSection }: SettingsScreenProps) {
    const t = useT();
    const settings = useAtomValue(atoms.settingsAtom) as Record<string, unknown>;
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const workspace = useAtomValue(atoms.workspace);
    const allWorkspaces = useAllWorkspaces();
    const clientMeta = useClientMeta();
    const [section, setSectionState] = useState<SettingsSectionId>(
        () => initialSection ?? openedOnSection(blockId) ?? LastSection.get(blockId) ?? "general"
    );
    const block = useAtomValue(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    const askedSection = readSettingsSection(block?.meta?.[SettingsSectionMetaKey]);
    const askedKey = readSettingsKey(block?.meta?.[SettingsKeyMetaKey]);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const [highlight, setHighlight] = useState<string>(null);
    const [jumpTo, setJumpTo] = useState<string>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    // Rebuilt when the language changes, so the rows and the search speak the shown language.
    const catalog = useMemo(() => localizeCatalog(settingsCatalog(platformName()), t), [t]);
    // A group's icon follows its English name, which the interface language does not change.
    const groupSlugByKey = useMemo(
        () => new Map(settingsCatalog(platformName()).map((e) => [e.key, groupSlug(e.group)])),
        []
    );
    const sections = useMemo(() => SettingsSections.map((s) => localizeSection(s, t)), [t]);
    const appVersion = useMemo(() => currentBuildIdentity(getApi().getAboutModalDetails()?.version ?? "").version, []);
    const currentSection = sections.find((s) => s.id === section);
    const themes = useMemo(
        () => themeOptions(fullConfig?.termthemes).map((o) => ({ value: String(o.value), label: o.label })),
        [fullConfig?.termthemes]
    );
    const results = useMemo(() => searchSettings(catalog, query), [catalog, query]);
    const searching = query.trim() !== "";
    const workspaceName = workspaceShownName(workspace?.name, t) || t("settings.thisWorkspace");
    // One array per setting, stable while nothing changes, so the memoized rows do not redraw.
    const overriddenIn = useMemo(() => {
        const byKey = new Map<string, string[]>();
        for (const entry of catalog) {
            const names = settingOverriders(entry.key, allWorkspaces, clientMeta).map(
                (ws) => workspaceShownName(ws.name, t) || ws.oid
            );
            if (names.length > 0) {
                byKey.set(entry.key, names);
            }
        }
        return byKey;
    }, [catalog, allWorkspaces, clientMeta, t]);
    const rowId = (key: string) => `molten-setting-${blockId}-${key.replace(/[^a-z0-9]/gi, "-")}`;
    const openSettingsJson = () => onOpenFile("settings.json");

    const setSection = (id: SettingsSectionId) => {
        LastSection.set(blockId, id);
        setSectionState(id);
        contentRef.current?.scrollTo({ top: 0 });
    };

    useEffect(() => setActive(0), [query]);

    // A section asked while the screen is open (Preferences opened again from elsewhere, FR-SHELL-094) shows here; it
    // is cleared once shown, so asking the same section again later is a change the screen sees.
    useEffect(() => {
        if (askedSection == null) {
            return;
        }
        setSection(askedSection);
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", blockId),
                meta: { [SettingsSectionMetaKey]: null } as MetaType,
            })
        );
    }, [askedSection, blockId]);

    // A setting asked the same way (the sleep indicator's link): shown like a search result, then cleared.
    useEffect(() => {
        if (askedKey == null) {
            return;
        }
        const entry = catalog.find((e) => e.key === askedKey);
        if (entry != null) {
            jump(entry);
        }
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", blockId),
                meta: { [SettingsKeyMetaKey]: null } as MetaType,
            })
        );
    }, [askedKey, blockId]);

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
        // Option rows focus the chosen one.
        const control =
            row?.querySelector<HTMLElement>("[data-setting-control] input:checked") ??
            row?.querySelector<HTMLElement>("[data-setting-control] :is(input, select, button)");
        control?.focus({ preventScroll: true });
        setHighlight(jumpTo);
        setJumpTo(null);
    }, [jumpTo]);

    // Its own effect: clearing jumpTo re-runs the one above, whose cleanup would cancel the timer and leave the row
    // lit, and the block's turning light running, for good.
    useEffect(() => {
        if (highlight == null) {
            return;
        }
        const timer = setTimeout(() => setHighlight(null), 1600);
        return () => clearTimeout(timer);
    }, [highlight]);

    const jump = (entry: SettingEntry) => {
        if (entry.scope === "workspace") {
            setQuery("");
            openCurrentWorkspaceEditor();
            return;
        }
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
    const groups = groupEntries(entries);
    // Blocks the page lays side by side. Keyboard's block, below them, takes the full width and splits its own groups;
    // Secrets keeps its stacked blocks in one column.
    const flowBlocks =
        groups.length +
        (section === "advanced" ? 1 : 0) +
        (section === "mods" ? 1 : 0) +
        (section === "general" ? 1 : 0) +
        (section === "spaces" ? 2 : 0) +
        (section === "notifications" ? 2 : 0);
    const flowColumns = pageColumns(flowBlocks);
    // A short result list reads best as one list.
    const resultColumns = pageColumns(results.length >= 8 ? 3 : 1);
    const width = searching ? resultColumns : section === "keyboard" ? 3 : section === "tips" ? 2 : flowColumns;
    const activeId = searching && results[active] ? `${rowId(results[active].key)}-result` : undefined;

    return (
        <div className="@container flex h-full w-full min-h-0 bg-surface-1 text-primary" onKeyDown={onRootKey}>
            {/* The section list at the left edge, the page filling the rest of the panel (#674). */}
            <div className="flex h-full min-h-0 w-full">
                <nav
                    aria-label={t("settings.sectionsLabel")}
                    className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2 @max-w600:w-12"
                >
                    {sections.map((s) => {
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
                                    "relative flex h-row w-full cursor-pointer items-center gap-2 rounded-4 px-2 text-left text-12 transition-colors duration-120 ease-mt",
                                    current
                                        ? "bg-surface-2 font-medium text-primary before:absolute before:top-1.5 before:bottom-1.5 before:-left-2 before:w-0.5 before:rounded-full before:bg-accent"
                                        : "text-secondary hover:bg-surface-2 hover:text-primary"
                                )}
                            >
                                <SectionIcon id={s.id} className={cn("h-3.5 w-4 shrink-0", current && "text-accent")} />
                                <span className="truncate @max-w600:hidden">{s.title}</span>
                            </button>
                        );
                    })}
                    <SuiteSignature
                        className="mt-auto shrink-0 px-2 pt-3 @max-w600:hidden"
                        product={MoltentermProductName}
                        version={appVersion}
                        label={t("common.diamondforgeProduct")}
                    />
                </nav>
                <div ref={contentRef} className="@container/page min-w-0 flex-1 overflow-y-auto">
                    <PageFill width={width}>
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
                                aria-label={t("settings.search.label")}
                                placeholder={t("settings.search.label")}
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
                                    title={t("settings.search.none", { query: query.trim() })}
                                    hint={t("settings.search.noneHint")}
                                    secondary={{ label: t("settings.search.clear"), onClick: () => setQuery("") }}
                                />
                            ) : (
                                <>
                                    <div className="px-2 pt-4 pb-1 text-11 text-muted" aria-live="polite">
                                        {results.length === 1
                                            ? t("settings.search.count.one")
                                            : t("settings.search.count.other", { count: results.length })}
                                    </div>
                                    <ul
                                        id={`molten-settings-results-${blockId}`}
                                        role="listbox"
                                        aria-label={t("settings.search.results")}
                                        className={flowColumnsClass(resultColumns)}
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
                                                    "flex cursor-pointer items-center gap-4 rounded-4 px-2 py-2",
                                                    i === active ? "bg-surface-2" : ""
                                                )}
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex min-w-0 items-center gap-2">
                                                        <span className="truncate text-12 font-medium text-primary">
                                                            {entry.label}
                                                        </span>
                                                    </div>
                                                    <div className="truncate text-12 text-muted">
                                                        {entry.description}
                                                    </div>
                                                </div>
                                                {entry.scope === "workspace" ? (
                                                    <ScopeLine scope="workspace" className="shrink-0" />
                                                ) : (
                                                    <span className="shrink-0 text-11 text-muted">
                                                        {sectionTitle(entry.section, t)}
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )
                        ) : (
                            <>
                                <div className="pt-6">
                                    <PageHeader
                                        title={currentSection?.title ?? section}
                                        description={currentSection?.description}
                                        icon={suiteIcon(SettingsSectionConcepts[section])}
                                    />
                                </div>
                                {flowBlocks > 0 ? (
                                    <PageFlow columns={flowColumns}>
                                        {section === "advanced" ? (
                                            <FileRows files={files} onOpenFile={onOpenFile} />
                                        ) : null}
                                        {groups.map((g) => (
                                            <PageCard
                                                key={g.group}
                                                title={g.group}
                                                icon={suiteIcon(
                                                    settingsGroupIcon(groupSlugByKey.get(g.entries[0].key))
                                                )}
                                                glow={highlight != null && g.entries.some((e) => e.key === highlight)}
                                                scope="app"
                                            >
                                                {g.entries.some((e) => e.key === SidebarTintKey) ? (
                                                    <SidebarModeRows />
                                                ) : null}
                                                {g.entries.map((entry) => (
                                                    <SettingRow
                                                        key={entry.key}
                                                        entry={entry}
                                                        rowId={rowId(entry.key)}
                                                        value={settings?.[entry.key]}
                                                        overriddenIn={overriddenIn.get(entry.key)}
                                                        themes={themes}
                                                        highlighted={highlight === entry.key}
                                                        onOpenJson={openSettingsJson}
                                                    />
                                                ))}
                                                {g.entries.some((e) => e.key === IntegrateOffKey) ? (
                                                    <IntegrationRuns />
                                                ) : null}
                                                {g.entries.some((e) => e.key === SleepPolicySetting) ? (
                                                    <KeepAwakeDetails />
                                                ) : null}
                                                {g.entries.some((e) => e.key === View360SettingKey) ? (
                                                    <View360Screens />
                                                ) : null}
                                                {g.entries.some((e) => e.key === NewViewOpenKey) ? (
                                                    <NewViewFavorites />
                                                ) : null}
                                            </PageCard>
                                        ))}
                                        {section === "spaces" ? <TopRowCard /> : null}
                                        {section === "spaces" ? <NewWorkspaceViewsCard /> : null}
                                        {section === "general" ? <WorkspaceSheetCard name={workspaceName} /> : null}
                                        {section === "notifications" ? <NotificationSubjectsCard /> : null}
                                        {section === "notifications" ? <NotificationPanelCard /> : null}
                                        {section === "mods" ? <ModsSection /> : null}
                                    </PageFlow>
                                ) : null}
                                {section === "tips" ? <TipsCards /> : null}
                                {section === "keyboard" ? <KeyboardShortcuts /> : null}
                                {section === "secrets" ? (
                                    model != null ? (
                                        <SecretsSection model={model} />
                                    ) : (
                                        <p className="pt-6 text-12 text-muted">{t("settings.secretsElsewhere")}</p>
                                    )
                                ) : null}
                            </>
                        )}
                    </PageFill>
                </div>
            </div>
        </div>
    );
}
