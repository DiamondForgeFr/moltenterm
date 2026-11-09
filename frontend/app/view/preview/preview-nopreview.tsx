// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { getApi } from "@/store/global";
import { formatRemoteUri } from "@/util/waveutil";
import { useAtomValue } from "jotai";
import { MoltenWave } from "../../../moltenterm-shell/molten-button";
import { useT } from "../../../moltenterm-shell/i18n/i18n";
import type { SpecializedViewProps } from "./preview";

export type FileKind = "spreadsheet" | "document" | "presentation" | "archive" | "other";

const KindIcons: Record<FileKind, string> = {
    spreadsheet: "fa-file-excel",
    document: "fa-file-word",
    presentation: "fa-file-powerpoint",
    archive: "fa-file-zipper",
    other: "fa-file",
};

const ArchiveMimeParts = ["zip", "gzip", "x-tar", "x-7z", "x-rar", "bzip2", "x-xz", "java-archive", "diskimage"];

export function fileKindOf(mimeType: string, name: string): FileKind {
    const mime = (mimeType ?? "").toLowerCase();
    const ext = fileExtension(name);
    if (mime.includes("spreadsheet") || mime.includes("ms-excel") || ext == ".numbers") {
        return "spreadsheet";
    }
    if (mime.includes("presentation") || mime.includes("powerpoint") || ext == ".key") {
        return "presentation";
    }
    if (
        mime.includes("wordprocessing") ||
        mime.includes("msword") ||
        mime.includes("opendocument.text") ||
        mime == "application/rtf" ||
        ext == ".pages"
    ) {
        return "document";
    }
    if (ArchiveMimeParts.some((part) => mime.includes(part))) {
        return "archive";
    }
    return "other";
}

export function fileExtension(name: string): string {
    if (name == null) {
        return "";
    }
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot == name.length - 1) {
        return "";
    }
    return name.slice(dot).toLowerCase();
}

export function NoPreview({ model }: SpecializedViewProps) {
    const t = useT();
    const fileInfo = useAtomValue(model.statFile);
    const mimeType = useAtomValue(model.fileMimeType);
    const conn = useAtomValue(model.connectionImmediate);
    const kind = fileKindOf(mimeType, fileInfo?.name);
    const ext = fileExtension(fileInfo?.name);
    const kindLabel = t(`wave.files.noPreview.kind.${kind}`);
    const btnBase = "cursor-pointer rounded px-3 py-1.5 text-xs";

    return (
        <div className="flex h-full w-full items-center justify-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
                <i className={`fa-solid ${KindIcons[kind]} text-3xl text-secondary`} />
                <div className="text-sm font-semibold text-primary">
                    {ext ? t("wave.files.noPreview.kindWithExt", { kind: kindLabel, ext }) : kindLabel}
                </div>
                <div className="text-xs text-secondary">
                    {conn ? t("wave.files.noPreview.hintRemote") : t("wave.files.noPreview.hint")}
                </div>
                {fileInfo != null && (
                    <div className="mt-1 flex flex-row flex-wrap justify-center gap-2">
                        {conn ? (
                            <button
                                className={`molten-btn ${btnBase}`}
                                onClick={() => getApi().downloadFile(formatRemoteUri(fileInfo.path, conn))}
                            >
                                {t("wave.files.download")}
                                <MoltenWave />
                            </button>
                        ) : (
                            <>
                                <button
                                    className={`molten-btn ${btnBase}`}
                                    onClick={() => getApi().openNativePath(fileInfo.path)}
                                >
                                    {t("wave.files.openDefaultApp")}
                                    <MoltenWave />
                                </button>
                                <button
                                    className={`${btnBase} border border-border text-secondary hover:text-primary transition-colors`}
                                    onClick={() => getApi().openNativePath(fileInfo.dir)}
                                >
                                    {t("wave.files.showInFolder")}
                                </button>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
