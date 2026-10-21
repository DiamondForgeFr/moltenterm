// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The header's close button (#705, #939). A magnified panel draws none: reaching for un-magnify, right next to it,
// too often closed the panel instead. No slot is kept either (#939), so the end icons reach the right edge and
// un-magnify becomes the right-most icon in the magnified state only. Magnifying therefore moves settings, never a ×,
// under the pointer. Un-magnifying can bring the normal panel's × under it when the magnified frame lines up with the
// normal one (a right-most panel with window:magnifiedblocksize at 1), so right after un-magnify the × ignores clicks
// until the pointer leaves it: a double click on un-magnify never closes the panel. The keyboard shortcut and the
// header menu's "Close" stay the deliberate routes.

import { IconButton } from "@/element/iconbutton";
import { useLayoutEffect, useRef } from "react";
import { useT } from "../i18n/i18n";

export const UnmagnifyGuardMs = 1000;

export type HeaderCloseButtonProps = {
    magnified: boolean;
    onClose: () => void;
    className?: string;
};

export type UnmagnifyGuard = {
    disarmedUntil: number;
};

export function noteMagnifiedChange(guard: UnmagnifyGuard, wasMagnified: boolean, magnified: boolean, now: number) {
    if (!wasMagnified || magnified) {
        return;
    }
    guard.disarmedUntil = now + UnmagnifyGuardMs;
}

export function closeAllowed(guard: UnmagnifyGuard, now: number): boolean {
    return now >= guard.disarmedUntil;
}

export function armOnPointerLeave(guard: UnmagnifyGuard) {
    guard.disarmedUntil = 0;
}

export function HeaderCloseButton({ magnified, onClose, className }: HeaderCloseButtonProps) {
    const t = useT();
    const guardRef = useRef<UnmagnifyGuard>({ disarmedUntil: 0 });
    const wasMagnifiedRef = useRef(magnified);
    useLayoutEffect(() => {
        noteMagnifiedChange(guardRef.current, wasMagnifiedRef.current, magnified, Date.now());
        wasMagnifiedRef.current = magnified;
    }, [magnified]);
    if (magnified) {
        return null;
    }
    const decl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "xmark-large",
        title: t("common.close"),
        click: () => {
            if (!closeAllowed(guardRef.current, Date.now())) {
                return;
            }
            onClose();
        },
    };
    return (
        <span className="contents" onPointerLeave={() => armOnPointerLeave(guardRef.current)}>
            <IconButton decl={decl} className={className} />
        </span>
    );
}
