// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// wavesrv's sentences in the interface language (#656): a result field a window shows comes with a code beside it
// (pkg/molten/uimsg's Text, in a field named after it plus "text": message → messagetext), and an error from a molten
// route starts with its code. The window words the code under server.<code>; the English wavesrv sent shows when the
// code is missing or unknown here.

import { hasKey } from "./i18n-core";
import { t } from "./i18n";

// Must match pkg/molten/uimsg/uimsg.go.
const WireMark = "uimsg:";

export type ServerText = {
    code: string;
    vars?: Record<string, string>;
};

// serverText words text in the interface language; english is what shows without a known code.
export function serverText(text: ServerText, english: string): string {
    if (text?.code == null || text.code === "") {
        return english ?? "";
    }
    const key = `server.${text.code}`;
    if (!hasKey(key)) {
        return english ?? "";
    }
    return t(key, text.vars ?? {});
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
