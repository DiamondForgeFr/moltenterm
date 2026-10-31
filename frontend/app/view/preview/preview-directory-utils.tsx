// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as WOS from "@/store/wos"; // MOLTENTERM-PATCH (#1626)
import { fireAndForget, isBlank } from "@/util/util";
import dayjs from "dayjs";
import React from "react";
import { t } from "../../../moltenterm-shell/i18n/i18n"; // MOLTENTERM-PATCH (#742)
// MOLTENTERM-PATCH (#1626)
import {
    DefaultSortSettingValues,
    DirSort,
    DirSortColumn,
    DirSortMetaKey,
    firstDirectionDesc,
    formatDirSort,
    nextDirSort,
    resolveDirSort,
} from "./directory-sort";
import { type PreviewModel } from "./preview-model";

export const recursiveError = "recursive flag must be set for directory operations";
export const overwriteError = "set overwrite flag to delete the existing file";
export const mergeError = "set overwrite flag to delete the existing contents or set merge flag to merge the contents";

export const displaySuffixes = {
    B: "b",
    kB: "k",
    MB: "m",
    GB: "g",
    TB: "t",
    KiB: "k",
    MiB: "m",
    GiB: "g",
    TiB: "t",
};

export function getBestUnit(bytes: number, si = false, sigfig = 3): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "-";
    if (bytes === 0) return "0B";

    const units = si ? ["kB", "MB", "GB", "TB"] : ["KiB", "MiB", "GiB", "TiB"];
    const divisor = si ? 1000 : 1024;

    const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(divisor)), units.length);
    const unit = idx === 0 ? "B" : units[idx - 1];
    const value = bytes / Math.pow(divisor, idx);

    return `${parseFloat(value.toPrecision(sigfig))}${displaySuffixes[unit] ?? unit}`;
}

// MOLTENTERM-PATCH (#742): the month and the day order follow the interface language
export function getLastModifiedTime(unixMillis: number, locale = "en"): string {
    const file = dayjs(unixMillis);
    const now = dayjs();

    const time = file.format("HH:mm");

    if (now.isSame(file, "year")) {
        const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(file.toDate());
        return `${day} ${time}`;
    }

    return `${file.format("YYYY-MM-DD")}`;
}

const iconRegex = /^[a-z0-9- ]+$/;

export function isIconValid(icon: string): boolean {
    if (isBlank(icon)) {
        return false;
    }
    return icon.match(iconRegex) != null;
}

export function getSortIcon(sortType: string | boolean): React.ReactNode {
    switch (sortType) {
        case "asc":
            return <i className="fa-solid fa-chevron-up dir-table-head-direction"></i>;
        case "desc":
            return <i className="fa-solid fa-chevron-down dir-table-head-direction"></i>;
        default:
            return null;
    }
}

export function cleanMimetype(input: string): string {
    const truncated = input.split(";")[0];
    return truncated.trim();
}

// MOLTENTERM-PATCH (#742): "directory" is a word in the Type column, not a MIME type, so it is translated
export function typeLabel(mimetype: string, tr: (key: string) => string): string {
    const clean = cleanMimetype(mimetype ?? "");
    return clean === "directory" ? tr("wave.files.typeDirectory") : clean;
}

export function handleRename(
    model: PreviewModel,
    path: string,
    newPath: string,
    isDir: boolean,
    setErrorMsg: (msg: ErrorMsg) => void
) {
    fireAndForget(async () => {
        try {
            let srcuri = await model.formatRemoteUri(path, globalStore.get);
            if (isDir) {
                srcuri += "/";
            }
            await model.env.rpc.FileMoveCommand(TabRpcClient, {
                srcuri,
                desturi: await model.formatRemoteUri(newPath, globalStore.get),
            });
        } catch (e) {
            const errorText = `${e}`;
            console.warn(`Rename failed: ${errorText}`);
            const errorMsg: ErrorMsg = {
                status: t("wave.files.renameFailed"), // MOLTENTERM-PATCH (#742)
                text: `${e}`,
            };
            setErrorMsg(errorMsg);
        }
        model.refreshCallback();
    });
}

export function handleFileDelete(
    model: PreviewModel,
    path: string,
    recursive: boolean,
    setErrorMsg: (msg: ErrorMsg) => void
) {
    fireAndForget(async () => {
        const formattedPath = await model.formatRemoteUri(path, globalStore.get);
        try {
            await model.env.rpc.FileDeleteCommand(TabRpcClient, {
                path: formattedPath,
                recursive,
            });
        } catch (e) {
            const errorText = `${e}`;
            console.warn(`Delete failed: ${errorText}`);
            let errorMsg: ErrorMsg;
            if (errorText.includes(recursiveError) && !recursive) {
                errorMsg = {
                    status: t("wave.files.confirmDeleteFolder"), // MOLTENTERM-PATCH (#742)
                    text: t("wave.files.confirmDeleteFolderText"), // MOLTENTERM-PATCH (#742)
                    level: "warning",
                    buttons: [
                        {
                            text: t("wave.files.deleteWithContents"), // MOLTENTERM-PATCH (#742)
                            onClick: () => handleFileDelete(model, path, true, setErrorMsg),
                        },
                    ],
                };
            } else {
                errorMsg = {
                    status: t("wave.files.deleteFailed"), // MOLTENTERM-PATCH (#742)
                    text: `${e}`,
                };
            }
            setErrorMsg(errorMsg);
        }
        model.refreshCallback();
    });
}

// MOLTENTERM-PATCH (#1626): the panel's sort lives in its block meta (FR-FILE-003); the setting is only the default
function currentPanelSort(model: PreviewModel): DirSort {
    const defaultSort = globalStore.get(model.env.getSettingsKeyAtom("preview:defaultsort")) ?? "name";
    return resolveDirSort(globalStore.get(model.blockAtom)?.meta, defaultSort);
}

export function setPanelSort(model: PreviewModel, sort: DirSort) {
    fireAndForget(() =>
        model.env.rpc.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", model.blockId),
            meta: { [DirSortMetaKey]: formatDirSort(sort) } as MetaType,
        })
    );
}

export function setPanelSortColumn(model: PreviewModel, column: DirSortColumn) {
    setPanelSort(model, nextDirSort(currentPanelSort(model), column));
}

const SortMenuColumns: { column: DirSortColumn; labelKey: string }[] = [
    { column: "name", labelKey: "wave.files.sortName" },
    { column: "type", labelKey: "wave.files.sortType" },
    { column: "modtime", labelKey: "wave.files.sortModified" },
    { column: "size", labelKey: "wave.files.sortSize" },
];

export function makeDirectorySortMenuItem(model: PreviewModel): ContextMenuItem {
    const sort = currentPanelSort(model);
    const canBeDefault = (DefaultSortSettingValues as readonly string[]).includes(sort.column);
    return {
        label: t("wave.files.sortBy"),
        submenu: [
            ...SortMenuColumns.map(
                ({ column, labelKey }): ContextMenuItem => ({
                    label: t(labelKey),
                    type: "checkbox",
                    checked: sort.column === column,
                    click: () =>
                        setPanelSort(model, {
                            column,
                            desc: sort.column === column ? sort.desc : firstDirectionDesc(column),
                        }),
                })
            ),
            { type: "separator" },
            {
                label: t("wave.files.sortAscending"),
                type: "checkbox",
                checked: !sort.desc,
                click: () => setPanelSort(model, { column: sort.column, desc: false }),
            },
            {
                label: t("wave.files.sortDescending"),
                type: "checkbox",
                checked: sort.desc,
                click: () => setPanelSort(model, { column: sort.column, desc: true }),
            },
            { type: "separator" },
            {
                label: t("wave.files.sortUseForNewPanels"),
                enabled: canBeDefault,
                click: () =>
                    fireAndForget(() =>
                        model.env.rpc.SetConfigCommand(TabRpcClient, { "preview:defaultsort": sort.column })
                    ),
            },
        ],
    };
}

// MOLTENTERM-PATCH (#1626): withSort false leaves the sort out, for a menu that already shows it
export function makeDirectoryDefaultMenuItems(model: PreviewModel, withSort = true): ContextMenuItem[] {
    const showHiddenFiles = globalStore.get(model.showHiddenFiles) ?? true;
    return [
        ...(withSort ? [makeDirectorySortMenuItem(model)] : []),
        {
            label: t("wave.files.showHidden"), // MOLTENTERM-PATCH (#742)
            submenu: [
                {
                    label: t("wave.files.on"), // MOLTENTERM-PATCH (#742)
                    type: "checkbox",
                    checked: showHiddenFiles,
                    click: () => {
                        globalStore.set(model.showHiddenFiles, true);
                        fireAndForget(() =>
                            model.env.rpc.SetConfigCommand(TabRpcClient, { "preview:showhiddenfiles": true })
                        );
                    },
                },
                {
                    label: t("wave.files.off"), // MOLTENTERM-PATCH (#742)
                    type: "checkbox",
                    checked: !showHiddenFiles,
                    click: () => {
                        globalStore.set(model.showHiddenFiles, false);
                        fireAndForget(() =>
                            model.env.rpc.SetConfigCommand(TabRpcClient, { "preview:showhiddenfiles": false })
                        );
                    },
                },
            ],
        },
    ];
}
