// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Under Settings › Appearance › 360 view (FR-SHELL-066, #1083): the screens the 360 view remembers a column threshold
// for, and the current one with its default, each editable; a remembered screen can be forgotten (it takes its default
// again).

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useT } from "../i18n/i18n";
import { ScreenModel } from "../view360/screen-store";
import { screenRows, ThresholdChoices } from "../view360/screen-threshold";

const SelectClass =
    "h-row min-w-0 cursor-pointer rounded-4 border border-line-strong bg-surface-2 px-2 pr-1 text-12 text-primary outline-none focus:border-accent";
const GhostButton =
    "molten-btn-ghost inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12";

export function View360Screens() {
    const t = useT();
    const model = ScreenModel.getInstance();
    const stored = useAtomValue(model.storedAtom);
    const current = useAtomValue(model.screenAtom);
    const rows = screenRows(stored, current);
    return (
        <div className="molten-settings-row flex flex-col gap-1.5 px-5 py-3" data-testid="settings-view360-screens">
            <div className="text-12 font-medium text-primary">{t("view360.screens.title")}</div>
            <div className="text-12 text-muted">{t("view360.screens.hint")}</div>
            {rows.length === 0 ? (
                <div className="text-12 text-muted">{t("view360.screens.none")}</div>
            ) : (
                <ul className="flex flex-col gap-1">
                    {rows.map((row) => {
                        const choices = ThresholdChoices.includes(row.columns)
                            ? ThresholdChoices
                            : [...ThresholdChoices, row.columns].sort((a, b) => a - b);
                        const size = t("view360.screens.size", { width: row.widthpx, height: row.heightpx });
                        return (
                            <li
                                key={row.key}
                                className="flex min-w-0 items-center gap-2 text-12"
                                data-testid="settings-view360-screen"
                                data-screen={row.key}
                            >
                                <span className="truncate text-secondary">
                                    {size}
                                    {row.scalefactor !== 1
                                        ? ` · ${t("view360.screens.scale", { scale: row.scalefactor })}`
                                        : ""}
                                </span>
                                {row.current ? (
                                    <span className="shrink-0 rounded-4 border border-line-strong px-1.5 text-11 text-secondary">
                                        {t("view360.screens.current")}
                                    </span>
                                ) : null}
                                {row.isDefault ? (
                                    <span className="shrink-0 text-11 text-muted">{t("view360.screens.default")}</span>
                                ) : null}
                                <span className="ml-auto shrink-0 text-muted">{t("view360.screens.beyond")}</span>
                                <select
                                    aria-label={t("view360.screens.selectLabel", { size })}
                                    value={String(row.columns)}
                                    onChange={(e) =>
                                        model.setThreshold(Number(e.target.value), {
                                            key: row.key,
                                            widthpx: row.widthpx,
                                            heightpx: row.heightpx,
                                            scalefactor: row.scalefactor,
                                        })
                                    }
                                    className={cn(SelectClass, "shrink-0")}
                                >
                                    {choices.map((count) => (
                                        <option key={count} value={String(count)}>
                                            {t("view360.screens.columns", { count })}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    className={cn(GhostButton, row.isDefault && "invisible")}
                                    title={t("view360.screens.forgetTitle")}
                                    aria-hidden={row.isDefault}
                                    tabIndex={row.isDefault ? -1 : 0}
                                    onClick={() => model.forget(row.key)}
                                >
                                    {t("view360.screens.forget")}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
