// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Browser › Bookmarks (FR-BRW-021): the bookmarks of every project of the workspace, project by project and folder by
// folder, edited in place. The panel's Bookmarks menu reads the same meta, so a change shows in both at once. Deleting
// asks for a second click; nothing here opens a page.

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { BookmarkDialog, BookmarkDialogRequest } from "../browser/bookmark-dialog";
import {
    Bookmark,
    BookmarkFolder,
    BookmarkProblem,
    bookmarksOfFolder,
    problemMessage,
    ProjectBookmarks,
    readProjectBookmarks,
} from "../browser/bookmarks";
import {
    copyProjectBookmark,
    createProjectFolder,
    deleteProjectBookmark,
    deleteProjectFolder,
    moveProjectBookmark,
    renameProjectFolder,
} from "../browser/bookmarks-store";
import { AddressIcon } from "../favicon/favicon-mark";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { currentProjectId, projectLabel, readProjects, WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import { suiteIcon } from "../suite/suite-icons";
import { PageCard } from "./settings-page";

const AddButton = "molten-btn inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-3 text-12";
const SecondaryButton =
    "molten-btn-secondary inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12";
const GhostButton =
    "molten-btn-ghost inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12";
const SelectClass =
    "h-row max-w-40 shrink-0 cursor-pointer rounded-4 border border-border bg-transparent px-2 text-12 text-secondary outline-none focus:border-accent";
const InputClass =
    "h-row min-w-0 flex-1 rounded-4 border border-border bg-transparent px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent";

type Report = (problem: BookmarkProblem) => void;

function makeRunner(report: Report) {
    return (action: Promise<BookmarkProblem>) =>
        fireAndForget(async () => {
            report(await action);
        });
}

function BookmarkRow({
    ws,
    project,
    bookmark,
    data,
    others,
    confirming,
    onConfirm,
    onEdit,
    report,
    nested,
}: {
    ws: Workspace;
    project: WorkspaceProjectEntry;
    bookmark: Bookmark;
    data: ProjectBookmarks;
    others: WorkspaceProjectEntry[];
    confirming: boolean;
    onConfirm: (id: string) => void;
    onEdit: (b: Bookmark) => void;
    report: Report;
    // In a folder: indented under the folder's name.
    nested: boolean;
}) {
    const t = useT();
    const run = makeRunner(report);
    return (
        <div
            className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 py-2 pr-5", nested ? "pl-9" : "pl-5")}
            data-testid={`bookmark-row-${bookmark.id}`}
        >
            <div className="min-w-0 flex-1 basis-56">
                <div className="flex min-w-0 items-center gap-2 text-13 text-primary" title={bookmark.title}>
                    <span className="flex w-4 shrink-0 justify-center text-icon-14" data-testid="bookmark-row-icon">
                        <AddressIcon address={bookmark.url} />
                    </span>
                    <span className="min-w-0 truncate">{bookmark.title}</span>
                </div>
                <div className="truncate font-mono text-11 text-muted" title={bookmark.url}>
                    {bookmark.url}
                </div>
                {bookmark.description !== "" ? (
                    <div className="mt-0.5 line-clamp-2 text-12 whitespace-pre-line text-secondary">
                        {bookmark.description}
                    </div>
                ) : null}
            </div>
            <div className="flex max-w-full flex-wrap items-center gap-1.5">
                <button
                    type="button"
                    className={SecondaryButton}
                    aria-label={t("settings.bookmarks.editNamed", { title: bookmark.title })}
                    onClick={() => onEdit(bookmark)}
                >
                    {t("settings.bookmarks.edit")}
                </button>
                {data.folders.length > 0 ? (
                    <select
                        className={SelectClass}
                        value=""
                        aria-label={t("settings.bookmarks.moveToNamed", { title: bookmark.title })}
                        onChange={(e) =>
                            run(
                                moveProjectBookmark(
                                    ws,
                                    project.id,
                                    bookmark.id,
                                    e.target.value === "root" ? "" : e.target.value
                                )
                            )
                        }
                    >
                        <option value="" disabled>
                            {t("settings.bookmarks.moveTo")}
                        </option>
                        {bookmark.folder !== "" ? (
                            <option value="root">{t("settings.bookmarks.moveRoot")}</option>
                        ) : null}
                        {data.folders
                            .filter((f) => f.id !== bookmark.folder)
                            .map((f) => (
                                <option key={f.id} value={f.id}>
                                    {f.name}
                                </option>
                            ))}
                    </select>
                ) : null}
                {others.length > 0 ? (
                    <select
                        className={SelectClass}
                        value=""
                        aria-label={t("settings.bookmarks.copyToNamed", { title: bookmark.title })}
                        onChange={(e) => run(copyProjectBookmark(ws, project.id, bookmark.id, e.target.value))}
                    >
                        <option value="" disabled>
                            {t("settings.bookmarks.copyTo")}
                        </option>
                        {others.map((p) => (
                            <option key={p.id} value={p.id}>
                                {projectLabel(p)}
                            </option>
                        ))}
                    </select>
                ) : null}
                <button
                    type="button"
                    className={cn(GhostButton, confirming && "text-danger")}
                    aria-label={t("settings.bookmarks.deleteNamed", { title: bookmark.title })}
                    onBlur={() => confirming && onConfirm("")}
                    onClick={() => {
                        if (!confirming) {
                            onConfirm(bookmark.id);
                            return;
                        }
                        onConfirm("");
                        run(deleteProjectBookmark(ws, project.id, bookmark.id));
                    }}
                    data-testid={`bookmark-delete-${bookmark.id}`}
                >
                    {confirming ? t("settings.bookmarks.confirmDelete") : t("settings.bookmarks.delete")}
                </button>
            </div>
        </div>
    );
}

function FolderHeader({
    ws,
    project,
    folder,
    confirming,
    onConfirm,
    report,
}: {
    ws: Workspace;
    project: WorkspaceProjectEntry;
    folder: BookmarkFolder;
    confirming: boolean;
    onConfirm: (id: string) => void;
    report: Report;
}) {
    const t = useT();
    const run = makeRunner(report);
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(folder.name);
    const save = () =>
        fireAndForget(async () => {
            const problem = await renameProjectFolder(ws, project.id, folder.id, name);
            report(problem);
            if (problem == null) {
                setRenaming(false);
            }
        });
    return (
        <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-surface-2/40 px-5 py-1.5"
            data-testid={`bookmark-folder-${folder.id}`}
        >
            <i className="fa fa-solid fa-folder text-11 text-muted" aria-hidden />
            {renaming ? (
                <input
                    className={InputClass}
                    value={name}
                    autoFocus
                    aria-label={t("settings.bookmarks.renameFolderNamed", { name: folder.name })}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            save();
                        } else if (e.key === "Escape") {
                            e.stopPropagation();
                            setName(folder.name);
                            setRenaming(false);
                        }
                    }}
                />
            ) : (
                <span className="min-w-0 flex-1 truncate text-12 font-semibold text-primary">{folder.name}</span>
            )}
            <div className="flex max-w-full flex-wrap items-center gap-1.5">
                {renaming ? (
                    <button type="button" className={SecondaryButton} onClick={save}>
                        {t("settings.bookmarks.save")}
                    </button>
                ) : (
                    <button
                        type="button"
                        className={SecondaryButton}
                        aria-label={t("settings.bookmarks.renameFolderNamed", { name: folder.name })}
                        onClick={() => {
                            setName(folder.name);
                            setRenaming(true);
                        }}
                    >
                        {t("settings.bookmarks.renameFolder")}
                    </button>
                )}
                <button
                    type="button"
                    className={cn(GhostButton, confirming && "text-danger")}
                    title={t("settings.bookmarks.deleteFolderTitle", { name: folder.name })}
                    onBlur={() => confirming && onConfirm("")}
                    onClick={() => {
                        if (!confirming) {
                            onConfirm(folder.id);
                            return;
                        }
                        onConfirm("");
                        run(deleteProjectFolder(ws, project.id, folder.id));
                    }}
                    data-testid={`folder-delete-${folder.id}`}
                >
                    {confirming ? t("settings.bookmarks.confirmDeleteFolder") : t("settings.bookmarks.deleteFolder")}
                </button>
            </div>
        </div>
    );
}

function ProjectBlock({
    ws,
    project,
    current,
    others,
    ask,
}: {
    ws: Workspace;
    project: WorkspaceProjectEntry;
    current: boolean;
    others: WorkspaceProjectEntry[];
    ask: (request: BookmarkDialogRequest) => void;
}) {
    const t = useT();
    const data = readProjectBookmarks(ws.meta, project.id);
    const [problem, setProblem] = useState<BookmarkProblem>(null);
    const [confirming, setConfirming] = useState("");
    const [creating, setCreating] = useState(false);
    const [folderName, setFolderName] = useState("");
    const name = projectLabel(project);
    const create = () =>
        fireAndForget(async () => {
            const failed = await createProjectFolder(ws, project.id, folderName);
            setProblem(failed);
            if (failed == null) {
                setCreating(false);
                setFolderName("");
            }
        });
    const edit = (b: Bookmark) =>
        ask({
            projectId: project.id,
            projectName: name,
            mode: "edit",
            editingId: b.id,
            initial: { url: b.url, title: b.title, description: b.description, folder: b.folder },
        });
    const row = (b: Bookmark) => (
        <BookmarkRow
            key={b.id}
            nested={b.folder !== ""}
            ws={ws}
            project={project}
            bookmark={b}
            data={data}
            others={others}
            confirming={confirming === b.id}
            onConfirm={setConfirming}
            onEdit={edit}
            report={setProblem}
        />
    );
    return (
        <section className="border-t border-border first:border-t-0" data-testid={`bookmarks-project-${project.id}`}>
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-3 pb-2">
                <h3 className="min-w-0 truncate text-13 font-semibold text-primary">{name}</h3>
                {current ? <span className="text-11 text-muted">{t("settings.bookmarks.currentProject")}</span> : null}
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    <button
                        type="button"
                        className={SecondaryButton}
                        onClick={() => {
                            setProblem(null);
                            setCreating(true);
                        }}
                    >
                        <i className="fa fa-solid fa-folder-plus text-11" aria-hidden />
                        {t("settings.bookmarks.newFolder")}
                    </button>
                    <button
                        type="button"
                        className={AddButton}
                        onClick={() =>
                            ask({
                                projectId: project.id,
                                projectName: name,
                                mode: "new",
                                initial: { url: "", title: "", description: "", folder: "" },
                            })
                        }
                        data-testid={`bookmark-add-${project.id}`}
                    >
                        <i className="fa fa-solid fa-plus text-11" aria-hidden />
                        {t("settings.bookmarks.add")}
                        <MoltenWave />
                    </button>
                </div>
            </header>
            {creating ? (
                <div className="flex items-center gap-2 px-5 pb-2">
                    <input
                        className={InputClass}
                        value={folderName}
                        autoFocus
                        placeholder={t("settings.bookmarks.newFolderName")}
                        aria-label={t("settings.bookmarks.newFolderName")}
                        onChange={(e) => setFolderName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                create();
                            } else if (e.key === "Escape") {
                                e.stopPropagation();
                                setCreating(false);
                            }
                        }}
                        data-testid={`folder-new-${project.id}`}
                    />
                    <button type="button" className={SecondaryButton} onClick={create}>
                        {t("settings.bookmarks.createFolder")}
                    </button>
                </div>
            ) : null}
            {problem != null ? (
                <div role="alert" className="px-5 pb-2 text-12 text-danger">
                    {problemMessage(problem, t)}
                </div>
            ) : null}
            {data.items.length === 0 && data.folders.length === 0 ? (
                <div className="px-5 pb-3 text-12 text-muted">{t("settings.bookmarks.empty")}</div>
            ) : null}
            {bookmarksOfFolder(data, "").map(row)}
            {data.folders.map((f) => (
                <div key={f.id}>
                    <FolderHeader
                        ws={ws}
                        project={project}
                        folder={f}
                        confirming={confirming === f.id}
                        onConfirm={setConfirming}
                        report={setProblem}
                    />
                    {bookmarksOfFolder(data, f.id).map(row)}
                </div>
            ))}
        </section>
    );
}

export function BookmarksCard() {
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const [request, setRequest] = useState<BookmarkDialogRequest>(null);
    const projects = readProjects(ws);
    const currentId = currentProjectId(ws);
    return (
        <PageCard
            title={t("settings.bookmarks.title")}
            hint={t("settings.bookmarks.hint")}
            icon={suiteIcon("web")}
            scope="workspace"
        >
            <div data-testid="settings-bookmarks">
                {projects.length === 0 ? (
                    <div className="px-5 py-4 text-12 text-muted">{t("settings.bookmarks.noProject")}</div>
                ) : (
                    projects.map((p) => (
                        <ProjectBlock
                            key={p.id}
                            ws={ws}
                            project={p}
                            current={p.id === currentId && projects.length > 1}
                            others={projects.filter((o) => o.id !== p.id)}
                            ask={setRequest}
                        />
                    ))
                )}
            </div>
            {request != null ? <BookmarkDialog request={request} onClose={() => setRequest(null)} /> : null}
        </PageCard>
    );
}
