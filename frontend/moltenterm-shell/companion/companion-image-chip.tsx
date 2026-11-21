// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A message of the session as the companion shows it (FR-SHELL-018, #2455): its "[Image #N]" placeholders are small
// inline chips. The host of the panel (companion-tips.tsx) opens the image's popover when one is hovered or focused,
// and the image full size when it is clicked; a chip only names its number and the time of its message.

import { ImageIcon } from "lucide-react";
import { Fragment } from "react";
import { useT } from "../i18n/i18n";
import { ImageAtAttr, ImageAttr, messageParts, pastedImageNumber } from "./companion-tips-model";

export function ImageChip({ n, at }: { n: number; at?: number }) {
    const t = useT();
    const data = { [ImageAttr]: n, [ImageAtAttr]: at > 0 ? at : undefined };
    return (
        <button type="button" className="mt-cdash-imgchip" data-testid="companion-image-chip" {...data}>
            <ImageIcon size={11} strokeWidth={2} aria-hidden />
            {t("companion.image.chip", { n })}
        </button>
    );
}

// The chip an answer's markdown link to #mt-image-N stands for (companionMarkdown), null for any other link: the markdown
// renderer draws the placeholder as the chip of the hero and the topics, a list item's included.
export function pastedImageChip(href: string): React.ReactElement {
    const n = pastedImageNumber(href);
    return n > 0 ? <ImageChip n={n} /> : null;
}

// MessageText: the text of a message, a chip in place of each of its image placeholders. at: the message's time.
export function MessageText({ text, at }: { text: string; at?: number }) {
    return (
        <>
            {messageParts(text).map((part, i) => (
                <Fragment key={i}>{"image" in part ? <ImageChip n={part.image} at={at} /> : part.text}</Fragment>
            ))}
        </>
    );
}
