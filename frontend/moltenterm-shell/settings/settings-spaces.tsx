// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Preferences › Workspaces and views (FR-SHELL-106): what is not a key of settings.json. The sidebar docked or
// floating (the window's meta, as the shortcut does), and the top row, the views pinned everywhere, as the tiles the
// sidebar draws, dragged to reorder in every workspace. The section's settings.json rows and the new workspace
// template come from the catalog and workspace-views-settings.tsx.

import { globalStore } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useT } from "../i18n/i18n";
import { formatShortcutById } from "../shortcuts/format";
import { pinGlyph } from "../sidebar/sidebar-blocks";
import { SidebarModel } from "../sidebar/sidebar-store";
import { ViewGlyph } from "../sidebar/view-glyph";
import { ViewPins } from "../sidebar/view-pins-store";
import { OptionList, OptionRow } from "../suite/suite";
import { suiteIcon } from "../suite/suite-icons";
import { usePointerReorder } from "../workspace-views/template-drag";
import { PageCard } from "./settings-page";

// The Sidebar block's settings.json row, under which the docked or floating choice shows.
export const SidebarTintKey = "moltenterm:sidebartint";

const TileClass =
    "relative flex h-[52px] min-w-0 cursor-pointer flex-col items-center justify-center gap-[5px] rounded-6 bg-white/[0.09] px-1 text-11 text-primary transition-colors duration-120 ease-mt select-none hover:bg-white/15";

type SidebarMode = "docked" | "floating";

const SidebarModes: SidebarMode[] = ["docked", "floating"];

// The sidebar of this window: docked beside the views, or floating, shown over them from the left edge.
export function SidebarModeRows() {
    const t = useT();
    const sidebar = SidebarModel.getInstance();
    const hidden = useAtomValue(sidebar.hiddenAtom, { store: globalStore });
    const keys = formatShortcutById("toggle-sidebar");
    const current: SidebarMode = hidden ? "floating" : "docked";
    return (
        <div className="molten-settings-row flex flex-col" data-testid="settings-sidebar-mode">
            <div className="px-5 pt-3 pb-2">
                <div className="text-12 font-medium text-primary">{t("settings.spaces.sidebar.label")}</div>
                <div className="text-12 text-muted">
                    {keys
                        ? t("settings.spaces.sidebar.descriptionKeys", { keys })
                        : t("settings.spaces.sidebar.description")}
                </div>
            </div>
            <OptionList aria-label={t("settings.spaces.sidebar.label")}>
                {SidebarModes.map((mode) => (
                    <OptionRow
                        key={mode}
                        name="molten-settings-sidebar-mode"
                        value={mode}
                        label={t(`settings.spaces.sidebar.${mode}`)}
                        meta={t(`settings.spaces.sidebar.${mode}Hint`)}
                        selected={current === mode}
                        selectedLabel={t("common.selected")}
                        onSelect={() => sidebar.setHidden(mode === "floating")}
                    />
                ))}
            </OptionList>
        </div>
    );
}

export function TopRowCard() {
    const t = useT();
    const pins = useAtomValue(ViewPins.getInstance().globalPinsAtom, { store: globalStore });
    const reorder = (from: number, to: number) => {
        const dragged = pins[from]?.id;
        const target = pins[to]?.id;
        if (dragged == null || target == null) {
            return;
        }
        fireAndForget(() => ViewPins.getInstance().reorderTop(dragged, target, from < to));
    };
    const { containerRef, drag, onPointerDown } = usePointerReorder("data-top-pin", reorder);
    return (
        <PageCard
            title={t("settings.spaces.topRow.title")}
            hint={t("settings.spaces.topRow.hint")}
            icon={suiteIcon("panels")}
            scope="app"
        >
            <div className="flex flex-col gap-2 px-5 py-3" data-testid="settings-top-row">
                {pins.length === 0 ? (
                    <div className="text-12 text-muted">{t("settings.spaces.topRow.empty")}</div>
                ) : (
                    <div
                        ref={containerRef as React.RefObject<HTMLDivElement>}
                        role="listbox"
                        aria-label={t("settings.spaces.topRow.title")}
                        className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1.5"
                    >
                        {pins.map((pin, i) => (
                            <div
                                key={pin.id}
                                role="option"
                                aria-selected={false}
                                tabIndex={0}
                                title={pin.name}
                                data-top-pin={i}
                                data-testid="settings-top-row-tile"
                                className={cn(
                                    TileClass,
                                    drag?.from === i && "opacity-40",
                                    drag != null && drag.over === i && drag.from !== i
                                        ? drag.from < i
                                            ? "mt-sb-dropa"
                                            : "mt-sb-dropb"
                                        : null
                                )}
                                onPointerDown={(e) => onPointerDown(e, i)}
                                onKeyDown={(e) => {
                                    if (!e.altKey) {
                                        return;
                                    }
                                    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
                                    if (step !== 0 && pins[i + step] != null) {
                                        e.preventDefault();
                                        reorder(i, i + step);
                                    }
                                }}
                            >
                                <ViewGlyph icons={pinGlyph(pin)} />
                                <span className="max-w-full truncate">{pin.name}</span>
                            </div>
                        ))}
                    </div>
                )}
                {pins.length > 1 ? (
                    <div className="text-11 text-muted">{t("settings.spaces.topRow.dragHint")}</div>
                ) : null}
            </div>
        </PageCard>
    );
}
