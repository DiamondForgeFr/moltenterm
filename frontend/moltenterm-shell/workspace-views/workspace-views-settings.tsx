// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Preferences › Workspaces and views › New workspace views (FR-SHELL-092, FR-SHELL-106, DS-SHELL-132): the template a
// workspace created from now on starts with, edited as the tiles it creates. Each view is a tile like the sidebar's,
// its panels' icons over its name; tiles drag to reorder. The chosen tile's name and panels are edited below the
// tiles, its panels as chips that drag to reorder. Reset goes back to Scoping and Integration. Existing workspaces never
// change.

import { getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import { writeSettings } from "../command-panel/bindings";
import { useT } from "../i18n/i18n";
import { PageCard } from "../settings/settings-page";
import { ViewGlyph } from "../sidebar/view-glyph";
import { suiteIcon } from "../suite/suite-icons";
import { usePointerReorder } from "./template-drag";
import {
    addPanelKind,
    addView,
    movePanel,
    moveView,
    NewWorkspaceViewsKey,
    placePanel,
    placeView,
    readTemplate,
    removePanel,
    removeView,
    renameView,
    TemplateView,
    templateViewIcons,
    templateViewName,
    WorkspaceViewPanels,
} from "./workspace-views-model";

const DefaultTemplate = readTemplate((builtinDefaults as Record<string, unknown>)[NewWorkspaceViewsKey]);

function templateAtom() {
    return getSettingsKeyAtom(NewWorkspaceViewsKey as keyof SettingsType);
}

// The template this card last wrote, until the settings echo it: an edit made before the echo (a rename on blur then
// a click) applies to it rather than to the rendered list, so no edit is lost.
let lastWritten: TemplateView[] = null;

function currentTemplate(): TemplateView[] {
    const stored = readTemplate(globalStore.get(templateAtom()));
    if (lastWritten != null && JSON.stringify(stored) === JSON.stringify(lastWritten)) {
        lastWritten = null;
    }
    return lastWritten ?? stored;
}

function writeTemplate(op: (views: TemplateView[]) => TemplateView[]) {
    const next = op(currentTemplate());
    lastWritten = next;
    fireAndForget(() => writeSettings({ [NewWorkspaceViewsKey]: next }));
}

function resetTemplate() {
    lastWritten = null;
    fireAndForget(() => writeSettings({ [NewWorkspaceViewsKey]: null }));
}

const InputClass =
    "h-row min-w-0 flex-1 rounded-4 border border-line-strong bg-transparent px-2 text-12 font-medium text-primary outline-none focus:border-accent";
const GhostButton =
    "molten-btn-ghost inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12 disabled:opacity-40";
const TileGrid = "grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1.5";
const TileClass =
    "relative flex h-[52px] min-w-0 cursor-pointer flex-col items-center justify-center gap-[5px] rounded-6 px-1 text-11 text-primary transition-colors duration-120 ease-mt select-none";

// Alt with an arrow moves the focused tile or chip, the drag's keyboard twin.
function arrowStep(e: React.KeyboardEvent): number {
    if (!e.altKey) {
        return 0;
    }
    return e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
}

function dropMark(drag: { from: number; over: number }, i: number): string {
    if (drag == null || drag.over !== i || drag.from === i) {
        return null;
    }
    // The sidebar's drop marks (mt-sb-dropa, mt-sb-dropb): the side the dragged item lands on.
    return drag.from < i ? "mt-sb-dropa" : "mt-sb-dropb";
}

function ViewTile({
    view,
    i,
    selected,
    dragged,
    mark,
    onSelect,
    onPointerDown,
    onKeyDown,
}: {
    view: TemplateView;
    i: number;
    selected: boolean;
    dragged: boolean;
    mark: string;
    onSelect: () => void;
    onPointerDown: (e: React.PointerEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
}) {
    const t = useT();
    const name = templateViewName(view, t);
    return (
        <div
            role="option"
            tabIndex={0}
            aria-selected={selected}
            aria-label={name}
            title={name}
            data-template-view={i}
            data-testid="workspace-view-tile"
            className={cn(
                TileClass,
                selected
                    ? "bg-white/20 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]"
                    : "bg-white/[0.09] hover:bg-white/15",
                dragged && "opacity-40",
                mark
            )}
            onClick={onSelect}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
        >
            <ViewGlyph icons={templateViewIcons(view)} />
            <span className="max-w-full truncate">{name}</span>
        </div>
    );
}

function PanelChips({ views, i }: { views: TemplateView[]; i: number }) {
    const t = useT();
    const view = views[i];
    const name = templateViewName(view, t);
    const [adding, setAdding] = useState(false);
    const { containerRef, drag, onPointerDown } = usePointerReorder("data-template-panel", (from, to) =>
        writeTemplate((v) => placePanel(v, i, from, to))
    );
    useEffect(() => setAdding(false), [i]);
    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-11 text-muted">{t("workspaceViews.settings.panelsOf", { name })}</div>
            <div
                ref={containerRef as React.RefObject<HTMLDivElement>}
                role="listbox"
                aria-label={t("workspaceViews.settings.panelsOf", { name })}
                className="flex flex-wrap items-center gap-1"
            >
                {view.panels.map((kind, p) => {
                    const panel = WorkspaceViewPanels.find((x) => x.kind === kind);
                    const label = t(panel?.labelKey ?? kind);
                    return (
                        <span
                            key={`${p}:${kind}`}
                            role="option"
                            aria-selected={false}
                            tabIndex={0}
                            data-template-panel={p}
                            data-panel={kind}
                            title={t("workspaceViews.settings.panel", { n: p + 1, name })}
                            onPointerDown={(e) => onPointerDown(e, p)}
                            onKeyDown={(e) => {
                                const step = arrowStep(e);
                                if (step !== 0) {
                                    e.preventDefault();
                                    writeTemplate((v) => movePanel(v, i, p, step));
                                }
                            }}
                            className={cn(
                                "inline-flex h-row cursor-grab items-center gap-1.5 rounded-4 border border-line-strong bg-surface-2 pr-0.5 pl-2 text-12 text-primary select-none",
                                drag?.from === p && "opacity-40",
                                dropMark(drag, p)
                            )}
                        >
                            <i className={makeIconClass(panel?.icon ?? "square", false)} aria-hidden />
                            {label}
                            <button
                                type="button"
                                className="molten-btn-ghost inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-4 text-10 disabled:opacity-40"
                                aria-label={t("workspaceViews.settings.removePanelNamed", { panel: label })}
                                title={t("workspaceViews.settings.removePanelNamed", { panel: label })}
                                disabled={view.panels.length <= 1}
                                onClick={() => writeTemplate((v) => removePanel(v, i, p))}
                            >
                                <i className="fa-solid fa-xmark" aria-hidden />
                            </button>
                        </span>
                    );
                })}
                <button
                    type="button"
                    className={GhostButton}
                    aria-expanded={adding}
                    data-testid="workspace-view-add-panel"
                    onClick={() => setAdding((a) => !a)}
                >
                    <i className="fa-solid fa-plus" aria-hidden />
                    {t("workspaceViews.settings.addPanel")}
                </button>
            </div>
            {adding ? (
                <div
                    className="flex flex-wrap gap-1 rounded-4 border border-line p-1.5"
                    role="group"
                    aria-label={t("workspaceViews.settings.addPanel")}
                    data-testid="workspace-view-panel-kinds"
                >
                    {WorkspaceViewPanels.map((opt) => (
                        <button
                            key={opt.kind}
                            type="button"
                            className={GhostButton}
                            data-kind={opt.kind}
                            onClick={() => {
                                setAdding(false);
                                writeTemplate((v) => addPanelKind(v, i, opt.kind));
                            }}
                        >
                            <i className={makeIconClass(opt.icon, false)} aria-hidden />
                            {t(opt.labelKey)}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function ViewDetails({ views, i, onRemoved }: { views: TemplateView[]; i: number; onRemoved: () => void }) {
    const t = useT();
    const view = views[i];
    const name = templateViewName(view, t);
    const commit = (value: string) => {
        if (value.trim() && value.trim() !== name) {
            writeTemplate((v) => renameView(v, i, value));
        }
    };
    return (
        <div className="flex flex-col gap-2 rounded-4 border border-line px-3 py-2.5" data-template-details={i}>
            <div className="flex min-w-0 items-center gap-2">
                <input
                    key={`${i}:${name}`}
                    type="text"
                    defaultValue={name}
                    aria-label={t("workspaceViews.settings.name", { n: i + 1 })}
                    className={InputClass}
                    onBlur={(e) => commit(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        }
                        if (e.key === "Escape") {
                            e.currentTarget.value = name;
                            e.currentTarget.blur();
                        }
                    }}
                    data-testid="workspace-view-name"
                />
                <button
                    type="button"
                    className={GhostButton}
                    data-testid="workspace-view-remove"
                    onClick={() => {
                        onRemoved();
                        writeTemplate((v) => removeView(v, i));
                    }}
                >
                    <i className="fa-solid fa-xmark" aria-hidden />
                    {t("workspaceViews.settings.removeView", { name })}
                </button>
            </div>
            <PanelChips views={views} i={i} />
        </div>
    );
}

export function NewWorkspaceViewsCard() {
    const t = useT();
    const setting = useAtomValue(templateAtom());
    const views = readTemplate(setting);
    const isDefault = JSON.stringify(views) === JSON.stringify(DefaultTemplate);
    const [selected, setSelected] = useState(0);
    const chosen = views.length === 0 ? -1 : Math.min(selected, views.length - 1);
    const { containerRef, drag, onPointerDown } = usePointerReorder("data-template-view", (from, to) => {
        writeTemplate((v) => placeView(v, from, to));
        setSelected(to);
    });
    const step = (i: number, delta: number) => {
        const to = i + delta;
        if (to < 0 || to >= views.length) {
            return;
        }
        writeTemplate((v) => moveView(v, i, delta));
        setSelected(to);
        requestAnimationFrame(() =>
            containerRef.current?.querySelector<HTMLElement>(`[data-template-view="${to}"]`)?.focus()
        );
    };
    return (
        <PageCard
            title={t("workspaceViews.settings.title")}
            hint={t("workspaceViews.settings.hint")}
            icon={suiteIcon("workspace")}
            scope="app"
        >
            <div className="flex flex-col gap-2.5 px-5 py-3" data-testid="settings-new-workspace-views">
                {views.length === 0 ? (
                    <div className="text-12 text-muted">{t("workspaceViews.settings.empty")}</div>
                ) : null}
                <div
                    ref={containerRef as React.RefObject<HTMLDivElement>}
                    role="listbox"
                    aria-label={t("workspaceViews.settings.tilesLabel")}
                    className={TileGrid}
                    data-testid="workspace-view-tiles"
                >
                    {views.map((v, i) => (
                        <ViewTile
                            key={`${i}:${v.name ?? v.namekey ?? ""}`}
                            view={v}
                            i={i}
                            selected={i === chosen}
                            dragged={drag?.from === i}
                            mark={dropMark(drag, i)}
                            onSelect={() => setSelected(i)}
                            onPointerDown={(e) => onPointerDown(e, i)}
                            onKeyDown={(e) => {
                                const delta = arrowStep(e);
                                if (delta !== 0) {
                                    e.preventDefault();
                                    step(i, delta);
                                } else if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    setSelected(i);
                                }
                            }}
                        />
                    ))}
                    <button
                        type="button"
                        className={cn(
                            TileClass,
                            "border border-dashed border-line-strong text-muted hover:border-accent/60 hover:text-primary"
                        )}
                        data-testid="workspace-view-add"
                        onClick={() => {
                            writeTemplate((v) => addView(v, ""));
                            setSelected(views.length);
                        }}
                    >
                        <i className="fa-solid fa-plus text-icon-14" aria-hidden />
                        <span>{t("workspaceViews.settings.addView")}</span>
                    </button>
                </div>
                {views.length > 1 ? (
                    <div className="text-11 text-muted">{t("workspaceViews.settings.dragHint")}</div>
                ) : null}
                {chosen >= 0 ? (
                    <ViewDetails views={views} i={chosen} onRemoved={() => setSelected(Math.max(0, chosen - 1))} />
                ) : null}
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        className={GhostButton}
                        data-testid="workspace-view-reset"
                        disabled={isDefault}
                        onClick={resetTemplate}
                    >
                        <i className="fa-solid fa-rotate-left" aria-hidden />
                        {t("workspaceViews.settings.reset")}
                    </button>
                </div>
            </div>
        </PageCard>
    );
}
