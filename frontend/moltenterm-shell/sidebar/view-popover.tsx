// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The view menu's two small pages (FR-SHELL-081, the #1181 prototype's renameMenu and iconMenu): Rename, a field for a
// view whose name does not show (a top-row block), and Change icon, a grid of glyphs plus "Panels' icons" to go back.
// One at a time, placed where the menu was opened; Escape or a click elsewhere closes it.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { SidebarGlyph } from "./sidebar-icons";
import { ViewIconChoices } from "./view-menu-model";
import { ViewPins, ViewRef } from "./view-pins-store";

const PopoverWidth = { rename: 240, icon: 252 };
const EdgeGap = 8;

export type ViewPopoverState = {
    kind: "rename" | "icon";
    ref: ViewRef;
    name: string;
    // The chosen icon, null when the view shows its panels' icons.
    icon: string;
    x: number;
    y: number;
};

export const viewPopoverAtom = jotai.atom(null) as jotai.PrimitiveAtom<ViewPopoverState>;

export function openViewPopover(state: ViewPopoverState) {
    globalStore.set(viewPopoverAtom, state);
}

export function closeViewPopover() {
    globalStore.set(viewPopoverAtom, null);
}

function RenameBody({ state }: { state: ViewPopoverState }) {
    const t = useT();
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);
    const submit = () => {
        const name = inputRef.current?.value.trim() ?? "";
        closeViewPopover();
        if (name && name !== state.name) {
            fireAndForget(() => ViewPins.getInstance().rename(state.ref, name));
        }
    };
    return (
        <>
            <div className="mt-sb-pop-head">{t("sidebar.views.renameTitle")}</div>
            <div className="px-1.5 pt-0.5 pb-1.5">
                <input
                    ref={inputRef}
                    type="text"
                    defaultValue={state.name}
                    aria-label={t("sidebar.views.renameTitle")}
                    data-testid="sidebar-rename-field"
                    className="h-7 w-full rounded-6 border border-white/[0.12] bg-black/25 px-2 text-13 text-primary outline-none focus:border-accent"
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            submit();
                        }
                    }}
                />
            </div>
        </>
    );
}

function IconBody({ state }: { state: ViewPopoverState }) {
    const t = useT();
    const choose = (icon: string) => {
        closeViewPopover();
        fireAndForget(() => ViewPins.getInstance().setIcon(state.ref, icon));
    };
    return (
        <>
            <div className="mt-sb-pop-head">{t("sidebar.views.iconTitle", { name: state.name })}</div>
            <div className="grid grid-cols-6 gap-0.5 px-1.5 pb-1" role="group">
                {ViewIconChoices.map((icon) => (
                    <button
                        key={icon}
                        type="button"
                        className={cn(
                            "flex h-8 w-8 cursor-pointer items-center justify-center rounded-6 text-primary transition-colors duration-120 ease-mt hover:bg-white/[0.12]",
                            state.icon === icon && "bg-white/[0.14]"
                        )}
                        aria-pressed={state.icon === icon}
                        aria-label={t("sidebar.views.iconChoice", { icon: icon.replace(/^brands@/, "") })}
                        data-testid="sidebar-icon-choice"
                        data-icon={icon}
                        onClick={() => choose(icon)}
                    >
                        <i className={cn(makeIconClass(icon, true), "text-icon-16")} aria-hidden />
                    </button>
                ))}
            </div>
            <div className="mx-1.5 my-1 h-px bg-white/10" />
            <button
                type="button"
                className="mx-1 mb-1 flex w-[calc(100%-8px)] cursor-pointer items-center gap-2 rounded-6 px-2 py-1.5 text-left text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-white/[0.08] hover:text-primary"
                data-testid="sidebar-icon-panels"
                onClick={() => choose(null)}
            >
                <SidebarGlyph name="undo" size={14} />
                {t("sidebar.views.panelIcons")}
            </button>
        </>
    );
}

export function ViewPopoverHost() {
    const state = useAtomValue(viewPopoverAtom);
    const boxRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number }>(null);
    useLayoutEffect(() => {
        if (state == null || boxRef.current == null) {
            setPos(null);
            return;
        }
        const box = boxRef.current.getBoundingClientRect();
        const left = Math.max(EdgeGap, Math.min(state.x, window.innerWidth - box.width - EdgeGap));
        const top = Math.max(EdgeGap, Math.min(state.y, window.innerHeight - box.height - EdgeGap));
        setPos({ left, top });
    }, [state]);
    useEffect(() => {
        if (state == null) {
            return;
        }
        const onDown = (e: MouseEvent) => {
            if (!boxRef.current?.contains(e.target as Node)) {
                closeViewPopover();
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeViewPopover();
            }
        };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDown, true);
            document.removeEventListener("keydown", onKey, true);
        };
    }, [state]);
    if (state == null) {
        return null;
    }
    return (
        <div
            ref={boxRef}
            role="dialog"
            className="mt-sb-pop fixed z-[1000] rounded-4 py-1"
            style={{
                width: PopoverWidth[state.kind],
                left: pos?.left ?? state.x,
                top: pos?.top ?? state.y,
                visibility: pos == null ? "hidden" : "visible",
            }}
            data-testid={`sidebar-${state.kind}-popover`}
        >
            {state.kind === "rename" ? <RenameBody state={state} /> : <IconBody state={state} />}
        </div>
    );
}
