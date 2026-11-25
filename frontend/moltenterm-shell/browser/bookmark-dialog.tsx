// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The dialog Settings › Browser edits a bookmark with (FR-BRW-021, #2531): address, title and note of the one record (a
// change shows at every place the bookmark is at), and for a new bookmark the folder of the place it is added to. The
// web page panel does not use it: its popover edits the bookmark in place.

import { fireAndForget } from "@/util/util";
import { useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { AddressIcon } from "../favicon/favicon-mark";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { useBookmarkStore } from "./bookmark-world";
import {
    bookmarkAddress,
    BookmarkLimits,
    BookmarkProblem,
    foldersAt,
    PlaceRef,
    problemMessage,
} from "./bookmarks";
import { addBookmarkAt, editBookmark } from "./bookmarks-store";

export type BookmarkDialogRequest = {
    // The place a new bookmark is added to, named for the subtitle.
    ref: PlaceRef;
    placeName: string;
    mode: "new" | "edit";
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
    new: "browser.bookmarks.dialog.titleNew",
    edit: "browser.bookmarks.dialog.titleEdit",
};

export function BookmarkDialog({ request, onClose }: { request: BookmarkDialogRequest; onClose: () => void }) {
    const t = useT();
    const store = useBookmarkStore();
    const folders = foldersAt(store, request.ref);
    const [url, setUrl] = useState(request.initial.url);
    const [title, setTitle] = useState(request.initial.title.slice(0, BookmarkLimits.title));
    const [description, setDescription] = useState(request.initial.description);
    const [folder, setFolder] = useState(folders.some((f) => f.id === request.initial.folder) ? request.initial.folder : "");
    const [newFolder, setNewFolder] = useState("");
    const [problem, setProblem] = useState<BookmarkProblem>(null);
    const [busy, setBusy] = useState(false);
    const editing = request.mode === "edit";
    const typed = bookmarkAddress(url).value ?? "";
    const submit = () =>
        fireAndForget(async () => {
            setBusy(true);
            setProblem(null);
            const draft = { url, title, description };
            const failed = editing
                ? await editBookmark(request.editingId, draft)
                : (
                      await addBookmarkAt(draft, request.ref, {
                          folder: folder === NewFolderValue ? "" : folder,
                          newFolder: folder === NewFolderValue ? newFolder : "",
                      })
                  ).problem;
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
            subtitle={
                editing ? t("browser.bookmarks.dialog.subtitleEdit") : t("browser.bookmarks.dialog.subtitle", { place: request.placeName })
            }
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
            {!editing ? (
                <>
                    <label className="block">
                        <span className={LabelClass}>{t("browser.bookmarks.dialog.folder")}</span>
                        <select
                            className={InputClass}
                            value={folder}
                            onChange={(e) => setFolder(e.target.value)}
                            data-testid="bookmark-folder"
                        >
                            <option value="">{t("browser.bookmarks.folder.none")}</option>
                            {folders.map((f) => (
                                <option key={f.id} value={f.id}>
                                    {f.name}
                                </option>
                            ))}
                            <option value={NewFolderValue}>{t("browser.bookmarks.folder.new")}</option>
                        </select>
                    </label>
                    {folder === NewFolderValue ? (
                        <input
                            className={InputClass}
                            value={newFolder}
                            autoFocus
                            maxLength={BookmarkLimits.folderName + 1}
                            placeholder={t("browser.bookmarks.folder.newName")}
                            aria-label={t("browser.bookmarks.folder.newName")}
                            onChange={(e) => setNewFolder(e.target.value)}
                            onKeyDown={onFieldKey}
                            data-testid="bookmark-new-folder"
                        />
                    ) : null}
                </>
            ) : null}
            {problem != null ? (
                <div role="alert" className="text-danger" data-testid="bookmark-problem">
                    {problemMessage(problem, t)}
                </div>
            ) : null}
        </DialogFrame>
    );
}
