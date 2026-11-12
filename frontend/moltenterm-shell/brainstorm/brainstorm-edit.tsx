// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The developer's hand on the living graph (FR-BOSS-010 AC27, AC28, #2247): a plate's menu (a right-click, its handle,
// or the menu key), and the layer's own bar that offers Undo for 5 s after a removal or a merge, says why a change did
// not go, and guides Link to…. The mode holds the app's toasts (AC3), so the bar belongs to the layer. It comes with the
// stage, behind the mode's own import.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { BossBubbleModel } from "../boss/boss-store";
import { t as translate, useT } from "../i18n/i18n";
import { plateMenuOf, UndoOfferMs } from "./brainstorm-edit-model";
import "./brainstorm-edit.css";
import type { BrainstormNode } from "./brainstorm-graph-model";
import { BrainstormModel, UndoBar } from "./brainstorm-store";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

// The plate's menu (AC27): Edit text, Change kind, Link to… and Remove, as the node allows. Remove asks nothing: the bar
// offers Undo.
export function plateMenuItems(
    node: BrainstormNode,
    centre: string,
    t: Translate,
    model: PlateActions
): ContextMenuItem[] {
    const menu = plateMenuOf(node, centre);
    if (menu == null) {
        return [];
    }
    return [
        { label: t("boss.brainstorm.plate.editText"), visible: menu.edit, click: () => model.startEdit(node.id) },
        {
            label: t("boss.brainstorm.plate.changeKind"),
            visible: menu.kinds.length > 0,
            submenu: menu.kinds.map((kind) => ({
                label: t(`boss.brainstorm.kinds.${kind}`),
                type: "checkbox" as const,
                checked: kind === menu.current,
                click: () => void model.retype(node.id, kind),
            })),
        },
        { label: t("boss.brainstorm.plate.linkTo"), visible: menu.link, click: () => model.startLink(node.id) },
        { type: "separator", visible: menu.remove },
        { label: t("boss.brainstorm.plate.remove"), visible: menu.remove, click: () => void model.remove(node.id) },
    ];
}

export type PlateActions = Pick<BrainstormModel, "startEdit" | "retype" | "startLink" | "remove">;

// Opens the menu of the node `id` at the event (a right-click, the handle's click, or the menu key's contextmenu).
export function openPlateMenu(id: string, event: React.MouseEvent): boolean {
    const model = BrainstormModel.getInstance();
    const graph = globalStore.get(model.stateAtom)?.graph;
    const node = graph?.nodes?.find((n) => n.id === id);
    const items = plateMenuItems(node, graph?.centre ?? "", translate, model);
    if (items.every((item) => item.visible === false)) {
        return false;
    }
    model.cancelLink();
    ContextMenuModel.getInstance().showContextMenu(items, event);
    return true;
}

// The bar's words for what it shows.
export function undoBarText(bar: UndoBar, name: string, t: Translate): string {
    if (bar == null) {
        return "";
    }
    if (bar.kind === "failed") {
        const key = `boss.brainstorm.edits.failed.${bar.reason}`;
        const text = t(key);
        return text === key ? t("boss.brainstorm.edits.failed.failed") : text;
    }
    const note = bar.note;
    const kept = note.nodes?.[0]?.text || note.nodes?.[0]?.id || "";
    if (note.op === "merge") {
        return t("boss.brainstorm.edits.bar.brokkMerged", { name, text: kept });
    }
    return note.by === "you"
        ? t("boss.brainstorm.edits.bar.youRemoved", { text: kept })
        : t("boss.brainstorm.edits.bar.brokkRemoved", { name, text: kept });
}

// The layer's bar: Undo for 5 s after a removal or a merge (the time stops while the pointer or the focus is on it),
// why a change did not go, or how to finish Link to….
export function BrainstormEditBar() {
    const t = useT();
    const model = BrainstormModel.getInstance();
    const bar = useAtomValue(model.undoBarAtom, { store: globalStore });
    const linking = useAtomValue(model.linkingAtom, { store: globalStore });
    const graph = useAtomValue(model.stateAtom, { store: globalStore })?.graph;
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const [held, setHeld] = useState(false);

    useEffect(() => {
        if (bar == null || held) {
            return;
        }
        const timer = window.setTimeout(() => {
            if (globalStore.get(model.undoBarAtom)?.key === bar.key) {
                model.dismissUndo();
            }
        }, UndoOfferMs);
        return () => window.clearTimeout(timer);
    }, [bar?.key, held]);

    // Escape while linking cancels the link, before his group's own Escape, which would end the brainstorm.
    useEffect(() => {
        if (linking == null) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.isComposing) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            model.cancelLink();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [linking]);

    if (linking != null) {
        const from = graph?.nodes?.find((n) => n.id === linking);
        return (
            <div className="mt-bs-editbar is-linking" role="status" data-testid="brainstorm-linking">
                <i className={makeIconClass("link", false)} aria-hidden />
                <span className="mt-bs-editbar-text">
                    {t("boss.brainstorm.edits.linking", { text: from?.text ?? linking })}
                </span>
                <button type="button" className="mt-bs-editbar-quiet cursor-pointer" onClick={() => model.cancelLink()}>
                    {t("boss.brainstorm.edits.linkCancel")}
                </button>
            </div>
        );
    }
    if (bar == null) {
        return null;
    }
    const failed = bar.kind === "failed";
    return (
        <div
            className={cn("mt-bs-editbar", failed && "is-failed")}
            role={failed ? "alert" : "status"}
            data-testid="brainstorm-undo-bar"
            onPointerEnter={() => setHeld(true)}
            onPointerLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={() => setHeld(false)}
        >
            <i className={makeIconClass(failed ? "triangle-exclamation" : "fire-flame-simple", false)} aria-hidden />
            <span className="mt-bs-editbar-text">{undoBarText(bar, name, t)}</span>
            {bar.kind === "offer" ? (
                <button
                    type="button"
                    className="mt-bs-editbar-undo cursor-pointer"
                    data-testid="brainstorm-undo"
                    onClick={() => void model.undo(bar.note.seq)}
                >
                    <i className={makeIconClass("rotate-left", false)} aria-hidden />
                    {t("boss.brainstorm.edits.bar.undo")}
                </button>
            ) : null}
            <button
                type="button"
                className="mt-bs-editbar-close cursor-pointer"
                aria-label={t("boss.brainstorm.edits.bar.dismiss")}
                title={t("boss.brainstorm.edits.bar.dismiss")}
                onClick={() => model.dismissUndo()}
            >
                <i className={makeIconClass("xmark", false)} aria-hidden />
            </button>
        </div>
    );
}
