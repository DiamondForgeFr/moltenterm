// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The dialog that adds or edits a bookmark (FR-BRW-019): address, title, description, folder, and for a new bookmark the
// other projects to also add it to (a separate copy in each, nothing ticked by default). Opened by the web page panel's
// Bookmarks menu and by the Browser settings; nothing opens it by itself.

import { atoms } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { AddressIcon } from "../favicon/favicon-mark";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { projectLabel, readProjects } from "../sidebar/workspace-projects";
import {
    bookmarkAddress,
    BookmarkLimits,
    BookmarkProblem,
    findBookmarkByAddress,
    problemMessage,
    readProjectBookmarks,
} from "./bookmarks";
import { addProjectBookmark, updateProjectBookmark } from "./bookmarks-store";

export type BookmarkDialogRequest = {
    projectId: string;
    projectName: string;
    // "page": the shown page; "new": an empty bookmark (settings); "edit": an existing one.
    mode: "page" | "new" | "edit";
    editingId?: string;
    initial: { url: string; title: string; description: string; folder: string };
};

const NewFolderValue = "\u0000new";

const InputClass =
    "w-full min-w-0 rounded-4 border border-border bg-transparent px-2 py-1.5 text-13 leading-5 text-primary outline-none placeholder:text-muted focus:border-accent";
const LabelClass = "mb-1 flex text-12 text-secondary";
const HintClass = "mt-1 text-11 leading-4 text-muted";
const AccentButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";
const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";

const TitleKeys = {
    page: "browser.bookmarks.dialog.titleAdd",
    new: "browser.bookmarks.dialog.titleNew",
    edit: "browser.bookmarks.dialog.titleEdit",
};

export function BookmarkDialog({ request, onClose }: { request: BookmarkDialogRequest; onClose: () => void }) {
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const data = readProjectBookmarks(ws?.meta, request.projectId);
    const others = readProjects(ws).filter((p) => p.id !== request.projectId);
    const [url, setUrl] = useState(request.initial.url);
    const [title, setTitle] = useState(request.initial.title.slice(0, BookmarkLimits.title));
    const [description, setDescription] = useState(request.initial.description);
    const [folder, setFolder] = useState(
        data.folders.some((f) => f.id === request.initial.folder) ? request.initial.folder : ""
    );
    const [newFolder, setNewFolder] = useState("");
    const [also, setAlso] = useState<string[]>([]);
    // A page whose address cannot be kept says why as soon as the dialog opens, not when saving fails.
    const [problem, setProblem] = useState<BookmarkProblem>(() =>
        request.mode === "page" ? (bookmarkAddress(request.initial.url).problem ?? null) : null
    );
    const [busy, setBusy] = useState(false);
    const editing = request.mode === "edit";
    const typed = bookmarkAddress(url).value ?? "";
    const submit = () =>
        fireAndForget(async () => {
            setBusy(true);
            setProblem(null);
            const draft = {
                url,
                title,
                description,
                folder: folder === NewFolderValue ? "" : folder,
                newFolder: folder === NewFolderValue ? newFolder : "",
            };
            const failed = editing
                ? await updateProjectBookmark(ws, request.projectId, request.editingId, draft)
                : await addProjectBookmark(ws, request.projectId, draft, also);
            setBusy(false);
            if (failed != null) {
                setProblem(failed);
                return;
            }
            onClose();
        });
    const onFieldKey = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !busy) {
            e.preventDefault();
            submit();
        }
    };
    return (
        <DialogFrame
            role="bookmark-dialog"
            title={t(TitleKeys[request.mode])}
            subtitle={t("browser.bookmarks.dialog.subtitle", { project: request.projectName })}
            subtitleClass="text-12"
            widthClass="w-[520px]"
            onEscape={busy ? undefined : onClose}
            buttons={
                <>
                    <button type="button" disabled={busy} onClick={onClose} className={PlainButton}>
                        {t("browser.bookmarks.dialog.cancel")}
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={submit}
                        className={AccentButton}
                        data-testid="bookmark-save"
                    >
                        {t(editing ? "browser.bookmarks.dialog.save" : "browser.bookmarks.dialog.add")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <label className="block">
                <span className={LabelClass}>{t("browser.bookmarks.dialog.address")}</span>
                <span className="flex items-center gap-2">
                    <span className="flex w-4 shrink-0 justify-center text-icon-16" data-testid="bookmark-address-icon">
                        <AddressIcon address={typed} />
                    </span>
                    <input
                        className={`${InputClass} min-w-0 flex-1`}
                        value={url}
                        spellCheck={false}
                        maxLength={BookmarkLimits.url + 1}
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={onFieldKey}
                        data-testid="bookmark-address"
                    />
                </span>
            </label>
            <label className="block">
                <span className={LabelClass}>{t("browser.bookmarks.dialog.title")}</span>
                <input
                    className={InputClass}
                    value={title}
                    autoFocus
                    maxLength={BookmarkLimits.title + 1}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={onFieldKey}
                    data-testid="bookmark-title"
                />
            </label>
            <label className="block">
                <span className={LabelClass}>{t("browser.bookmarks.dialog.description")}</span>
                <textarea
                    className={`${InputClass} resize-y`}
                    rows={3}
                    value={description}
                    maxLength={BookmarkLimits.description + 1}
                    placeholder={t("browser.bookmarks.dialog.descriptionPlaceholder")}
                    onChange={(e) => setDescription(e.target.value)}
                    data-testid="bookmark-description"
                />
                <div className={HintClass}>{t("browser.bookmarks.dialog.descriptionHint")}</div>
            </label>
            <label className="block">
                <span className={LabelClass}>{t("browser.bookmarks.dialog.folder")}</span>
                <select
                    className={InputClass}
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    data-testid="bookmark-folder"
                >
                    <option value="">{t("browser.bookmarks.dialog.folderNone")}</option>
                    {data.folders.map((f) => (
                        <option key={f.id} value={f.id}>
                            {f.name}
                        </option>
                    ))}
                    <option value={NewFolderValue}>{t("browser.bookmarks.dialog.folderNew")}</option>
                </select>
            </label>
            {folder === NewFolderValue ? (
                <input
                    className={InputClass}
                    value={newFolder}
                    autoFocus
                    maxLength={BookmarkLimits.folderName + 1}
                    placeholder={t("browser.bookmarks.dialog.newFolderName")}
                    aria-label={t("browser.bookmarks.dialog.newFolderName")}
                    onChange={(e) => setNewFolder(e.target.value)}
                    onKeyDown={onFieldKey}
                    data-testid="bookmark-new-folder"
                />
            ) : null}
            {!editing && others.length > 0 ? (
                <fieldset className="min-w-0">
                    <legend className={LabelClass}>{t("browser.bookmarks.dialog.alsoAdd")}</legend>
                    {others.map((p) => {
                        const there =
                            typed !== "" && findBookmarkByAddress(readProjectBookmarks(ws?.meta, p.id), typed) != null;
                        return (
                            <label key={p.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-secondary">
                                <input
                                    type="checkbox"
                                    disabled={there}
                                    checked={also.includes(p.id) && !there}
                                    onChange={(e) =>
                                        setAlso(e.target.checked ? [...also, p.id] : also.filter((id) => id !== p.id))
                                    }
                                    data-testid={`bookmark-also-${p.id}`}
                                />
                                {projectLabel(p)}
                                {there ? (
                                    <span className="text-muted">{t("browser.bookmarks.dialog.alreadyThere")}</span>
                                ) : null}
                            </label>
                        );
                    })}
                    <div className={HintClass}>{t("browser.bookmarks.dialog.alsoAddHint")}</div>
                </fieldset>
            ) : null}
            {problem != null ? (
                <div role="alert" className="text-danger" data-testid="bookmark-problem">
                    {problemMessage(problem, t)}
                </div>
            ) : null}
        </DialogFrame>
    );
}
