// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The new-workspace page (FR-SHELL-082): it takes the sidebar's page while a pending dot waits at the end of the bottom
// row, in the colour and with the letter typed here. Pulling past the last workspace or the + menu opens it. The
// workspace editor keeps everything else (icon, image, project details) for later.

import { WorkspaceService } from "@/app/store/services";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { colourChoiceCss, colourChoiceForeground } from "../workspace-colour";
import { colourName } from "../workspace-edit-model";
import { chooseMoltentermPath, linkWorkspaceProject } from "../workspace-project-store";
import { CreateColours, CreateDraft, pendingLetter, typeSuggestions } from "./sidebar-create-model";
import { ProjectTypeMetaKey } from "./sidebar-model";
import { SidebarModel } from "./sidebar-store";
import { switchFromSidebar } from "./sidebar-switch";

const FieldClass =
    "mt-1 w-full min-w-0 rounded-4 border border-white/15 bg-black/25 px-2 py-1.5 text-12 text-primary outline-none placeholder:text-muted focus:border-white/40";
const LabelClass = "flex flex-col text-11 text-secondary";

async function createWorkspace(draft: CreateDraft): Promise<string> {
    const id = await WorkspaceService.CreateWorkspace(draft.name.trim(), "", draft.colour, true);
    if (!id) {
        throw new Error("no workspace id");
    }
    const type = draft.type.trim();
    if (type) {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("workspace", id),
            meta: { [ProjectTypeMetaKey]: type } as MetaType,
        });
    }
    if (draft.folder) {
        await linkWorkspaceProject({ oid: id } as Workspace, draft.folder);
    }
    return id;
}

// Keys typed in the form stay in it: the window's shortcuts (⌘S, ⌥1…) would act behind it.
function keepKeys(e: React.KeyboardEvent) {
    e.stopPropagation();
}

export function CreateWorkspacePage({ draft }: { draft: CreateDraft }) {
    const t = useT();
    const model = SidebarModel.getInstance();
    const nameRef = useRef<HTMLInputElement>(null);
    const listId = useId();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        nameRef.current?.focus();
    }, []);
    const letter = pendingLetter(draft.name);
    const chooseFolder = () =>
        fireAndForget(async () => {
            const folder = await chooseMoltentermPath({
                kind: "folder",
                title: t("sidebar.create.folderDialog"),
                defaultPath: draft.folder || undefined,
            });
            if (folder) {
                model.updateDraft({ folder });
            }
        });
    const submit = () => {
        if (busy) {
            return;
        }
        setBusy(true);
        setError(null);
        fireAndForget(async () => {
            try {
                const id = await createWorkspace(draft);
                model.cancelCreate();
                switchFromSidebar(id, 1);
            } catch (e) {
                setError(t("sidebar.create.failed", { error: e?.message ?? String(e) }));
            } finally {
                setBusy(false);
            }
        });
    };
    return (
        <form
            className="flex flex-col gap-3 px-1 pt-3 pb-2"
            aria-label={t("sidebar.create.title")}
            data-testid="sidebar-create-page"
            onSubmit={(e) => {
                e.preventDefault();
                submit();
            }}
            onKeyDown={(e) => {
                keepKeys(e);
                if (e.key === "Escape") {
                    e.preventDefault();
                    model.cancelCreate();
                }
            }}
        >
            <div
                className="mx-auto flex h-12 w-12 items-center justify-center rounded-10 text-20 font-semibold transition-colors duration-180 ease-mt"
                style={{ background: colourChoiceCss(draft.colour), color: colourChoiceForeground(draft.colour) }}
                aria-hidden
                data-testid="sidebar-create-art"
            >
                {letter}
            </div>
            <div className="text-center">
                <h3 className="m-0 text-13 font-semibold text-primary">{t("sidebar.create.title")}</h3>
                <p className="m-0 mt-1 text-11 text-muted">{t("sidebar.create.lede")}</p>
            </div>
            <label className={LabelClass}>
                {t("sidebar.create.name")}
                <input
                    ref={nameRef}
                    className={FieldClass}
                    value={draft.name}
                    placeholder={t("sidebar.create.namePlaceholder")}
                    data-testid="sidebar-create-name"
                    onChange={(e) => model.updateDraft({ name: e.target.value })}
                />
            </label>
            <label className={LabelClass}>
                {t("sidebar.create.type")}
                <input
                    className={FieldClass}
                    value={draft.type}
                    list={listId}
                    placeholder={t("sidebar.create.typePlaceholder")}
                    data-testid="sidebar-create-type"
                    onChange={(e) => model.updateDraft({ type: e.target.value })}
                />
                <datalist id={listId}>
                    {typeSuggestions(t("sidebar.create.typeSuggestions")).map((s) => (
                        <option key={s} value={s} />
                    ))}
                </datalist>
            </label>
            <div className={LabelClass}>
                {t("sidebar.create.folder")}
                <div className="mt-1 flex min-w-0 items-center gap-1">
                    <button
                        type="button"
                        className={cn(
                            "min-w-0 flex-1 cursor-pointer truncate rounded-4 border border-white/15 bg-black/25 px-2 py-1.5 text-left text-12 text-secondary hover:border-white/40 hover:text-primary",
                            draft.folder && "font-mono text-11"
                        )}
                        title={draft.folder || t("sidebar.create.chooseFolder")}
                        data-testid="sidebar-create-folder"
                        onClick={chooseFolder}
                    >
                        {draft.folder || t("sidebar.create.chooseFolder")}
                    </button>
                    {draft.folder ? (
                        <button
                            type="button"
                            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                            aria-label={t("sidebar.create.clearFolder")}
                            title={t("sidebar.create.clearFolder")}
                            onClick={() => model.updateDraft({ folder: "" })}
                        >
                            <i className="fa fa-solid fa-xmark text-11" aria-hidden />
                        </button>
                    ) : null}
                </div>
            </div>
            <div role="radiogroup" aria-label={t("sidebar.create.colour")} className={LabelClass}>
                {t("sidebar.create.colour")}
                <div className="mt-1.5 flex flex-wrap gap-1">
                    {CreateColours.map((c) => {
                        const on = c === draft.colour;
                        return (
                            <button
                                key={c}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                aria-label={colourName(c)}
                                title={colourName(c)}
                                data-colour={c}
                                className={cn(
                                    "h-5 w-5 cursor-pointer rounded-full border-0 p-0 transition-shadow duration-120 ease-mt",
                                    on && "ring-2 ring-white/80 ring-offset-2 ring-offset-black/40"
                                )}
                                style={{ background: colourChoiceCss(c) }}
                                onClick={() => model.updateDraft({ colour: c })}
                            />
                        );
                    })}
                </div>
            </div>
            {error ? (
                <p className="m-0 text-11 text-danger" role="alert">
                    {error}
                </p>
            ) : null}
            <div className="flex items-center gap-2 pt-1">
                <button
                    type="submit"
                    disabled={busy}
                    className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                    data-testid="sidebar-create-submit"
                >
                    {t("sidebar.create.create")}
                    <MoltenWave />
                </button>
                <button
                    type="button"
                    className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                    data-testid="sidebar-create-cancel"
                    onClick={() => model.cancelCreate()}
                >
                    {t("sidebar.create.cancel")}
                </button>
            </div>
        </form>
    );
}
