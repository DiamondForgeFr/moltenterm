// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace edit sheet (FR-SHELL-030, DS-SHELL-036, DS-SHELL-101): titled Workspace with its folder under the
// title; Identity (one Icon field, Symbol or Image, then the colour), Project, Folder and Danger zone, in that order.
// A change is saved as soon as it is made, as in Wave's editor; Done, Escape and a press outside close it, and the
// focus goes back to what opened it.

import { atoms, getApi } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { workspaceColourStops } from "./accent";
import { DialogFrame, useEscape } from "./dialog-frame";
import { t as translateNow, useT } from "./i18n/i18n";
import { MoltenWave } from "./molten-button";
import { DominoLoader, SectionBlock, ToggleGroup, ToggleOption } from "./suite/suite";
import { suiteIcon, SuiteIconName } from "./suite/suite-icons";
import {
    colourChoiceCss,
    colourChoiceForeground,
    colourStops,
    logoColourChoices,
    parseCustomColour,
    PresetColourChoices,
    PresetGradientChoices,
} from "./workspace-colour";
import { listenWorkspaceMenu, pickUpWorkspaceEdit, WorkspaceEditModel } from "./workspace-edit";
import {
    checkWorkspaceName,
    colourName,
    dangerAction,
    emptyNameError,
    iconName,
    moveRadio,
    radioTabStop,
    WorkspaceEditIntentKey,
} from "./workspace-edit-model";
import { RailBadgeClass, WorkspaceIcon, workspaceImageUrl } from "./workspace-icon";
import { hasImportedIcon, iconKindLabel, workspaceIconSource } from "./workspace-icon-model";
import { logoPalette } from "./workspace-logo-palette";
import { effectiveWorkspaceFolder, pathBaseName, readWorkspaceProject } from "./workspace-project";
import { WorkspaceFolderLine, WorkspaceProjectBlock } from "./workspace-project-section";
import {
    chooseMoltentermPath,
    findProjectLogos,
    setWorkspaceGradient,
    setWorkspaceLogo,
} from "./workspace-project-store";
import { askResetWorkspace } from "./workspace-reset";
import { canCloseWorkspace } from "./workspace-reset-model";

const FieldLabelClass = "mb-1 text-12 text-secondary";
const DangerButtonClass =
    "shrink-0 cursor-pointer rounded-3 border border-error px-3 py-1.5 text-12 text-primary transition-colors duration-120 ease-mt hover:bg-error/15";
const SecondaryButtonClass =
    "shrink-0 cursor-pointer rounded-3 border border-border px-3 py-1.5 text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-60";
const GhostButtonClass =
    "shrink-0 cursor-pointer rounded-3 px-2 py-0.5 text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-60";

const FocusRingClass =
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring)";

// Each section is a DiamondForge suite block (#658): its name in the chip on the top border, its icon on the corner.
function Section({
    title,
    concept,
    tone,
    children,
}: {
    title: string;
    // The suite concept whose Lucide icon sits on the corner (suite/suite-icons.ts), not a Font Awesome name.
    concept: SuiteIconName;
    tone?: "danger";
    children: React.ReactNode;
}) {
    return (
        <SectionBlock title={title} icon={suiteIcon(concept)} tone={tone} data-section={title} className="min-w-0">
            {children}
        </SectionBlock>
    );
}

// A radio group with one tab stop; the arrows move the choice and apply it (WAI-ARIA radio group, NFR-SHELL-014).
function RadioGrid({
    label,
    hideLabel,
    labelClass,
    options,
    selected,
    onSelect,
    renderOption,
    columns,
}: {
    label: string;
    // Named for screen readers only, where the field above already names it on screen.
    hideLabel?: boolean;
    labelClass?: string;
    options: string[];
    selected: string;
    onSelect: (value: string) => void;
    renderOption: (value: string, checked: boolean, tabIndex: number) => React.ReactNode;
    // A grid of this many columns instead of rows that wrap where the width ends.
    columns?: number;
}) {
    const labelId = useId();
    const groupRef = useRef<HTMLDivElement>(null);
    const tabStop = radioTabStop(options, selected);
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const radios = Array.from(groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
        const from = radios.indexOf(document.activeElement as HTMLElement);
        const next = moveRadio(e.key, from, options.length);
        if (next < 0) {
            return;
        }
        e.preventDefault();
        radios[next]?.focus();
        onSelect(options[next]);
    };
    return (
        <div className="min-w-0">
            <div id={labelId} className={hideLabel ? "sr-only" : (labelClass ?? FieldLabelClass)}>
                {label}
            </div>
            <div
                ref={groupRef}
                role="radiogroup"
                aria-labelledby={labelId}
                onKeyDown={onKeyDown}
                className={cn("min-w-0 gap-1", columns ? "grid w-fit" : "flex flex-wrap")}
                style={columns ? { gridTemplateColumns: `repeat(${columns}, max-content)` } : undefined}
            >
                {options.map((value, i) => (
                    <Fragment key={value}>{renderOption(value, value === selected, i === tabStop ? 0 : -1)}</Fragment>
                ))}
            </div>
        </div>
    );
}

type ImportResult = { ok: boolean; text: string };

// While the sheet invites a drop, a file released beside the target must not reach Chromium, which would navigate to
// it and have Electron open it in another app. The targets handle their own drops before this runs.
function guardFileDrops(): () => void {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent) => {
        if (!hasFiles(e) || e.defaultPrevented) {
            return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "none";
    };
    const onDrop = (e: DragEvent) => {
        if (hasFiles(e)) {
            e.preventDefault();
        }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("drop", onDrop);
    };
}

// The drop half of the icon area (FR-SHELL-031 AC1): the preview and the image slot both take a dropped file. Electron
// gives a dropped file's path; an image dragged from a web page has none and is refused with a line.
function useIconDrop(onPath: (path: string) => void, onRefused: (text: string) => void) {
    const depth = useRef(0);
    const [over, setOver] = useState(false);
    const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const handlers = {
        onDragEnter: (e: React.DragEvent) => {
            if (!hasFiles(e)) {
                return;
            }
            e.preventDefault();
            depth.current++;
            setOver(true);
        },
        onDragOver: (e: React.DragEvent) => {
            if (!hasFiles(e)) {
                return;
            }
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: () => {
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) {
                setOver(false);
            }
        },
        onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            depth.current = 0;
            setOver(false);
            const file = e.dataTransfer?.files?.[0];
            let path = "";
            try {
                path = file ? (getApi().getPathForFile(file) ?? "") : "";
            } catch {
                path = "";
            }
            if (!path) {
                onRefused(translateNow("workspace.edit.noDroppedFile"));
                return;
            }
            onPath(path);
        },
    };
    return { over, handlers };
}

// Asked before a project image replaces the imported one (FR-SHELL-031 AC7): the imported copy would be deleted.
function ReplaceImageConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
    const t = useT();
    const confirmRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        confirmRef.current?.focus();
    }, []);
    return (
        <div
            role="group"
            aria-label={t("workspace.edit.replaceImage")}
            data-role="replace-image-confirm"
            className="flex flex-wrap items-center gap-2 rounded-4 border border-border px-2 py-1.5"
        >
            <span className="min-w-0 flex-1 basis-48 text-12 text-secondary">
                {t("workspace.edit.replaceImageQuestion")}
            </span>
            <button
                ref={confirmRef}
                type="button"
                onClick={onConfirm}
                className="molten-btn molten-btn-warning shrink-0 cursor-pointer rounded-3 px-2 py-1 text-12"
            >
                {t("workspace.edit.replace")}
                <MoltenWave />
            </button>
            <button type="button" onClick={onCancel} className={cn(SecondaryButtonClass, FocusRingClass)}>
                {t("common.cancel")}
            </button>
        </div>
    );
}

const ImageTileClass =
    "flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-3 border text-icon-20 transition-colors duration-120 ease-mt motion-reduce:transition-none";

// The Image side of the Icon field (DS-SHELL-101): the project's images first, then the imported one, then the tile
// that imports another (a pick or a drop; wavesrv checks and copies the file, FR-SHELL-031). The result is one line,
// announced.
export function ImagePane({
    ws,
    logos,
    over,
    busy,
    result,
    dropHandlers,
    onPick,
    onLogo,
}: {
    ws: Workspace;
    logos: string[];
    over: boolean;
    busy: boolean;
    result: ImportResult;
    dropHandlers: React.HTMLAttributes<HTMLDivElement>;
    onPick: () => void;
    onLogo: (logo: string) => void;
}) {
    const t = useT();
    const imported = hasImportedIcon(ws);
    const source = workspaceIconSource(ws);
    const current = imported ? "" : source.logo;
    const projectImages = current && !logos.includes(current) ? [current, ...logos] : logos;
    return (
        <div className="flex min-w-0 flex-col gap-1.5" data-role="image-pane">
            <div
                {...dropHandlers}
                data-role="icon-drop"
                data-over={over ? "true" : undefined}
                className={cn(
                    "-m-1 flex flex-wrap items-center gap-1.5 rounded-3 p-1 transition-colors duration-120 ease-mt motion-reduce:transition-none",
                    over && "bg-accent/10 outline outline-1 outline-accent outline-dashed"
                )}
            >
                {projectImages.map((logo) => (
                    <button
                        key={logo}
                        type="button"
                        aria-pressed={logo === current}
                        aria-label={t("workspace.edit.projectImage", { name: pathBaseName(logo) })}
                        title={logo}
                        data-image-kind="project"
                        onClick={() => onLogo(logo)}
                        className={cn(
                            ImageTileClass,
                            FocusRingClass,
                            logo === current ? "border-accent bg-accent/10" : "border-border hover:bg-hover"
                        )}
                    >
                        <WorkspaceIcon source={{ icon: ws.icon, color: ws.color, image: "", logo }} />
                    </button>
                ))}
                {imported ? (
                    <span
                        role="img"
                        aria-label={t("workspace.edit.importedInUse")}
                        title={t("workspace.edit.importedImage")}
                        data-image-kind="imported"
                        className={cn(ImageTileClass, "cursor-default border-accent bg-accent/10")}
                    >
                        <WorkspaceIcon source={{ ...source, logo: "" }} />
                    </span>
                ) : null}
                <button
                    type="button"
                    disabled={busy}
                    onClick={onPick}
                    aria-label={t(imported ? "workspace.edit.replaceImported" : "workspace.edit.importImage")}
                    title={t(imported ? "workspace.edit.replaceImported" : "workspace.edit.importImage")}
                    data-action="import-image"
                    className={cn(
                        ImageTileClass,
                        FocusRingClass,
                        "border-dashed border-border text-icon-14 text-muted hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-60"
                    )}
                >
                    {busy ? <DominoLoader /> : <i className="fa fa-solid fa-plus" aria-hidden />}
                </button>
            </div>
            <div role="status" aria-live="polite" data-role="icon-import-result" className="min-h-4 text-12">
                {result ? (
                    <span className={result.ok ? "text-secondary" : "text-primary"}>
                        {result.ok ? null : (
                            <i className="fa fa-solid fa-circle-exclamation mr-1 text-error" aria-hidden />
                        )}
                        {result.text}
                    </span>
                ) : (
                    <span className="text-muted">{t(over ? "workspace.edit.dropToUse" : "workspace.edit.orDrop")}</span>
                )}
            </div>
        </div>
    );
}

function RailBadgePreview({
    ws,
    over,
    dropHandlers,
}: {
    ws: Workspace;
    over: boolean;
    dropHandlers: React.HTMLAttributes<HTMLDivElement>;
}) {
    const t = useT();
    const source = workspaceIconSource(ws);
    const kind = iconKindLabel(source.image ? "imported" : source.logo ? "logo" : "builtin");
    return (
        <div className="flex shrink-0 flex-col items-center gap-1" {...dropHandlers}>
            <div
                role="img"
                aria-label={t(kind ? "workspace.edit.railBadgeKind" : "workspace.edit.railBadge", {
                    icon: iconName(ws.icon),
                    colour: colourName(workspaceColourStops(ws).join(",") || ws.color),
                    kind,
                })}
                data-role="rail-preview"
                className={cn(
                    RailBadgeClass,
                    "bg-hover",
                    over && "outline outline-2 outline-offset-2 outline-accent outline-dashed"
                )}
            >
                <WorkspaceIcon source={source} />
            </div>
            <div className="text-11 text-muted" aria-hidden>
                {t("workspace.edit.inTheRail")}
            </div>
        </div>
    );
}

type IconMode = "symbol" | "image";

const IconModes: ToggleOption<IconMode>[] = [
    { value: "symbol", label: "workspace.edit.symbol" },
    { value: "image", label: "workspace.edit.image" },
];

// The side the Icon field opens on: Image while an image shows in the rail.
export function initialIconMode(ws: Workspace): IconMode {
    return hasImportedIcon(ws) || workspaceIconSource(ws).logo !== "" ? "image" : "symbol";
}

function IdentitySection({ ws, nameRef }: { ws: Workspace; nameRef: React.RefObject<HTMLInputElement> }) {
    const t = useT();
    const nameId = useId();
    const errorId = useId();
    const iconLabelId = useId();
    const [draft, setDraft] = useState<string>(null);
    const [icons, setIcons] = useState<string[]>([]);
    const [mode, setMode] = useState<IconMode>(() => initialIconMode(ws));
    const [logos, setLogos] = useState<string[]>([]);
    const [pendingLogo, setPendingLogo] = useState<string>(null);
    const projectDir = readWorkspaceProject(ws).dir;
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            const found = await WorkspaceService.GetIcons();
            if (live) {
                setIcons(found ?? []);
            }
        });
        return () => {
            live = false;
        };
    }, []);
    useEffect(() => {
        setLogos([]);
        if (projectDir === "") {
            return;
        }
        let live = true;
        fireAndForget(async () => {
            const found = await findProjectLogos(projectDir);
            if (live) {
                setLogos(found ?? []);
            }
        });
        return () => {
            live = false;
        };
    }, [projectDir]);
    const name = draft ?? ws.name ?? "";
    const invalid = checkWorkspaceName(name) == null;
    const save = (next: { name?: string; icon?: string; color?: string }) => {
        const saved = checkWorkspaceName(next.name ?? name) ?? ws.name;
        fireAndForget(() =>
            WorkspaceService.UpdateWorkspace(ws.oid, saved, next.icon ?? ws.icon, next.color ?? ws.color, false)
        );
    };
    // The gradient's stops go first: they count only once `color` is their first stop, so no surface ever shows a
    // gradient with the previous colour's first stop.
    const saveColour = (choice: string) => {
        const stops = colourStops(choice);
        if (stops.length === 0) {
            return;
        }
        fireAndForget(async () => {
            await setWorkspaceGradient(ws.oid, stops.length > 1 ? stops.join(",") : null);
            await WorkspaceService.UpdateWorkspace(
                ws.oid,
                checkWorkspaceName(name) ?? ws.name,
                ws.icon,
                stops[0],
                false
            );
        });
    };
    const logoColours = useLogoColours(ws);
    const onName = (value: string) => {
        setDraft(value);
        if (checkWorkspaceName(value) != null) {
            save({ name: value });
        }
    };
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<ImportResult>(null);
    const runIconChange = (fn: () => Promise<ImportResult>) => {
        if (busy) {
            return;
        }
        setBusy(true);
        setResult(null);
        fireAndForget(async () => {
            try {
                setResult(await fn());
            } catch (e) {
                console.log("workspace icon:", e);
                setResult({ ok: false, text: translateNow("workspace.edit.importFailed") });
            } finally {
                setBusy(false);
            }
        });
    };
    const importPath = (path: string) => {
        setMode("image");
        runIconChange(async () => {
            const refusal = await WorkspaceService.ImportWorkspaceIcon(ws.oid, path);
            return refusal
                ? { ok: false, text: refusal }
                : { ok: true, text: translateNow("workspace.edit.imported", { name: pathBaseName(path) }) };
        });
    };
    const pick = () =>
        fireAndForget(async () => {
            const path = await chooseMoltentermPath({
                kind: "workspaceicon",
                title: translateNow("workspace.edit.iconDialogTitle"),
            });
            if (path) {
                importPath(path);
            }
        });
    const source = workspaceIconSource(ws);
    const imported = hasImportedIcon(ws);
    const showsImage = imported || source.logo !== "";
    // Back to the symbol: the imported copy is deleted and the project image let go; both can be chosen again.
    const useSymbol = () =>
        runIconChange(async () => {
            if (imported) {
                await WorkspaceService.RemoveWorkspaceIcon(ws.oid);
            }
            if (source.logo) {
                await setWorkspaceLogo(ws.oid, null);
            }
            return { ok: true, text: translateNow("workspace.edit.backToSymbol") };
        });
    const chooseLogo = (logo: string) => {
        if (imported) {
            setPendingLogo(logo);
            return;
        }
        fireAndForget(() => setWorkspaceLogo(ws.oid, logo));
    };
    // The image goes first: if removing it fails, the logo is not set under an image that still wins.
    const confirmLogo = () => {
        const logo = pendingLogo;
        setPendingLogo(null);
        runIconChange(async () => {
            await WorkspaceService.RemoveWorkspaceIcon(ws.oid);
            await setWorkspaceLogo(ws.oid, logo);
            return { ok: true, text: translateNow("workspace.edit.using", { name: pathBaseName(logo) }) };
        });
    };
    const drop = useIconDrop(importPath, (text) => {
        setMode("image");
        setResult({ ok: false, text });
    });
    return (
        <Section title={t("workspace.edit.identity")} concept="identity">
            <div className="flex min-w-0 items-start gap-3">
                <RailBadgePreview ws={ws} over={drop.over} dropHandlers={drop.handlers} />
                <div className="min-w-0 flex-1">
                    <label htmlFor={nameId} className={cn(FieldLabelClass, "flex")}>
                        {t("workspace.edit.name")}
                    </label>
                    <input
                        id={nameId}
                        ref={nameRef}
                        type="text"
                        value={name}
                        spellCheck={false}
                        aria-invalid={invalid}
                        aria-describedby={errorId}
                        onChange={(e) => onName(e.target.value)}
                        className={cn(
                            "w-full min-w-0 rounded-4 border bg-transparent px-2 py-1.5 text-13 leading-5 text-primary outline-none focus:border-accent",
                            invalid ? "border-error focus:border-error" : "border-border"
                        )}
                    />
                    <div id={errorId} aria-live="polite" className="mt-1 min-h-4 text-12 text-error">
                        {invalid ? emptyNameError() : ""}
                    </div>
                </div>
            </div>
            <div className="mt-1 flex min-w-0 flex-col gap-3">
                <div className="min-w-0" role="group" aria-labelledby={iconLabelId} data-role="icon-field">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div id={iconLabelId} className="text-12 text-secondary">
                            {t("workspace.edit.icon")}
                        </div>
                        <ToggleGroup<IconMode>
                            label={t("workspace.edit.iconKind")}
                            options={IconModes.map((s) => ({ ...s, label: t(s.label) }))}
                            selected={mode}
                            onSelect={(next) => setMode(next)}
                        />
                    </div>
                    {mode === "symbol" ? (
                        <div className="flex min-w-0 flex-col gap-1.5">
                            {showsImage ? (
                                <div className="flex flex-wrap items-center gap-2 text-12 text-muted">
                                    <span className="min-w-0 flex-1">{t("workspace.edit.railShowsImage")}</span>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={useSymbol}
                                        data-action="use-symbol"
                                        className={cn(GhostButtonClass, FocusRingClass)}
                                    >
                                        {t("workspace.edit.useSymbol")}
                                    </button>
                                </div>
                            ) : null}
                            <IconChoices
                                icons={icons}
                                selected={ws.icon}
                                color={ws.color}
                                onSelect={(icon) => save({ icon })}
                            />
                        </div>
                    ) : (
                        <ImagePane
                            ws={ws}
                            logos={logos}
                            over={drop.over}
                            busy={busy}
                            result={result}
                            dropHandlers={drop.handlers}
                            onPick={pick}
                            onLogo={chooseLogo}
                        />
                    )}
                    {pendingLogo ? (
                        <ReplaceImageConfirm onConfirm={confirmLogo} onCancel={() => setPendingLogo(null)} />
                    ) : null}
                </div>
                <ColourField
                    selected={workspaceColourStops(ws).join(",")}
                    logoColours={logoColours}
                    onSelect={saveColour}
                />
            </div>
        </Section>
    );
}

// The symbols are laid out in even rows (#751): wrapping where the width ended left the last one alone on a row.
export const IconGridMaxColumns = 7;

// Columns for `count` items in as few rows as `max` columns allow, the rows as even as they can be (14 by 7: 7 + 7).
export function balancedColumns(count: number, max: number): number {
    if (count <= 0 || max <= 0) {
        return 1;
    }
    const rows = Math.ceil(count / max);
    return Math.ceil(count / rows);
}

export function IconChoices({
    icons,
    selected,
    color,
    onSelect,
}: {
    icons: string[];
    selected: string;
    color: string;
    onSelect: (icon: string) => void;
}) {
    const t = useT();
    return (
        <RadioGrid
            label={t("workspace.edit.symbol")}
            hideLabel
            options={icons}
            selected={selected}
            onSelect={onSelect}
            columns={balancedColumns(icons.length, IconGridMaxColumns)}
            renderOption={(icon, checked, tabIndex) => (
                <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={iconName(icon)}
                    title={iconName(icon)}
                    tabIndex={tabIndex}
                    onClick={() => onSelect(icon)}
                    className={cn(
                        "flex h-8 w-8 cursor-pointer items-center justify-center rounded-3 border text-icon-16 transition-colors duration-120 ease-mt motion-reduce:transition-none",
                        FocusRingClass,
                        checked
                            ? "border-accent bg-accent/10 text-primary"
                            : "border-transparent text-secondary hover:bg-hover hover:text-primary"
                    )}
                >
                    <i className={makeIconClass(icon, true)} style={checked ? { color } : undefined} />
                </button>
            )}
        />
    );
}

const SwatchClass = "m-0.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-12";
const SwatchCheckedClass = "ring-2 ring-primary ring-offset-2 ring-offset-modalbg";
const ColourGroupLabelClass = "mb-1 text-11 text-muted";

// A row of swatches: flat colours and gradients alike (a choice is "#a" or "#a,#b[,#c]", workspace-colour.ts).
export function ColourChoices({
    colors,
    selected,
    onSelect,
    label,
    names,
}: {
    colors: string[];
    selected: string;
    onSelect: (color: string) => void;
    // A sub-group of the Colour field is named in a smaller label; alone, the row is the Colour field.
    label?: string;
    names?: Record<string, string>;
}) {
    const t = useT();
    const selectedChoice = colourStops(selected).join(",");
    return (
        <RadioGrid
            label={label ?? t("workspace.edit.colour")}
            labelClass={label ? ColourGroupLabelClass : undefined}
            options={colors}
            selected={colors.find((c) => colourStops(c).join(",") === selectedChoice) ?? selected}
            onSelect={onSelect}
            renderOption={(color, checked, tabIndex) => {
                const name = names?.[color] ?? colourName(color);
                return (
                    <button
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        aria-label={name}
                        title={name}
                        tabIndex={tabIndex}
                        onClick={() => onSelect(color)}
                        data-colour={color}
                        className={cn(SwatchClass, FocusRingClass, checked && SwatchCheckedClass)}
                        style={{ background: colourChoiceCss(color) }}
                    >
                        {checked ? (
                            <i
                                className="fa fa-solid fa-check"
                                style={{ color: colourChoiceForeground(color) }}
                                aria-hidden
                            />
                        ) : null}
                    </button>
                );
            }}
        />
    );
}

// The colours of the workspace's image (imported, or its project's logo), once read; none while it shows a symbol.
function useLogoColours(ws: Workspace): string[] {
    const url = workspaceImageUrl(workspaceIconSource(ws));
    const [found, setFound] = useState<{ url: string; colours: string[] }>(null);
    useEffect(() => {
        if (!url) {
            return;
        }
        let live = true;
        logoPalette(url).then((colours) => {
            if (live) {
                setFound({ url, colours });
            }
        });
        return () => {
            live = false;
        };
    }, [url]);
    return found?.url === url ? found.colours : [];
}

// A custom colour (#657): the colour picker, or a hex value typed in. The picker reports every move of its cursor;
// only where it rests is saved.
function CustomColour({ custom, base, onSelect }: { custom: string; base: string; onSelect: (c: string) => void }) {
    const t = useT();
    const hexId = useId();
    const [draft, setDraft] = useState<string>(null);
    const [picking, setPicking] = useState<string>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    const shown = picking ?? custom;
    const onPick = (value: string) => {
        setPicking(value);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            setPicking(null);
            const colour = parseCustomColour(value);
            if (colour) {
                onSelect(colour);
            }
        }, 250);
    };
    const commit = () => {
        const colour = parseCustomColour(draft ?? "");
        setDraft(null);
        if (colour && colour !== custom) {
            onSelect(colour);
        }
    };
    const onHex = (value: string) => {
        setDraft(value);
        const colour = parseCustomColour(value);
        // A 3-digit value is the start of a 6-digit one while typing: it is taken on Enter or when the field is left.
        if (colour && value.replace("#", "").trim().length === 6) {
            onSelect(colour);
        }
    };
    return (
        <div className="min-w-0" data-role="custom-colour">
            <div className={ColourGroupLabelClass}>{t("workspace.edit.customColour")}</div>
            <div className="flex items-center gap-2">
                <label
                    title={t("workspace.edit.pickColour")}
                    className={cn(
                        SwatchClass,
                        "relative focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary",
                        custom && SwatchCheckedClass
                    )}
                    style={{
                        background:
                            shown || "conic-gradient(#ff453a, #ffe900, #58c142, #00ffdb, #429dff, #bf55ec, #ff453a)",
                    }}
                >
                    <input
                        type="color"
                        aria-label={t("workspace.edit.pickColour")}
                        value={shown || base || "#ff7c0d"}
                        onChange={(e) => onPick(e.target.value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                    {custom ? (
                        <i
                            className="fa fa-solid fa-check pointer-events-none"
                            style={{ color: colourChoiceForeground(shown) }}
                            aria-hidden
                        />
                    ) : null}
                </label>
                <label htmlFor={hexId} className="sr-only">
                    {t("workspace.edit.hexColour")}
                </label>
                <input
                    id={hexId}
                    type="text"
                    spellCheck={false}
                    maxLength={7}
                    placeholder="#RRGGBB"
                    value={draft ?? custom}
                    onChange={(e) => onHex(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            commit();
                        }
                    }}
                    className="w-24 min-w-0 rounded-4 border border-border bg-transparent px-2 py-1 font-mono text-12 text-primary outline-none focus:border-accent"
                />
            </div>
        </div>
    );
}

// The Colour field (#657): the logo's colours and gradients first when the workspace shows an image, then the presets,
// the gradients and a custom colour. Each row is its own radio group; the chosen colour is checked in the row it is in.
export function ColourField({
    selected,
    logoColours,
    onSelect,
}: {
    selected: string;
    logoColours: string[];
    onSelect: (choice: string) => void;
}) {
    const t = useT();
    const labelId = useId();
    const logo = logoColourChoices(logoColours);
    const logoNames: Record<string, string> = {};
    logo.forEach((choice) => {
        const stops = colourStops(choice);
        logoNames[choice] =
            stops.length === 1
                ? t("workspace.colours.logoColour", { colour: stops[0] })
                : t("workspace.colours.logoGradient", { colours: stops.join(", ") });
    });
    const known = [...logo, ...PresetColourChoices, ...PresetGradientChoices];
    const stops = colourStops(selected);
    const custom = stops.length === 1 && !known.includes(stops[0]) ? stops[0] : "";
    return (
        <div role="group" aria-labelledby={labelId} data-role="colour-field" className="flex min-w-0 flex-col gap-2">
            <div id={labelId} className="text-12 text-secondary">
                {t("workspace.edit.colour")}
            </div>
            {logo.length > 0 ? (
                <ColourChoices
                    label={t("workspace.edit.fromLogo")}
                    colors={logo}
                    names={logoNames}
                    selected={selected}
                    onSelect={onSelect}
                />
            ) : null}
            <ColourChoices
                label={t("workspace.edit.presetColours")}
                colors={PresetColourChoices}
                selected={selected}
                onSelect={onSelect}
            />
            <ColourChoices
                label={t("workspace.edit.gradients")}
                colors={PresetGradientChoices}
                selected={selected}
                onSelect={onSelect}
            />
            <CustomColour custom={custom} base={stops[0]} onSelect={onSelect} />
        </div>
    );
}

export function DangerSection({ ws, closable, onClose }: { ws: Workspace; closable: boolean; onClose: () => void }) {
    const t = useT();
    const action = dangerAction(closable);
    // The sheet closes first: Delete asks in a native box, Reset in its own dialog (#222).
    const run = () => {
        onClose();
        if (action.kind === "delete") {
            getApi().deleteWorkspace(ws.oid);
        } else {
            askResetWorkspace(ws.oid);
        }
    };
    return (
        <Section title={t("workspace.edit.dangerZone")} concept="danger" tone="danger">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1 basis-48 text-12 text-muted">{action.text}</div>
                <button
                    type="button"
                    className={cn(DangerButtonClass, FocusRingClass)}
                    data-action={action.kind}
                    onClick={run}
                >
                    {action.label}
                </button>
            </div>
        </Section>
    );
}

export function WorkspaceEditSheet({
    workspaceId,
    closable,
    onClose,
}: {
    workspaceId: string;
    closable: boolean;
    onClose: () => void;
}) {
    const t = useT();
    const [ws] = useWaveObjectValue<Workspace>(makeORef("workspace", workspaceId));
    const nameRef = useRef<HTMLInputElement>(null);
    const loaded = ws != null;
    useEffect(() => {
        if (!loaded) {
            return;
        }
        nameRef.current?.focus();
        nameRef.current?.select();
    }, [loaded]);
    useEffect(() => guardFileDrops(), []);
    if (ws == null) {
        return null;
    }
    // The folder's name under the title, its full path on hover (#751): a long path was cut to its start.
    const folder = effectiveWorkspaceFolder(ws);
    return (
        <DialogFrame
            role="workspace-edit"
            title={t("workspace.edit.title")}
            subtitle={pathBaseName(folder) || undefined}
            subtitleClass="font-mono text-11"
            subtitleTooltip={folder || undefined}
            widthClass="w-fit max-w-[min(560px,calc(100vw-32px))]"
            trapFocus
            suite
            onBackdrop={onClose}
            buttons={
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-3 px-4 py-1.5 text-12"
                    onClick={onClose}
                >
                    {t("workspace.edit.done")}
                    <MoltenWave />
                </button>
            }
        >
            <IdentitySection ws={ws} nameRef={nameRef} />
            <Section title={t("workspace.edit.project")} concept="project">
                <WorkspaceProjectBlock ws={ws} />
            </Section>
            <Section title={t("workspace.edit.folder")} concept="folder">
                <WorkspaceFolderLine ws={ws} />
            </Section>
            <DangerSection ws={ws} closable={closable} onClose={onClose} />
        </DialogFrame>
    );
}

function hasDialogOver(): boolean {
    if (typeof document === "undefined") {
        return false;
    }
    return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(
        (el) => el.closest('[data-role="workspace-edit"]') == null
    );
}

// Mounted once by the rail, in every tab view: it shows the sheet of the open request, and picks up a double-click
// handed over by the tab view the window switched away from.
export function WorkspaceEditHost({ entries }: { entries: { id: string }[] }) {
    const model = WorkspaceEditModel.getInstance();
    const request = useAtomValue(model.requestAtom);
    const ws = useAtomValue(atoms.workspace);
    const staticTabId = useAtomValue(atoms.staticTabId);
    const close = () => model.close();
    // A dialog opened over the sheet (the project logo offer) answers Escape first.
    useEscape(() => request != null && !hasDialogOver(), close);
    useEffect(() => {
        listenWorkspaceMenu();
        const onStorage = (e: StorageEvent) => {
            if (e.key === WorkspaceEditIntentKey) {
                pickUpWorkspaceEdit();
            }
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);
    useEffect(() => {
        pickUpWorkspaceEdit();
    }, [ws?.oid, ws?.activetabid, staticTabId]);
    if (request == null) {
        return null;
    }
    return (
        <WorkspaceEditSheet
            key={request.workspaceId}
            workspaceId={request.workspaceId}
            closable={canCloseWorkspace(entries, request.workspaceId)}
            onClose={close}
        />
    );
}
