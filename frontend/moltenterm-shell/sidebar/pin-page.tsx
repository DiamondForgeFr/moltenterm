// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Loaded when a view is first pinned (ViewPins.openPinPage), out of the JS every tab view loads up front
// (NFR-PERF-003, bundle.initialJsMB).

import { atoms, globalStore } from "@/app/store/global";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { colourStops } from "../workspace-colour";
import { workspaceShownName } from "../workspace-default-name";
import type { WorkspaceRailEntry } from "../workspace-rail-model";
import { SidebarGlyph } from "./sidebar-icons";
import type { PinScope } from "./view-pins-model";
import { PinDraft, ViewPins } from "./view-pins-store";

type SidebarWorkspaces = { entries: WorkspaceRailEntry[] };

// The pin page (FR-SHELL-080): the view's name, and the two scopes in plain words. It takes the place of the
// workspace's lists until the view is pinned or the page cancelled.
export function PinPage({ draft, workspaces }: { draft: PinDraft; workspaces: SidebarWorkspaces }) {
    const t = useT();
    const pins = ViewPins.getInstance();
    const ws = useAtomValue(atoms.workspace);
    const [tab] = useWaveObjectValue<Tab>(makeORef("tab", draft.tabId));
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [draft.tabId]);
    const workspace = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    const panels = tab?.blockids?.length ?? 0;
    const setDraft = (next: Partial<PinDraft>) =>
        globalStore.set(pins.draftAtom, { ...globalStore.get(pins.draftAtom), ...next });
    const cancel = () => pins.closePinPage();
    const submit = () => fireAndForget(() => pins.finishPinPage());
    const scope = (value: PinScope, titleKey: string, bodyKey: string, extra?: React.ReactNode) => (
        <button
            type="button"
            role="radio"
            aria-checked={draft.scope === value}
            className={cn(
                "mt-sb-scope flex w-full cursor-pointer items-start gap-2.5 rounded-8 border p-2.5 text-left text-secondary transition-colors duration-120 ease-mt",
                draft.scope === value
                    ? "border-accent bg-[color-mix(in_srgb,var(--mt-accent)_12%,rgb(0_0_0/0.18))] text-primary"
                    : "border-white/[0.12] bg-black/[0.18] hover:border-white/25"
            )}
            data-testid={`sidebar-pin-scope-${value}`}
            onClick={() => setDraft({ scope: value })}
        >
            <span className="mt-sb-radio mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full" aria-hidden />
            <span className="text-12 leading-[1.5]">
                <b className="mb-[3px] block text-primary">{t(titleKey, { workspace })}</b>
                {t(bodyKey, { workspace, count: panels })}
                {extra}
            </span>
        </button>
    );
    return (
        <form
            className="flex shrink-0 flex-col gap-3 px-0.5 py-1"
            data-testid="sidebar-pin-page"
            onSubmit={(e) => {
                e.preventDefault();
                submit();
            }}
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    cancel();
                }
            }}
        >
            <div className="flex items-center gap-1.5 border-t border-white/10 pt-1.5">
                <b className="text-13 text-primary">{t("sidebar.pins.page.title")}</b>
                <button
                    type="button"
                    className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                    aria-label={t("sidebar.pins.page.cancel")}
                    title={t("sidebar.pins.page.cancel")}
                    onClick={cancel}
                >
                    <SidebarGlyph name="x" size={14} />
                </button>
            </div>
            <div className="flex h-[52px] w-24 flex-col items-center justify-center gap-[5px] self-center rounded-6 bg-white/20 px-1 text-11 text-primary shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]">
                <i
                    className={cn(makeIconClass(draft.icon, true, { defaultIcon: "square" }), "text-icon-16")}
                    aria-hidden
                />
                <span className="max-w-full truncate">{draft.name || tab?.name}</span>
            </div>
            <label className="flex flex-col gap-[5px] text-12 text-muted">
                {t("sidebar.pins.page.name")}
                <input
                    ref={inputRef}
                    type="text"
                    value={draft.name}
                    data-testid="sidebar-pin-name"
                    className="h-8 rounded-6 border border-white/[0.12] bg-black/25 px-2 text-13 text-primary outline-none focus:border-accent"
                    onChange={(e) => setDraft({ name: e.target.value })}
                />
            </label>
            <div role="radiogroup" aria-label={t("sidebar.pins.page.scope")} className="flex flex-col gap-2">
                {scope("here", "sidebar.pins.page.hereTitle", "sidebar.pins.page.hereBody")}
                {scope(
                    "everywhere",
                    "sidebar.pins.page.everywhereTitle",
                    "sidebar.pins.page.everywhereBody",
                    <span className="mt-sb-mini mt-[7px] flex gap-1" aria-hidden>
                        {workspaces.entries.map((entry) => (
                            <i
                                key={entry.id}
                                className={cn(
                                    "relative inline-block h-4 w-4 rounded-4 opacity-90",
                                    !entry.active && "is-other"
                                )}
                                style={{ background: colourStops(entry.color)[0] ?? "var(--color-secondary)" }}
                            />
                        ))}
                    </span>
                )}
            </div>
            <div className="mt-1 flex flex-col gap-1.5">
                <button
                    type="submit"
                    className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                    data-testid="sidebar-pin-submit"
                >
                    {t("sidebar.pins.page.pin")}
                    <MoltenWave />
                </button>
                <button
                    type="button"
                    className="cursor-pointer rounded-4 border border-white/[0.12] px-3 py-1.5 text-12 text-secondary hover:text-primary"
                    onClick={cancel}
                >
                    {t("sidebar.pins.page.cancel")}
                </button>
            </div>
        </form>
    );
}
