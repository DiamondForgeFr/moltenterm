// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// wavesrv's sentences in the interface language (#656): a result field a window shows comes with a code beside it
// (pkg/molten/uimsg's Text, in a field named after it plus "text": message → messagetext), and an error from a molten
// route starts with its code. The window words the code under server.<code>; the English wavesrv sent shows when the
// code is missing or unknown here.

import { viewNameText } from "../workspace-views/workspace-views-model";
import { t } from "./i18n";
import { hasKey } from "./i18n-core";

// Must match pkg/molten/uimsg/uimsg.go.
const WireMark = "uimsg:";

export type ServerText = {
    code: string;
    vars?: Record<string, string>;
    // Placeholders that are sentences of ours, each worded first (#750).
    parts?: Record<string, ServerText>;
};

// The text in the interface language, null when its code or one of its parts' codes is unknown here.
function wordText(text: ServerText): string {
    if (text?.code == null || text.code === "") {
        return null;
    }
    const key = `server.${text.code}`;
    if (!hasKey(key)) {
        return null;
    }
    const vars: Record<string, string> = {};
    // A var is data, but a default view never renamed is named by its key there (#1311).
    for (const [name, value] of Object.entries(text.vars ?? {})) {
        vars[name] = viewNameText(value, t);
    }
    for (const [name, part] of Object.entries(text.parts ?? {})) {
        const worded = wordText(part);
        if (worded == null) {
            return null;
        }
        vars[name] = worded;
    }
    return t(key, vars);
}

// serverText words text in the interface language; english is what shows without a known code.
export function serverText(text: ServerText, english: string): string {
    return wordText(text) ?? english ?? "";
}

// serverTexts words a list of sentences (warnings, errors) wavesrv sent with their codes, by position.
export function serverTexts(texts: ServerText[], english: string[]): string[] {
    return (english ?? []).map((e, i) => serverText(texts?.[i], e));
}

// unwireError splits an error message from a molten route into its code and its English.
export function unwireError(message: string): { text: ServerText; english: string } {
    const s = message ?? "";
    const idx = s.indexOf(WireMark);
    if (idx < 0) {
        return { text: null, english: s };
    }
    const rest = s.slice(idx + WireMark.length);
    const nl = rest.indexOf("\n");
    if (nl < 0) {
        return { text: null, english: s };
    }
    try {
        const text = JSON.parse(rest.slice(0, nl)) as ServerText;
        return { text, english: s.slice(0, idx) + rest.slice(nl + 1) };
    } catch {
        return { text: null, english: s };
    }
}

// serverErrorText words a caught error (a molten route's, or any other) in the interface language.
export function serverErrorText(e: unknown): string {
    const message = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
    const { text, english } = unwireError(message);
    return serverText(text, english);
}
