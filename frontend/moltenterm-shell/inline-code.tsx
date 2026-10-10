// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Messages written for a terminal (an agent's question, a build's error) quote commands and paths between backticks
// (FR-SHELL-055, DS-SHELL-097): they are shown as inline code, never as raw backticks. Only text is produced, so a
// message cannot inject markup.

import { Fragment, ReactNode } from "react";

export type InlinePart = { code: boolean; text: string };

// A backtick without its closing one, or an empty pair, stays as typed.
export function splitInlineCode(text: string): InlinePart[] {
    if (!text) {
        return [];
    }
    const parts: InlinePart[] = [];
    const pattern = /`([^`\n]+)`/g;
    let last = 0;
    for (let match = pattern.exec(text); match != null; match = pattern.exec(text)) {
        if (match.index > last) {
            parts.push({ code: false, text: text.slice(last, match.index) });
        }
        parts.push({ code: true, text: match[1] });
        last = match.index + match[0].length;
    }
    if (last < text.length) {
        parts.push({ code: false, text: text.slice(last) });
    }
    return parts;
}

// The text of a tooltip, where markup cannot show: the code spans without their backticks.
export function plainInlineText(text: string): string {
    return splitInlineCode(text)
        .map((part) => part.text)
        .join("");
}

export function InlineCodeText({ text }: { text: string }): ReactNode {
    return splitInlineCode(text).map((part, i) =>
        part.code ? (
            <code key={i} className="molten-inline-code rounded-4 bg-line-strong px-1 font-mono text-11 text-primary">
                {part.text}
            </code>
        ) : (
            <Fragment key={i}>{part.text}</Fragment>
        )
    );
}
