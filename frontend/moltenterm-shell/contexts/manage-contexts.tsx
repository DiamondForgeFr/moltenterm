// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Manage contexts (FR-SHELL-158, FR-SHELL-159, #2476, #2534): create a context, edit its name, description (on several
// lines), emblem, ribbon shape, optional folder (#2518: the outer bound of its workspaces) and workspaces (a checklist,
// where a workspace already in another context says where), and delete one after a confirmation that says where its
// workspaces go. Every write is one call to wavesrv (context-store.ts), which validates it.
//
// The dialog is drawn with the suite's blocks, as the workspace sheet is (suite-language.md): Identity, Emblem, Ribbon,
// Workspaces, Folder and the Danger zone, in a grid that puts two blocks side by side while the dialog has the room. Save
// saves and closes; Cancel, the cross, Escape and a press outside close without saving.

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useId, useMemo, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { BlockTag } from "../settings/settings-scope";
import { BlockRows, SectionBlock } from "../suite/suite";
import { suiteIcon, SuiteIconName } from "../suite/suite-icons";
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
import { RibbonFace } from "./ribbon";
import { ribbonPaint } from "./ribbon-model";
import { drawShape, ribbonShape, shapesInUse, shownShapeId } from "./ribbon-shapes";
import { DrawAnotherButton, ShapeGrid } from "./shape-picker";

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
// A row of a block: its title at the left, its control at the right; flush with the block's edges (BlockRows).
const RowClass = "flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3";
const RowTitleClass = "shrink-0 text-12 font-semibold text-primary";

// The blocks sit two by two where the dialog is wide, one under another where it is not: columns are as many as fit
// 21rem, so no breakpoint has to know the window's size.
const BlocksGridClass = "grid min-w-0 flex-1 gap-x-6 [grid-template-columns:repeat(auto-fit,minmax(21rem,1fr))]";

function ContextBlock({
    title,
    concept,
    block,
    tone,
    description,
    className,
    children,
    ...rest
}: {
    title: string;
    concept: SuiteIconName;
    block: string;
    tone?: "danger";
    description?: string;
    className?: string;
    children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
    return (
        <SectionBlock
            {...rest}
            title={title}
            icon={suiteIcon(concept)}
            tone={tone}
            description={description}
            data-block={block}
            className={cn("min-w-0", className)}
        >
            {children}
        </SectionBlock>
    );
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

    // `then` runs once the work succeeded: a save closes the dialog, a failed one leaves it open with its error.
    const run = (work: () => Promise<void>, then?: () => void) => {
        if (busy) {
            return;
        }
        setBusy(true);
        setError(null);
        fireAndForget(async () => {
            try {
                await work();
                then?.();
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
                // The context exists from here: a failure of its folder leaves the form on it, so a second save updates it.
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
        }, onClose);
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
                widthClass="w-[1040px]"
                suite
                onEscape={onClose}
                onBackdrop={onClose}
                closeButton={{ label: t("contexts.manage.close"), onClick: onClose, testId: "context-close" }}
                buttons={
                    <>
                        {problemText || error ? (
                            <p
                                className="mr-auto min-w-0 text-12 text-danger"
                                role="alert"
                                data-testid="context-problem"
                            >
                                {error ?? problemText}
                            </p>
                        ) : null}
                        <button type="button" className={PlainButton} onClick={onClose} data-testid="context-cancel">
                            {t("common.cancel")}
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
                <div className="flex gap-6">
                    <div className="w-[190px] shrink-0 border-r border-border pt-8 pr-3">
                        <nav aria-label={t("contexts.manage.list")} className="sticky top-4 flex flex-col gap-1">
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
                                    "mt-1 cursor-pointer rounded-4 border border-dashed border-border px-2 py-1.5 text-left text-12 text-secondary hover:bg-hover hover:text-primary",
                                    creating && "mt-selected-action bg-hover text-primary"
                                )}
                                onClick={() => select(NewId)}
                            >
                                + {t("contexts.manage.new")}
                            </button>
                        </nav>
                    </div>
                    <form
                        className={BlocksGridClass}
                        data-testid="context-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            save();
                        }}
                    >
                        <ContextBlock title={t("contexts.manage.identity")} concept="identity" block="identity">
                            <BlockRows>
                                <div className="flex items-center gap-4 px-5 py-3">
                                    <label htmlFor={nameId} className={RowTitleClass}>
                                        {t("contexts.manage.name")}
                                    </label>
                                    <input
                                        id={nameId}
                                        type="text"
                                        value={draft.name}
                                        placeholder={t("contexts.manage.namePlaceholder")}
                                        data-testid="context-name"
                                        autoFocus
                                        className={cn(FieldClass, "ml-auto max-w-[19rem] flex-1")}
                                        onChange={(e) => edit({ name: clampName(e.target.value) })}
                                    />
                                </div>
                                <div className="flex flex-col gap-1.5 px-5 py-3">
                                    <label htmlFor={descriptionId} className={RowTitleClass}>
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
                            </BlockRows>
                            <BlockTag>{t("contexts.manage.scopeContext")}</BlockTag>
                        </ContextBlock>

                        <ContextBlock title={t("contexts.manage.emblem")} concept="emblem" block="emblem">
                            <EmblemPicker value={draft.emblem} onChange={(emblem) => edit({ emblem })} />
                            <BlockTag title={t("contexts.emblem.current", { name: draft.emblem })}>
                                <Emblem name={draft.emblem} size={12} />
                                <span className="min-w-0 truncate" data-testid="context-emblem-name">
                                    {draft.emblem}
                                </span>
                            </BlockTag>
                        </ContextBlock>

                        <ContextBlock
                            title={t("contexts.manage.ribbon")}
                            concept="ribbon"
                            block="ribbon"
                            description={t("contexts.manage.ribbonHint")}
                            data-testid="context-shape-column"
                        >
                            <ShapeGrid value={draft.shape} paint={paint} onChange={(shape) => edit({ shape })} />
                            <BlockRows>
                                <div className={RowClass}>
                                    <span className="min-w-0 flex-1 truncate text-12 text-muted">
                                        {t(ribbonShape(draft.shape).nameKey)}
                                    </span>
                                    <DrawAnotherButton
                                        className="shrink-0"
                                        onDrawAnother={() => edit({ shape: drawFor(selectedId, draft.shape) })}
                                    />
                                </div>
                            </BlockRows>
                            <span
                                className="absolute top-0 right-5 flex max-w-[60%] -translate-y-1/2"
                                data-testid="context-ribbon-preview"
                            >
                                <RibbonFace
                                    emblem={draft.emblem}
                                    name={draft.name.trim() || t("contexts.manage.newName")}
                                    paint={paint}
                                    ink={ink}
                                    shape={draft.shape}
                                />
                            </span>
                        </ContextBlock>

                        <ContextBlock
                            title={t("contexts.manage.workspaces")}
                            concept="workspace"
                            block="workspaces"
                            description={t("contexts.manage.workspacesHint")}
                        >
                            {rows.length === 0 ? (
                                <p className="m-0 text-12 text-muted">{t("contexts.manage.noWorkspaces")}</p>
                            ) : (
                                <BlockRows
                                    role="group"
                                    aria-label={t("contexts.manage.workspaces")}
                                    className="max-h-60 overflow-y-auto"
                                >
                                    {rows.map((row) => {
                                        const stops = colourStops(row.color);
                                        return (
                                            <label
                                                key={row.id}
                                                className="flex cursor-pointer items-center gap-2.5 px-5 py-1.5 text-12 text-primary hover:bg-hover"
                                            >
                                                <input
                                                    type="checkbox"
                                                    className="cursor-pointer accent-[var(--mt-action)]"
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
                                        );
                                    })}
                                </BlockRows>
                            )}
                            {rows.length > 0 ? (
                                <BlockTag data-testid="context-workspaces-count">
                                    {t("contexts.manage.workspacesCount", {
                                        checked: draft.checked.length,
                                        total: rows.length,
                                    })}
                                </BlockTag>
                            ) : null}
                        </ContextBlock>

                        <ContextBlock
                            title={t("contexts.manage.folder")}
                            concept="folder"
                            block="folder"
                            description={t("contexts.manage.folderHint")}
                            className={deletable ? undefined : "col-span-full"}
                            data-testid="context-folder-column"
                        >
                            <BlockRows>
                                <div className={RowClass}>
                                    <div
                                        className={cn(
                                            "min-w-0 flex-1 truncate text-12",
                                            draft.folder ? "font-mono text-primary" : "text-muted"
                                        )}
                                        title={draft.folder || undefined}
                                        data-testid="context-folder"
                                    >
                                        {draft.folder || t("contexts.manage.folderNone")}
                                    </div>
                                    <div className="flex shrink-0 gap-1.5">
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
                                </div>
                            </BlockRows>
                            <BlockTag>{t("contexts.manage.folderOptional")}</BlockTag>
                        </ContextBlock>

                        {deletable ? (
                            <ContextBlock
                                title={t("contexts.manage.dangerZone")}
                                concept="danger"
                                block="danger"
                                tone="danger"
                            >
                                <BlockRows>
                                    <div className={RowClass}>
                                        <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
                                            <span className={RowTitleClass}>{t("contexts.manage.deleteTitle")}</span>
                                            <span className="text-11 leading-4 text-muted">
                                                {t("contexts.manage.deleteHint")}
                                            </span>
                                        </div>
                                        <button
                                            type="button"
                                            className={cn(DangerButton, "shrink-0")}
                                            data-testid="context-delete"
                                            disabled={busy}
                                            onClick={() => setDeleting(true)}
                                        >
                                            {t("contexts.manage.delete")}
                                        </button>
                                    </div>
                                </BlockRows>
                            </ContextBlock>
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
