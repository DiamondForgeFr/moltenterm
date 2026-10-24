// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A sentence kept as data and worded each time it shows (#1058, FR-I18N-001): a result stored when an action ends
// (React state, an atom) would otherwise keep the language of the click after the developer switches it.

import { useCallback } from "react";
import { t, useLocale } from "./i18n";
import { serverErrorText, serverText, ServerText } from "./server-text";

export type PhraseVar = string | number | Phrase;

export type Phrase =
    | { key: string; vars?: Record<string, PhraseVar> }
    | { server: ServerText; english: string }
    | { error: string }
    | { join: Phrase[]; sep: string };

// phrase: the key and its variables; a variable may itself be a phrase, worded with the sentence.
export function phrase(key: string, vars?: Record<string, PhraseVar>): Phrase {
    return vars == null ? { key } : { key, vars };
}

// serverPhrase: a sentence wavesrv sent with its code (#656); english shows when the code is unknown here.
export function serverPhrase(text: ServerText, english: string): Phrase {
    return { server: text, english: english ?? "" };
}

// errorPhrase: a caught error, worded like serverErrorText. Only its message is kept.
export function errorPhrase(e: unknown): Phrase {
    const message = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
    return { error: message };
}

export function joinPhrases(parts: Phrase[], sep = " "): Phrase {
    return { join: parts.filter((p) => p != null), sep };
}

// wordPhrase: the phrase in the current language, for models; components use useWordPhrase.
export function wordPhrase(p: Phrase): string {
    if (p == null) {
        return "";
    }
    if ("key" in p) {
        if (p.vars == null) {
            return t(p.key);
        }
        const vars: Record<string, string | number> = {};
        for (const [name, value] of Object.entries(p.vars)) {
            vars[name] = typeof value === "string" || typeof value === "number" ? value : wordPhrase(value);
        }
        return t(p.key, vars);
    }
    if ("server" in p) {
        return serverText(p.server, p.english);
    }
    if ("error" in p) {
        return serverErrorText(new Error(p.error));
    }
    return p.join
        .map(wordPhrase)
        .filter((s) => s !== "")
        .join(p.sep);
}

// useWordPhrase: wordPhrase for components; the component renders again when the language changes.
export function useWordPhrase(): (p: Phrase) => string {
    const locale = useLocale();
    return useCallback((p: Phrase) => wordPhrase(p), [locale]);
}
