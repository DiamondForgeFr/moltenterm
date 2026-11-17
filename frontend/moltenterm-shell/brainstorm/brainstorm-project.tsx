// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The project card (FR-BOSS-010 AC14, AC15, DS-BOSS-009, #2250): in the free space of the brainstorm layer, once Brokk
// concluded and proposed to make it a project. Before the click it shows exactly what the click makes: the full path
// (its parent folder chosen once, its name from the brief, editable), that git starts in it, the copy of the brainstorm
// in docs/brainstorm.md, and the workspace, a new one or one the developer has. After it: Show in folder and Go to the
// workspace. A refusal says why in one sentence and offers Try again. It is the only way out of a clear brainstorm in
// MoltenTerm 1.0.0: nothing here names Geargrim while DiamondForge does not offer the hand-off.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useId } from "react";
import { BossBubbleModel } from "../boss/boss-store";
import { TFunction, useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import type { BrainstormState } from "./brainstorm-boot";
import type { ProjectBrief } from "./brainstorm-brief-model";
import {
    canCreate,
    choiceAmong,
    nameProblem,
    projectCardOf,
    ProjectFailure,
    ProjectPreview,
    refusalKey,
    replacedProject,
    WorkspaceChoice,
    WorkspaceOption,
} from "./brainstorm-project-model";
import { BrainstormProjectModel } from "./brainstorm-project-store";
import "./brainstorm-project.css";

const NewValue = "new";

function choiceValue(choice: WorkspaceChoice): string {
    return choice.kind === "existing" ? choice.id : NewValue;
}

// The workspace the project goes to. An existing one linked to another folder has its link replaced: the card says so.
function WorkspaceField({
    brief,
    choice,
    workspaces,
    disabled,
    dir,
}: {
    brief: ProjectBrief;
    choice: WorkspaceChoice;
    workspaces: WorkspaceOption[];
    disabled: boolean;
    dir: string;
}) {
    const t = useT();
    const id = useId();
    const model = BrainstormProjectModel.getInstance();
    const replaced = replacedProject(choice, workspaces, dir);
    return (
        <>
            <div className="mt-bsj-line">
                <label className="mt-bsj-key" htmlFor={id}>
                    {t("boss.brainstorm.project.workspace")}
                </label>
                <select
                    id={id}
                    className="mt-bsj-select cursor-pointer"
                    value={choiceValue(choice)}
                    disabled={disabled}
                    data-testid="brainstorm-project-workspace"
                    onChange={(e) =>
                        model.choose(
                            e.target.value === NewValue ? { kind: "new" } : { kind: "existing", id: e.target.value }
                        )
                    }
                >
                    <option value={NewValue}>{t("boss.brainstorm.project.newWorkspace", { name: brief.name })}</option>
                    {workspaces.map((ws) => (
                        <option key={ws.id} value={ws.id}>
                            {ws.name}
                        </option>
                    ))}
                </select>
            </div>
            {replaced !== "" ? (
                <p className="mt-bsj-note mt-bsj-replaces" data-testid="brainstorm-project-replaces">
                    {t("boss.brainstorm.project.replaces", { folder: replaced })}
                </p>
            ) : null}
        </>
    );
}

// One sentence and Try again. When wavesrv did not answer the click, whether the project was made is not known: the
// card offers to look at the folder rather than say that nothing was made.
function Failure({
    failure,
    onRetry,
    name,
    folder,
}: {
    failure: ProjectFailure;
    onRetry: () => void;
    name: string;
    folder?: string;
}) {
    const t = useT();
    if (failure == null) {
        return null;
    }
    const model = BrainstormProjectModel.getInstance();
    return (
        <div className="mt-bsj-failure" role="alert" data-testid="brainstorm-project-failure" data-refusal={failure}>
            <span>{t(refusalKey(failure), { name })}</span>
            {failure === "unknown" && folder ? (
                <button
                    type="button"
                    className="mt-bsj-link cursor-pointer"
                    data-testid="brainstorm-project-check-folder"
                    onClick={() => model.showFolder(folder)}
                >
                    {t("boss.brainstorm.project.show")}
                </button>
            ) : null}
            <button
                type="button"
                className="mt-bsj-link cursor-pointer"
                data-testid="brainstorm-project-retry"
                onClick={onRetry}
            >
                {t("boss.brainstorm.project.tryAgain")}
            </button>
        </div>
    );
}

function Working({ t }: { t: TFunction }) {
    return (
        <div className="mt-bsj-working" data-testid="brainstorm-project-working">
            <DominoLoader />
            <span>{t("boss.brainstorm.project.making")}</span>
        </div>
    );
}

// Before the click: everything the click makes, and the button that makes it.
function Ready({
    brief,
    preview,
    typed,
    choice,
    workspaces,
    busy,
    failure,
    name,
}: {
    brief: ProjectBrief;
    preview: ProjectPreview;
    typed: string;
    choice: WorkspaceChoice;
    workspaces: WorkspaceOption[];
    busy: boolean;
    failure: ProjectFailure;
    name: string;
}) {
    const t = useT();
    const nameId = useId();
    const model = BrainstormProjectModel.getInstance();
    const value = typed !== "" ? typed : brief.slug;
    const badName = nameProblem(value) !== "";
    const noParent = preview?.refusal === "noparent" || failure === "noparent";
    const chooseParent = () => void model.chooseParent(t("boss.brainstorm.project.chooseTitle"));
    return (
        <>
            <div className="mt-bsj-line">
                <span className="mt-bsj-key">{t("boss.brainstorm.project.folder")}</span>
                {noParent ? (
                    <button
                        type="button"
                        className="mt-bsj-btn cursor-pointer"
                        data-testid="brainstorm-project-choose-parent"
                        onClick={chooseParent}
                    >
                        <i className={makeIconClass("folder-open", false)} aria-hidden />
                        {t("boss.brainstorm.project.chooseParent")}
                    </button>
                ) : (
                    <span className="mt-bsj-path-row">
                        {preview == null ? (
                            <DominoLoader label={t("boss.brainstorm.project.previewing")} />
                        ) : (
                            <code className="mt-bsj-path" title={preview.path} data-testid="brainstorm-project-path">
                                {preview.path ?? ""}
                            </code>
                        )}
                        <button
                            type="button"
                            className="mt-bsj-link cursor-pointer"
                            data-testid="brainstorm-project-change-parent"
                            disabled={busy}
                            onClick={chooseParent}
                        >
                            {t("boss.brainstorm.project.change")}
                        </button>
                    </span>
                )}
            </div>
            <div className="mt-bsj-line">
                <label className="mt-bsj-key" htmlFor={nameId}>
                    {t("boss.brainstorm.project.name")}
                </label>
                <input
                    id={nameId}
                    className={cn("mt-bsj-input", badName && "is-bad")}
                    value={value}
                    maxLength={64}
                    disabled={busy}
                    spellCheck={false}
                    aria-invalid={badName || undefined}
                    data-testid="brainstorm-project-name"
                    onChange={(e) => model.setName(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                />
            </div>
            <ul className="mt-bsj-facts" data-testid="brainstorm-project-facts">
                {preview?.exists ? <li>{t("boss.brainstorm.project.existing")}</li> : null}
                <li>{t("boss.brainstorm.project.git")}</li>
                <li>{t("boss.brainstorm.project.copy", { file: preview?.docs || "docs/brainstorm.md" })}</li>
            </ul>
            <WorkspaceField
                brief={brief}
                choice={choice}
                workspaces={workspaces}
                disabled={busy}
                dir={preview?.path ?? ""}
            />
            <Failure
                failure={failure ?? (badName ? "badname" : ((preview?.refusal || null) as ProjectFailure))}
                name={name}
                folder={preview?.parent}
                onRetry={() => void model.recheck()}
            />
            {busy ? (
                <Working t={t} />
            ) : (
                <button
                    type="button"
                    className="molten-btn mt-bsj-create cursor-pointer rounded-4 px-3 py-1.5 text-12"
                    disabled={!canCreate(preview, value, busy) || failure != null}
                    data-testid="brainstorm-project-create"
                    onClick={() => void model.create()}
                >
                    {t("boss.brainstorm.project.create", { name: preview?.name || value })}
                    <MoltenWave />
                </button>
            )}
        </>
    );
}

// After the click: where the project is, its workspace, and the two ways on.
function Done({
    state,
    choice,
    workspaces,
    busy,
    failure,
    name,
}: {
    state: BrainstormState;
    choice: WorkspaceChoice;
    workspaces: WorkspaceOption[];
    busy: boolean;
    failure: ProjectFailure;
    name: string;
}) {
    const t = useT();
    const model = BrainstormProjectModel.getInstance();
    const promotion = state.brainstorm.promotedto;
    const workspace = workspaces.find((ws) => ws.id === promotion.workspace);
    return (
        <>
            <div className="mt-bsj-done" data-testid="brainstorm-project-done">
                <i className={makeIconClass("check", false)} aria-hidden />
                <span>{t("boss.brainstorm.project.done")}</span>
            </div>
            <code className="mt-bsj-path" title={promotion.dir} data-testid="brainstorm-project-dir">
                {promotion.dir}
            </code>
            {promotion.workspace ? (
                <p className="mt-bsj-note" data-testid="brainstorm-project-linked">
                    {workspace != null
                        ? t("boss.brainstorm.project.linked", { workspace: workspace.name })
                        : t("boss.brainstorm.project.linkedThere")}
                </p>
            ) : (
                <>
                    <p className="mt-bsj-note">{t("boss.brainstorm.project.notLinked")}</p>
                    {state.brief != null ? (
                        <WorkspaceField
                            brief={state.brief}
                            choice={choice}
                            workspaces={workspaces}
                            disabled={busy}
                            dir={promotion.dir}
                        />
                    ) : null}
                </>
            )}
            <Failure failure={failure} name={name} onRetry={() => void model.link(promotion.dir)} />
            {busy ? <Working t={t} /> : null}
            <div className="mt-bsj-acts">
                <button
                    type="button"
                    className="mt-bsj-btn cursor-pointer"
                    data-testid="brainstorm-project-show"
                    onClick={() => model.showFolder(promotion.dir)}
                >
                    <i className={makeIconClass("folder-open", false)} aria-hidden />
                    {t("boss.brainstorm.project.show")}
                </button>
                {promotion.workspace ? (
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                        title={t("boss.brainstorm.project.goToTitle")}
                        data-testid="brainstorm-project-goto"
                        onClick={() => void model.goTo(promotion.workspace)}
                    >
                        {workspace != null
                            ? t("boss.brainstorm.project.goTo", { workspace: workspace.name })
                            : t("boss.brainstorm.project.goToThere")}
                        <MoltenWave />
                    </button>
                ) : state.brief != null && !busy ? (
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                        data-testid="brainstorm-project-link"
                        onClick={() => void model.link(promotion.dir)}
                    >
                        {t("boss.brainstorm.project.link")}
                        <MoltenWave />
                    </button>
                ) : null}
            </div>
        </>
    );
}

export function ProjectCard({ state }: { state: BrainstormState }) {
    const t = useT();
    const model = BrainstormProjectModel.getInstance();
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const preview = useAtomValue(model.previewAtom, { store: globalStore });
    const typed = useAtomValue(model.nameAtom, { store: globalStore });
    const chosen = useAtomValue(model.choiceAtom, { store: globalStore });
    const workspaces = useAtomValue(model.workspacesAtom, { store: globalStore });
    const busy = useAtomValue(model.busyAtom, { store: globalStore });
    const failure = useAtomValue(model.failureAtom, { store: globalStore });
    const folded = useAtomValue(model.foldedAtom, { store: globalStore });
    const card = projectCardOf(state);
    const shows = card.kind === "ready" || card.kind === "done";
    const brainstormId = state?.brainstorm?.id ?? "";
    const briefId = state?.brief?.id ?? "";
    useEffect(() => {
        if (shows) {
            void model.show();
        }
    }, [shows, brainstormId, briefId]);
    if (card.kind === "none") {
        return null;
    }
    const choice = choiceAmong(chosen, workspaces);
    return (
        <section
            className={cn("mt-bsj", folded && "is-folded")}
            aria-label={t("boss.brainstorm.project.label")}
            data-testid="brainstorm-project"
            data-kind={card.kind}
        >
            <div className="mt-bsj-eyebrow">
                <i className={makeIconClass("hammer", false)} aria-hidden />
                <span className="mt-bsj-eyebrow-text">{t("boss.brainstorm.project.eyebrow")}</span>
                <button
                    type="button"
                    className="mt-bsj-fold cursor-pointer"
                    aria-expanded={!folded}
                    aria-label={t(folded ? "boss.brainstorm.project.unfold" : "boss.brainstorm.project.fold")}
                    title={t(folded ? "boss.brainstorm.project.unfold" : "boss.brainstorm.project.fold")}
                    data-testid="brainstorm-project-fold"
                    onClick={() => model.toggleFold()}
                >
                    <i className={makeIconClass(folded ? "chevron-up" : "chevron-down", false)} aria-hidden />
                </button>
            </div>
            {folded ? null : (
                <div className="mt-bsj-body">
                    {card.kind === "waiting" ? (
                        <p className="mt-bsj-note" data-testid="brainstorm-project-waiting">
                            {t("boss.brainstorm.project.waiting", { name })}
                        </p>
                    ) : (
                        <>
                            {card.brief != null ? (
                                <div className="mt-bsj-head">
                                    <div className="mt-bsj-title" title={card.brief.name}>
                                        {card.brief.name}
                                    </div>
                                    <p className="mt-bsj-pitch">{card.brief.pitch}</p>
                                </div>
                            ) : null}
                            {card.kind === "ready" ? (
                                <Ready
                                    brief={card.brief}
                                    preview={preview}
                                    typed={typed}
                                    choice={choice}
                                    workspaces={workspaces}
                                    busy={busy}
                                    failure={failure}
                                    name={name}
                                />
                            ) : (
                                <Done
                                    state={state}
                                    choice={choice}
                                    workspaces={workspaces}
                                    busy={busy}
                                    failure={failure}
                                    name={name}
                                />
                            )}
                        </>
                    )}
                </div>
            )}
        </section>
    );
}
