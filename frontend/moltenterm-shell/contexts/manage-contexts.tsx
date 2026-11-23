// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Manage contexts (FR-SHELL-158, #2476): create a context, edit its name, description, emblem and workspaces (a
// checklist, where a workspace already in another context says where), and delete one after a confirmation that says
// where its workspaces go. Every write is one call to wavesrv (context-store.ts), which validates it.

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useId, useMemo, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { colourStops } from "../workspace-colour";
import type { WorkspaceRailEntry } from "../workspace-rail-model";
import { contextIdOf, contextShownEmblem, contextShownName, makeChecklist } from "./context-model";
import { createContext, deleteContext, updateContext, useContexts } from "./context-store";
import { Emblem } from "./emblem";
import { EmblemPicker } from "./emblem-picker";
import {
    canDeleteContext,
    clampDescription,
    clampName,
    ContextDraft,
    createRequestOf,
    defaultMoveTarget,
    draftChanged,
    draftOf,
    draftProblem,
    newDraft,
    updateRequestOf,
} from "./manage-model";
import { ManageContextsOpenAtom } from "./ribbon-host";

const NewId = "new";

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
const DangerButton =
    "cursor-pointer rounded-4 border border-error/60 px-3 py-1.5 text-12 text-danger hover:border-error hover:bg-error/10";
const FieldClass =
    "h-8 w-full min-w-0 rounded-4 border border-border bg-black/25 px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent";

export function ManageContextsHost({ entries }: { entries: WorkspaceRailEntry[] }) {
    const open = useAtomValue(ManageContextsOpenAtom);
    const setOpen = useSetAtom(ManageContextsOpenAtom);
    if (!open) {
        return null;
    }
    return <ManageContextsDialog entries={entries} onClose={() => setOpen(false)} />;
}

function DeleteContextDialog({
    name,
    count,
    targets,
    initialTarget,
    onCancel,
    onConfirm,
}: {
    name: string;
    count: number;
    targets: { id: string; name: string }[];
    initialTarget: string;
    onCancel: () => void;
    onConfirm: (moveTo: string) => void;
}) {
    const t = useT();
    const tc = useTCount();
    const selectId = useId();
    const [target, setTarget] = useState(initialTarget);
    return (
        <DialogFrame
            role="context-delete"
            title={t("contexts.delete.title", { name })}
            subtitleWraps
            onEscape={onCancel}
            buttons={
                <>
                    <button type="button" className={PlainButton} onClick={onCancel} autoFocus>
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className={DangerButton}
                        data-testid="context-delete-confirm"
                        onClick={() => onConfirm(target)}
                    >
                        {t("contexts.delete.confirm")}
                    </button>
                </>
            }
        >
            <p>{count === 0 ? t("contexts.delete.none") : tc("contexts.delete.body", count)}</p>
            {count > 0 ? (
                <div className="mt-3 flex flex-col gap-1">
                    <label htmlFor={selectId} className="text-11 text-secondary">
                        {t("contexts.delete.target")}
                    </label>
                    <select
                        id={selectId}
                        value={target}
                        className={cn(FieldClass, "cursor-pointer")}
                        onChange={(e) => setTarget(e.target.value)}
                    >
                        {targets.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name}
                            </option>
                        ))}
                    </select>
                </div>
            ) : null}
        </DialogFrame>
    );
}

export function ManageContextsDialog({ entries, onClose }: { entries: WorkspaceRailEntry[]; onClose: () => void }) {
    const t = useT();
    const contexts = useContexts();
    const ws = useAtomValue(atoms.workspace);
    const nameId = useId();
    const descriptionId = useId();
    const [selectedId, setSelectedId] = useState(() => contextIdOf(contexts, ws?.meta));
    const [edits, setEdits] = useState<ContextDraft>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const [deleting, setDeleting] = useState(false);

    const creating = selectedId === NewId;
    const selected = contexts.find((c) => c.id === selectedId);
    const rows = useMemo(
        () => makeChecklist(creating ? "" : selectedId, contexts, entries, t),
        [creating, selectedId, contexts, entries, t]
    );
    const original = useMemo(
        () => (selected != null ? draftOf(selected, rows, t) : (edits ?? newDraft())),
        [selected, rows, t, edits]
    );
    const draft = edits ?? original;
    const problem = draftProblem(draft, original, contexts.length);
    const changed = draftChanged(draft, original);
    const edit = (patch: Partial<ContextDraft>) => setEdits({ ...draft, ...patch });
    const select = (id: string) => {
        setSelectedId(id);
        setEdits(null);
        setError(null);
    };
    const toggle = (id: string) =>
        edit({ checked: draft.checked.includes(id) ? draft.checked.filter((c) => c !== id) : [...draft.checked, id] });

    const run = (work: () => Promise<void>) => {
        if (busy) {
            return;
        }
        setBusy(true);
        setError(null);
        fireAndForget(async () => {
            try {
                await work();
            } catch (e) {
                setError(t("contexts.manage.failed", { error: e instanceof Error ? e.message : String(e) }));
            } finally {
                setBusy(false);
            }
        });
    };
    const save = () => {
        if (problem != null || !changed) {
            return;
        }
        run(async () => {
            if (creating) {
                const id = await createContext(createRequestOf(draft));
                setSelectedId(id);
                setEdits({ ...draft, id });
                return;
            }
            const req = updateRequestOf(draft, original);
            if (req != null) {
                await updateContext(req);
            }
        });
    };
    const confirmDelete = (moveTo: string) => {
        setDeleting(false);
        run(async () => {
            await deleteContext(selectedId, moveTo);
            select(moveTo);
        });
    };

    const targets = contexts
        .filter((c) => c.id !== selectedId)
        .map((c) => ({ id: c.id, name: contextShownName(c, t) }));
    const members = entries.filter((e) => e.contextId === selectedId).length;
    const deletable = !creating && canDeleteContext(contexts, selectedId);
    const problemText = problem === "name" ? t("contexts.manage.nameRequired") : problem === "needsAnother" ? t("contexts.manage.needsAnother") : "";

    return (
        <>
            <DialogFrame
                role="contexts-manage"
                title={t("contexts.manage.title")}
                subtitle={t("contexts.manage.subtitle")}
                subtitleWraps
                wide
                onEscape={onClose}
                onBackdrop={onClose}
                buttons={
                    <>
                        {deletable ? (
                            <button
                                type="button"
                                className={cn(DangerButton, "mr-auto")}
                                data-testid="context-delete"
                                disabled={busy}
                                onClick={() => setDeleting(true)}
                            >
                                {t("contexts.manage.delete")}
                            </button>
                        ) : null}
                        <button type="button" className={PlainButton} onClick={onClose} data-testid="context-close">
                            {t("contexts.manage.close")}
                        </button>
                        <button
                            type="button"
                            className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50"
                            data-testid="context-save"
                            disabled={busy || problem != null || !changed}
                            onClick={save}
                        >
                            {creating ? t("contexts.manage.create") : t("contexts.manage.save")}
                            <MoltenWave />
                        </button>
                    </>
                }
            >
                <div className="flex min-h-[22rem] gap-4">
                    <nav aria-label={t("contexts.manage.list")} className="flex w-44 shrink-0 flex-col gap-1">
                        {contexts.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                aria-current={c.id === selectedId ? "true" : undefined}
                                data-testid="context-list-item"
                                className={cn(
                                    "flex cursor-pointer items-center gap-2 rounded-4 px-2 py-1.5 text-left text-12 text-secondary hover:bg-hover hover:text-primary",
                                    c.id === selectedId && "mt-selected-action bg-hover text-primary"
                                )}
                                onClick={() => select(c.id)}
                            >
                                <Emblem name={contextShownEmblem(c)} size={14} />
                                <span className="min-w-0 truncate">{contextShownName(c, t)}</span>
                            </button>
                        ))}
                        <button
                            type="button"
                            aria-current={creating ? "true" : undefined}
                            data-testid="context-new"
                            className={cn(
                                "cursor-pointer rounded-4 border border-dashed border-border px-2 py-1.5 text-left text-12 text-secondary hover:bg-hover hover:text-primary",
                                creating && "mt-selected-action bg-hover text-primary"
                            )}
                            onClick={() => {
                                select(NewId);
                                setEdits(newDraft());
                            }}
                        >
                            + {t("contexts.manage.new")}
                        </button>
                    </nav>
                    <form
                        className="flex min-w-0 flex-1 flex-col gap-3"
                        data-testid="context-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            save();
                        }}
                    >
                        <div className="flex flex-col gap-1">
                            <label htmlFor={nameId} className="text-11 text-secondary">
                                {t("contexts.manage.name")}
                            </label>
                            <input
                                id={nameId}
                                type="text"
                                value={draft.name}
                                placeholder={t("contexts.manage.namePlaceholder")}
                                data-testid="context-name"
                                className={FieldClass}
                                onChange={(e) => edit({ name: clampName(e.target.value) })}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label htmlFor={descriptionId} className="text-11 text-secondary">
                                {t("contexts.manage.description")}
                            </label>
                            <input
                                id={descriptionId}
                                type="text"
                                value={draft.description}
                                placeholder={t("contexts.manage.descriptionPlaceholder")}
                                data-testid="context-description"
                                className={FieldClass}
                                onChange={(e) => edit({ description: clampDescription(e.target.value) })}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <span className="text-11 text-secondary">{t("contexts.manage.emblem")}</span>
                            <div className="mb-1 flex items-center gap-2 text-12 text-primary">
                                <Emblem name={draft.emblem} size={16} />
                                <span>{t("contexts.emblem.current", { name: draft.emblem })}</span>
                            </div>
                            <EmblemPicker value={draft.emblem} onChange={(emblem) => edit({ emblem })} />
                        </div>
                        <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
                            <legend className="mb-1 p-0 text-11 text-secondary">
                                {t("contexts.manage.workspaces")}
                            </legend>
                            {rows.length === 0 ? (
                                <p className="text-12 text-muted">{t("contexts.manage.noWorkspaces")}</p>
                            ) : (
                                <ul className="m-0 flex max-h-40 list-none flex-col gap-0.5 overflow-y-auto p-0">
                                    {rows.map((row) => {
                                        const stops = colourStops(row.color);
                                        return (
                                            <li key={row.id}>
                                                <label className="flex cursor-pointer items-center gap-2 rounded-4 px-1.5 py-1 text-12 text-primary hover:bg-hover">
                                                    <input
                                                        type="checkbox"
                                                        checked={draft.checked.includes(row.id)}
                                                        data-testid="context-workspace"
                                                        data-workspace-id={row.id}
                                                        onChange={() => toggle(row.id)}
                                                    />
                                                    <i
                                                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                                                        style={{ background: stops[0] ?? "var(--color-secondary)" }}
                                                        aria-hidden
                                                    />
                                                    <span className="min-w-0 truncate">{row.name}</span>
                                                    {row.elsewhere ? (
                                                        <span className="ml-auto shrink-0 text-11 text-muted">
                                                            {t("contexts.manage.elsewhere", { context: row.elsewhere })}
                                                        </span>
                                                    ) : null}
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </fieldset>
                        {problemText || error ? (
                            <p className="text-12 text-danger" role="alert" data-testid="context-problem">
                                {error ?? problemText}
                            </p>
                        ) : null}
                    </form>
                </div>
            </DialogFrame>
            {deleting ? (
                <DeleteContextDialog
                    name={contextShownName(selected, t)}
                    count={members}
                    targets={targets}
                    initialTarget={defaultMoveTarget(contexts, selectedId)}
                    onCancel={() => setDeleting(false)}
                    onConfirm={confirmDelete}
                />
            ) : null}
        </>
    );
}
