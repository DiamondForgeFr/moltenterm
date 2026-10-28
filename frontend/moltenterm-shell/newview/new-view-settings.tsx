// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Settings › General › New views (FR-SHELL-089, DS-SHELL-128): the choices of "When a new view opens", and the editor
// of the chooser's favourites (2 to 4, in order) under it.

import { atoms, getSettingsKeyAtom } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { isMacOS } from "@/util/platformutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useLocale, useT } from "../i18n/i18n";
import type { PaletteEntry } from "../palette/palette-model";
import { formatKeys } from "../shortcuts/format";
import { newViewFavoriteBindings } from "../shortcuts/registry";
import { readWorkspaceProject } from "../workspace-project";
import {
    addFavorite,
    favoriteIds,
    MaxFavorites,
    MinFavorites,
    moveFavorite,
    newViewChoices,
    NewViewFavoritesKey,
    removeFavorite,
    replaceFavorite,
} from "./new-view-model";

// The value the settings screen's select reads for app:newviewopen's options.
export const NewViewChoicesOptions = "newviewchoices";

export function useNewViewChoices(): PaletteEntry[] {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const ws = useAtomValue(atoms.workspace);
    const locale = useLocale();
    const projectLinked = readWorkspaceProject(ws).dir !== "";
    return useMemo(
        () =>
            newViewChoices({
                presets: fullConfig?.presets,
                widgets: fullConfig?.widgets,
                workspaceId: ws?.oid,
                projectLinked,
            }),
        [fullConfig, ws?.oid, projectLinked, locale]
    );
}

function writeFavorites(ids: string[]) {
    fireAndForget(() => RpcApi.SetConfigCommand(TabRpcClient, { [NewViewFavoritesKey]: ids } as SettingsType));
}

const SelectClass =
    "h-row min-w-0 flex-1 cursor-pointer rounded-4 border border-line-strong bg-surface-2 px-2 pr-1 text-12 text-primary outline-none focus:border-accent";
const IconButton =
    "molten-btn-ghost inline-flex h-row w-row shrink-0 cursor-pointer items-center justify-center rounded-4 text-12 disabled:opacity-40";
const GhostButton =
    "molten-btn-ghost inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12";

export function NewViewFavorites() {
    const t = useT();
    const choices = useNewViewChoices();
    const setting = useAtomValue(getSettingsKeyAtom(NewViewFavoritesKey));
    const ids = favoriteIds(setting);
    const mac = isMacOS();
    const keys = newViewFavoriteBindings(mac).map((k) => formatKeys(k, mac));
    const unused = choices.filter((c) => !ids.includes(c.id));
    return (
        <div className="molten-settings-row flex flex-col gap-1.5 px-5 py-3" data-testid="settings-new-view-favorites">
            <div className="text-12 font-medium text-primary">{t("newView.settings.title")}</div>
            <div className="text-12 text-muted">{t("newView.settings.hint")}</div>
            <ul className="flex flex-col gap-1">
                {ids.map((id, i) => {
                    const known = choices.some((c) => c.id === id);
                    return (
                        <li key={id} className="flex min-w-0 items-center gap-2 text-12" data-favorite={id}>
                            <span className="w-4 shrink-0 text-right text-muted">{i + 1}</span>
                            <select
                                aria-label={t("newView.settings.change", { n: i + 1 })}
                                value={id}
                                onChange={(e) => writeFavorites(replaceFavorite(ids, i, e.target.value))}
                                className={SelectClass}
                            >
                                {known ? null : <option value={id}>{t("newView.settings.unknown", { id })}</option>}
                                {choices
                                    .filter((c) => c.id === id || !ids.includes(c.id))
                                    .map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.label}
                                        </option>
                                    ))}
                            </select>
                            <span className="w-12 shrink-0 font-mono text-11 text-muted">{keys[i] ?? ""}</span>
                            <button
                                type="button"
                                className={IconButton}
                                title={t("newView.settings.moveUp")}
                                aria-label={t("newView.settings.moveUp")}
                                disabled={i === 0}
                                onClick={() => writeFavorites(moveFavorite(ids, i, -1))}
                            >
                                <i className="fa-solid fa-arrow-up" />
                            </button>
                            <button
                                type="button"
                                className={IconButton}
                                title={t("newView.settings.moveDown")}
                                aria-label={t("newView.settings.moveDown")}
                                disabled={i === ids.length - 1}
                                onClick={() => writeFavorites(moveFavorite(ids, i, 1))}
                            >
                                <i className="fa-solid fa-arrow-down" />
                            </button>
                            <button
                                type="button"
                                className={IconButton}
                                title={t("newView.settings.remove")}
                                aria-label={t("newView.settings.remove")}
                                disabled={ids.length <= MinFavorites}
                                onClick={() => writeFavorites(removeFavorite(ids, i))}
                            >
                                <i className="fa-solid fa-xmark" />
                            </button>
                        </li>
                    );
                })}
            </ul>
            {ids.length < MaxFavorites && unused.length > 0 ? (
                <div>
                    <button
                        type="button"
                        className={cn(GhostButton)}
                        data-testid="settings-new-view-add"
                        onClick={() => writeFavorites(addFavorite(ids, unused[0].id))}
                    >
                        <i className="fa-solid fa-plus" />
                        {t("newView.settings.add")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
