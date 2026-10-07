// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace edit sheet (FR-SHELL-030, DS-SHELL-036): Identity, Project, Folder and Danger zone, in that order. A
// change is saved as soon as it is made, as in Wave's editor; Done, Escape and a press outside close it, and the focus
// goes back to what opened it.

import { atoms, getApi } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { accentForeground, parseColor } from "./accent";
import { DialogFrame, useEscape } from "./dialog-frame";
import { MoltenWave } from "./molten-button";
import { listenWorkspaceMenu, pickUpWorkspaceEdit, WorkspaceEditModel } from "./workspace-edit";
import {
    checkWorkspaceName,
    colourName,
    dangerAction,
    EmptyNameError,
    iconName,
    moveRadio,
    radioTabStop,
    WorkspaceEditIntentKey,
} from "./workspace-edit-model";
import { RailBadgeClass, WorkspaceIcon } from "./workspace-icon";
import { hasImportedIcon, iconKindLabel, workspaceIconSource } from "./workspace-icon-model";
import { pathBaseName } from "./workspace-project";
import { WorkspaceFolderLine, WorkspaceProjectBlock } from "./workspace-project-section";
import { chooseMoltentermPath } from "./workspace-project-store";
import { askResetWorkspace } from "./workspace-reset";
import { canCloseWorkspace } from "./workspace-reset-model";

const SectionHeadingClass = "mb-2 text-xs font-semibold tracking-wide text-secondary uppercase";
const FieldLabelClass = "mb-1 text-xs text-secondary";
const DangerButtonClass =
    "shrink-0 cursor-pointer rounded border border-error px-3 py-1.5 text-xs text-primary transition-colors hover:bg-error/15";
const SecondaryButtonClass =
    "shrink-0 cursor-pointer rounded border border-border px-3 py-1.5 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-60";
const NoDroppedFileText = "Drop an image file from your disk";
const ImportFailedText = "The image could not be imported";
const FocusRingClass =
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

function Section({ title, first, children }: { title: string; first?: boolean; children: React.ReactNode }) {
    const id = useId();
    return (
        <section
            aria-labelledby={id}
            data-section={title}
            className={cn("min-w-0", !first && "border-t border-border pt-3")}
        >
            <h3 id={id} className={SectionHeadingClass}>
                {title}
            </h3>
            {children}
        </section>
    );
}

// A radio group with one tab stop; the arrows move the choice and apply it (WAI-ARIA radio group, NFR-SHELL-014).
function RadioGrid({
    label,
    options,
    selected,
    onSelect,
    renderOption,
}: {
    label: string;
    options: string[];
    selected: string;
    onSelect: (value: string) => void;
    renderOption: (value: string, checked: boolean, tabIndex: number) => React.ReactNode;
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
            <div id={labelId} className={FieldLabelClass}>
                {label}
            </div>
            <div
                ref={groupRef}
                role="radiogroup"
                aria-labelledby={labelId}
                onKeyDown={onKeyDown}
                className="flex min-w-0 flex-wrap gap-1"
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
                onRefused(NoDroppedFileText);
                return;
            }
            onPath(path);
        },
    };
    return { over, handlers };
}

// Import image… and the drop target, under the colours (FR-SHELL-031): wavesrv checks and copies the file; the result
// is one line, announced. With an image set, Use built-in icon removes it and its stored copy.
function ImportImageSlot({
    ws,
    over,
    busy,
    result,
    dropHandlers,
    onPick,
    onRemove,
}: {
    ws: Workspace;
    over: boolean;
    busy: boolean;
    result: ImportResult;
    dropHandlers: React.HTMLAttributes<HTMLDivElement>;
    onPick: () => void;
    onRemove: () => void;
}) {
    const labelId = useId();
    const imported = hasImportedIcon(ws);
    return (
        <div className="min-w-0" role="group" aria-labelledby={labelId}>
            <div id={labelId} className={FieldLabelClass}>
                Image
            </div>
            <div
                {...dropHandlers}
                data-role="icon-drop"
                data-over={over ? "true" : undefined}
                className={cn(
                    "rounded border border-dashed px-3 py-2 transition-colors motion-reduce:transition-none",
                    over ? "border-accent bg-accent/10" : "border-border"
                )}
            >
                <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 basis-48 text-xs text-secondary">
                        {over
                            ? "Drop to use this image"
                            : imported
                              ? "Shown in place of the icon and colour, which stay set."
                              : "PNG, JPG, WebP, SVG or ICO, up to 1 MB. Pick one or drop it here."}
                    </span>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onPick}
                        className={cn(SecondaryButtonClass, FocusRingClass)}
                    >
                        {busy ? "Importing…" : imported ? "Replace image…" : "Import image…"}
                    </button>
                    {imported ? (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={onRemove}
                            data-action="use-builtin-icon"
                            className={cn(SecondaryButtonClass, FocusRingClass)}
                        >
                            Use built-in icon
                        </button>
                    ) : null}
                </div>
                <div role="status" aria-live="polite" data-role="icon-import-result" className="min-h-4 text-xs">
                    {result ? (
                        <span className={result.ok ? "text-secondary" : "text-primary"}>
                            {result.ok ? null : (
                                <i className="fa fa-solid fa-circle-exclamation mr-1 text-error" aria-hidden />
                            )}
                            {result.text}
                        </span>
                    ) : null}
                </div>
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
    const source = workspaceIconSource(ws);
    const kind = iconKindLabel(source.image ? "imported" : source.logo ? "logo" : "builtin");
    return (
        <div className="flex shrink-0 flex-col items-center gap-1" {...dropHandlers}>
            <div
                role="img"
                aria-label={`Rail badge: ${iconName(ws.icon)}, ${colourName(ws.color)}${kind ? `, ${kind}` : ""}`}
                data-role="rail-preview"
                className={cn(
                    RailBadgeClass,
                    "bg-hover",
                    over && "outline outline-2 outline-offset-2 outline-accent outline-dashed"
                )}
            >
                <WorkspaceIcon source={source} />
            </div>
            <div className="text-[11px] text-muted" aria-hidden>
                In the rail
            </div>
        </div>
    );
}

function IdentitySection({ ws, nameRef }: { ws: Workspace; nameRef: React.RefObject<HTMLInputElement> }) {
    const nameId = useId();
    const errorId = useId();
    const [draft, setDraft] = useState<string>(null);
    const [choices, setChoices] = useState<{ icons: string[]; colors: string[] }>({ icons: [], colors: [] });
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            const [icons, colors] = await Promise.all([WorkspaceService.GetIcons(), WorkspaceService.GetColors()]);
            if (live) {
                setChoices({ icons: icons ?? [], colors: colors ?? [] });
            }
        });
        return () => {
            live = false;
        };
    }, []);
    const name = draft ?? ws.name ?? "";
    const invalid = checkWorkspaceName(name) == null;
    const save = (next: { name?: string; icon?: string; color?: string }) => {
        const saved = checkWorkspaceName(next.name ?? name) ?? ws.name;
        fireAndForget(() =>
            WorkspaceService.UpdateWorkspace(ws.oid, saved, next.icon ?? ws.icon, next.color ?? ws.color, false)
        );
    };
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
                setResult({ ok: false, text: ImportFailedText });
            } finally {
                setBusy(false);
            }
        });
    };
    const importPath = (path: string) =>
        runIconChange(async () => {
            const refusal = await WorkspaceService.ImportWorkspaceIcon(ws.oid, path);
            return refusal ? { ok: false, text: refusal } : { ok: true, text: `Imported ${pathBaseName(path)}` };
        });
    const pick = () =>
        fireAndForget(async () => {
            const path = await chooseMoltentermPath({ kind: "workspaceicon", title: "Workspace icon" });
            if (path) {
                importPath(path);
            }
        });
    const removeImage = () =>
        runIconChange(async () => {
            await WorkspaceService.RemoveWorkspaceIcon(ws.oid);
            return {
                ok: true,
                text: workspaceIconSource(ws).logo ? "Back to the project logo" : "Back to the built-in icon",
            };
        });
    const drop = useIconDrop(importPath, (text) => setResult({ ok: false, text }));
    return (
        <Section title="Identity" first>
            <div className="flex min-w-0 items-start gap-3">
                <RailBadgePreview ws={ws} over={drop.over} dropHandlers={drop.handlers} />
                <div className="min-w-0 flex-1">
                    <label htmlFor={nameId} className={cn(FieldLabelClass, "flex")}>
                        Name
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
                            "w-full min-w-0 rounded border bg-transparent px-2 py-1.5 text-sm text-primary outline-none focus:border-accent",
                            invalid ? "border-error focus:border-error" : "border-border"
                        )}
                    />
                    <div id={errorId} aria-live="polite" className="mt-1 min-h-4 text-xs text-error">
                        {invalid ? EmptyNameError : ""}
                    </div>
                </div>
            </div>
            <div className="mt-2 flex min-w-0 flex-col gap-3">
                <IconChoices
                    icons={choices.icons}
                    selected={ws.icon}
                    color={ws.color}
                    onSelect={(icon) => save({ icon })}
                />
                <ColourChoices colors={choices.colors} selected={ws.color} onSelect={(color) => save({ color })} />
                <ImportImageSlot
                    ws={ws}
                    over={drop.over}
                    busy={busy}
                    result={result}
                    dropHandlers={drop.handlers}
                    onPick={pick}
                    onRemove={removeImage}
                />
            </div>
        </Section>
    );
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
    return (
        <RadioGrid
            label="Icon"
            options={icons}
            selected={selected}
            onSelect={onSelect}
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
                        "flex h-8 w-8 cursor-pointer items-center justify-center rounded border text-[15px] transition-colors motion-reduce:transition-none",
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

export function ColourChoices({
    colors,
    selected,
    onSelect,
}: {
    colors: string[];
    selected: string;
    onSelect: (color: string) => void;
}) {
    return (
        <RadioGrid
            label="Colour"
            options={colors}
            selected={selected}
            onSelect={onSelect}
            renderOption={(color, checked, tabIndex) => (
                <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={colourName(color)}
                    title={colourName(color)}
                    tabIndex={tabIndex}
                    onClick={() => onSelect(color)}
                    className={cn(
                        "m-0.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-[12px]",
                        FocusRingClass,
                        checked && "ring-2 ring-primary ring-offset-2 ring-offset-modalbg"
                    )}
                    style={{ backgroundColor: color }}
                >
                    {checked ? (
                        <i
                            className="fa fa-solid fa-check"
                            style={{ color: accentForeground(parseColor(color) ?? { r: 0, g: 0, b: 0 }) }}
                            aria-hidden
                        />
                    ) : null}
                </button>
            )}
        />
    );
}

export function DangerSection({ ws, closable, onClose }: { ws: Workspace; closable: boolean; onClose: () => void }) {
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
        <Section title="Danger zone">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1 basis-48 text-xs text-muted">{action.text}</div>
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
    return (
        <DialogFrame
            role="workspace-edit"
            title="Edit workspace"
            subtitle={ws.name}
            widthClass="w-[560px]"
            trapFocus
            onBackdrop={onClose}
            buttons={
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded px-4 py-1.5 text-xs"
                    onClick={onClose}
                >
                    Done
                    <MoltenWave />
                </button>
            }
        >
            <IdentitySection ws={ws} nameRef={nameRef} />
            <Section title="Project">
                <WorkspaceProjectBlock ws={ws} />
            </Section>
            <Section title="Folder">
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
