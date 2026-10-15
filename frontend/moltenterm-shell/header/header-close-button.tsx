// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The header's close button (#705). A magnified panel draws none: reaching for un-magnify, right next to it, too
// often closed the panel instead. An inert placeholder of the same box keeps its slot, so un-magnify does not slide
// into the corner × held. The keyboard shortcut and the header menu's "Close" stay the deliberate routes.

import { IconButton } from "@/element/iconbutton";
import { cn, makeIconClass } from "@/util/util";
import { useT } from "../i18n/i18n";

export type HeaderCloseButtonProps = {
    magnified: boolean;
    onClose: () => void;
    className?: string;
};

export function HeaderCloseButton({ magnified, onClose, className }: HeaderCloseButtonProps) {
    const t = useT();
    if (magnified) {
        return (
            <span
                aria-hidden="true"
                data-testid="header-close-placeholder"
                className={cn("wave-iconbutton", className, "invisible pointer-events-none")}
            >
                <i className={makeIconClass("xmark-large", true)} />
            </span>
        );
    }
    const decl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "xmark-large",
        title: t("common.close"),
        click: onClose,
    };
    return <IconButton decl={decl} className={className} />;
}
