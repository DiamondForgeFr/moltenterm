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
import { readWorkspaceProject } from "./workspace-project";
import { WorkspaceFolderLine, WorkspaceProjectBlock } from "./workspace-project-section";
import { askResetWorkspace } from "./workspace-reset";
import { canCloseWorkspace } from "./workspace-reset-model";

const SectionHeadingClass = "mb-2 text-xs font-semibold tracking-wide text-secondary uppercase";
const FieldLabelClass = "mb-1 text-xs text-secondary";
const DangerButtonClass =
    "shrink-0 cursor-pointer rounded border border-error px-3 py-1.5 text-xs text-primary transition-colors hover:bg-error/15";
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

// FR-SHELL-031 (#295) puts Import image… here, under the colours: the picker, the drop target and its one-line result
// (aria-live). The preview above then shows the resolved icon.
function ImportImageSlot(): React.ReactNode {
    return null;
}

function RailBadgePreview({ ws }: { ws: Workspace }) {
    const { logo } = readWorkspaceProject(ws);
    return (
        <div className="flex shrink-0 flex-col items-center gap-1">
            <div
                role="img"
                aria-label={`Rail badge: ${iconName(ws.icon)}, ${colourName(ws.color)}${logo ? ", project logo" : ""}`}
                data-role="rail-preview"
                className={cn(RailBadgeClass, "bg-hover")}
            >
                <WorkspaceIcon icon={ws.icon} color={ws.color} logo={logo} />
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
    return (
        <Section title="Identity" first>
            <div className="flex min-w-0 items-start gap-3">
                <RailBadgePreview ws={ws} />
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
                <ImportImageSlot />
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
