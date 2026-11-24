// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Manage contexts (FR-SHELL-158, #2476): create a context, edit its name, description (on several lines), emblem, optional
// folder (#2518: the outer bound of its workspaces) and workspaces (a checklist, where a workspace already in another
// context says where), and delete one after a confirmation that says where its workspaces go. Every write is one call
// to wavesrv (context-store.ts), which validates it.

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useId, useMemo, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { colourStops } from "../workspace-colour";
import { chooseMoltentermPath } from "../workspace-project-store";
import type { WorkspaceRailEntry } from "../workspace-rail-model";
import {
    ChecklistRow,
    contextIdOf,
    contextShownEmblem,
    contextShownName,
    makeChecklist,
    shapeSubjects,
} from "./context-model";
import { createContext, deleteContext, setContextFolder, updateContext, useContexts } from "./context-store";
import { Emblem } from "./emblem";
import { EmblemPicker } from "./emblem-picker";
import { RibbonFace } from "./ribbon";
import { ribbonPaint } from "./ribbon-model";
import { drawShape, shapesInUse, shownShapeId } from "./ribbon-shapes";
import { ShapePicker } from "./shape-picker";
import {
    canDeleteContext,
    clampDescription,
    clampName,
    createRequestOf,
    defaultMoveTarget,
    draftChanged,
    DraftEdits,
    draftOf,
    draftProblem,
    draftWith,
    editedFields,
    isRowChecked,
    newDraft,
    NoEdits,
    toggledRow,
    updateRequestOf,
} from "./manage-model";

const NewId = "new";

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
const DangerButton =
    "cursor-pointer rounded-4 border border-error/60 px-3 py-1.5 text-12 text-danger hover:border-error hover:bg-error/10";
const GhostButton =
    "cursor-pointer rounded-4 px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default";
const FieldClass =
    "h-8 w-full min-w-0 rounded-4 border border-border bg-black/25 px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent";
const TextAreaClass =
    "min-h-[4.5rem] w-full min-w-0 resize-y rounded-4 border border-border bg-black/25 px-2 py-1.5 text-12 leading-5 text-primary outline-none placeholder:text-muted focus:border-accent";

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
    const [edits, setEdits] = useState<DraftEdits>(NoEdits);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const [deleting, setDeleting] = useState(false);

    const creating = selectedId === NewId;
    const selected = contexts.find((c) => c.id === selectedId);
    const rows = useMemo(
        () => makeChecklist(creating ? "" : selectedId, contexts, entries, t),
        [creating, selectedId, contexts, entries, t]
    );
    const subjects = useMemo(() => shapeSubjects(contexts, entries), [contexts, entries]);
    const original = useMemo(
        () =>
            selected != null
                ? draftOf(
                      selected,
                      rows,
                      t,
                      shownShapeId(
                          selected,
                          contexts.findIndex((c) => c.id === selected.id)
                      )
                  )
                : newDraft(),
        [selected, contexts, rows, t]
    );
    const draft = useMemo(() => draftWith(original, rows, edits), [original, rows, edits]);
    const problem = draftProblem(draft, original, contexts.length);
    const changed = draftChanged(draft, original);
    const edit = (patch: DraftEdits["fields"]) => setEdits(editedFields(edits, patch));
    // The colour of the context's ribbon: the workspace choosing it lands on, or for a context to make the first
    // workspace ticked. It paints the shapes and keeps two contexts of the same colour on different shapes.
    const colour =
        subjects.find((s) => s.context.id === selectedId)?.colour ||
        rows.find((r) => r.id === draft.checked[0])?.color ||
        "";
    const { paint, ink } = ribbonPaint(colour);
    // A shape no other context wears and that is not the one the form shows now: "another".
    const drawFor = (own: string, current: string) =>
        drawShape([...shapesInUse(subjects, own), ...(current ? [{ shape: current, colour }] : [])], colour);
    const select = (id: string) => {
        setSelectedId(id);
        setEdits(id === NewId ? editedFields(NoEdits, { shape: drawFor(NewId, "") }) : NoEdits);
        setError(null);
    };
    const toggle = (row: ChecklistRow) => setEdits(toggledRow(edits, row));
    const chooseFolder = () =>
        fireAndForget(async () => {
            const dir = await chooseMoltentermPath({
                kind: "folder",
                title: t("contexts.manage.folderDialog"),
                defaultPath: draft.folder || undefined,
            });
            if (dir) {
                edit({ folder: dir });
            }
        });

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
        if (problem != null || !changed || (!creating && selected == null)) {
            return;
        }
        run(async () => {
            if (creating) {
                const id = await createContext(createRequestOf(draft));
                setSelectedId(id);
                if (id && draft.folder) {
                    await setContextFolder(id, draft.folder);
                }
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
    const problemText =
        problem === "name"
            ? t("contexts.manage.nameRequired")
            : problem === "needsAnother"
              ? t("contexts.manage.needsAnother")
              : "";

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
                            onClick={() => select(NewId)}
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
                                autoFocus
                                className={FieldClass}
                                onChange={(e) => edit({ name: clampName(e.target.value) })}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label htmlFor={descriptionId} className="text-11 text-secondary">
                                {t("contexts.manage.description")}
                            </label>
                            <textarea
                                id={descriptionId}
                                rows={3}
                                value={draft.description}
                                placeholder={t("contexts.manage.descriptionPlaceholder")}
                                data-testid="context-description"
                                className={TextAreaClass}
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
                        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))]">
                            <div className="flex min-w-0 flex-col gap-1.5" data-testid="context-folder-column">
                                <span className="text-11 text-secondary">
                                    {t("contexts.manage.folder")}{" "}
                                    <span className="text-muted">· {t("contexts.manage.folderOptional")}</span>
                                </span>
                                <div
                                    className={cn(
                                        "flex h-8 min-w-0 items-center rounded-4 border border-border bg-black/25 px-2 text-11",
                                        draft.folder ? "font-mono text-primary" : "text-muted"
                                    )}
                                    title={draft.folder || undefined}
                                    data-testid="context-folder"
                                >
                                    <span className="truncate">{draft.folder || t("contexts.manage.folderNone")}</span>
                                </div>
                                <div className="flex gap-1.5">
                                    <button
                                        type="button"
                                        className={PlainButton}
                                        data-testid="context-folder-choose"
                                        onClick={chooseFolder}
                                    >
                                        {t("contexts.manage.folderChoose")}
                                    </button>
                                    <button
                                        type="button"
                                        className={cn(GhostButton, !draft.folder && "invisible")}
                                        data-testid="context-folder-remove"
                                        disabled={!draft.folder}
                                        onClick={() => edit({ folder: "" })}
                                    >
                                        {t("contexts.manage.folderRemove")}
                                    </button>
                                </div>
                                <p className="m-0 text-11 leading-4 text-muted">{t("contexts.manage.folderHint")}</p>
                            </div>
                            <div className="flex min-w-0 flex-col gap-1" data-testid="context-shape-column">
                                <span className="text-11 text-secondary">{t("contexts.shape.label")}</span>
                                <div className="mb-1 flex items-center gap-2">
                                    <RibbonFace
                                        emblem={draft.emblem}
                                        name={draft.name.trim() || t("contexts.manage.newName")}
                                        paint={paint}
                                        ink={ink}
                                        shape={draft.shape}
                                    />
                                </div>
                                <ShapePicker
                                    value={draft.shape}
                                    paint={paint}
                                    onChange={(shape) => edit({ shape })}
                                    onDrawAnother={() => edit({ shape: drawFor(selectedId, draft.shape) })}
                                />
                            </div>
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
                                                        checked={isRowChecked(edits, row)}
                                                        data-testid="context-workspace"
                                                        data-workspace-id={row.id}
                                                        onChange={() => toggle(row)}
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
