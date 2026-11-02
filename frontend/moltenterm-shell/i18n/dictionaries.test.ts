// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The shipped dictionaries stay complete (TC-I18N-005, NFR-I18N-001, NFR-I18N-003): every language has every key of
// en.json with the same placeholders, no key English lacks, and every key the code asks for exists in en.json.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    availableLanguageCodes,
    Dictionary,
    flattenKeys,
    placeholders,
    resolveKey,
    shippedDictionary,
} from "./i18n-core";

const Root = path.resolve(__dirname, "../../..");
const ScannedDirs = ["frontend", "emain"];

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
            out.push(full);
    }
    return out;
}

// Literal keys passed to t(), mt(), phrase() or useT()'s function (named t): t("a.b"), t('a.b', …).
export function literalKeys(source: string): string[] {
    return [...source.matchAll(/\b(?:t|mt|phrase)\(\s*["']([A-Za-z][\w-]*(?:\.[\w:-]+)+)["']/g)].map((m) => m[1]);
}

describe("shipped dictionaries", () => {
    const en = shippedDictionary("en");
    const enKeys = flattenKeys(en);

    it("English has keys", () => {
        expect(enKeys.length).toBeGreaterThan(50);
    });

    for (const code of availableLanguageCodes().filter((c) => c !== "en" && shippedDictionary(c) != null)) {
        const dict: Dictionary = shippedDictionary(code);
        it(`${code} has every key of en.json, with the same placeholders`, () => {
            const missing = enKeys.filter((k) => resolveKey(dict, k) == null);
            expect(missing).toEqual([]);
            const changed = enKeys.filter(
                (k) => placeholders(resolveKey(en, k)).join(",") !== placeholders(resolveKey(dict, k) ?? "").join(",")
            );
            expect(changed).toEqual([]);
        });
        it(`${code} has no key English lacks`, () => {
            expect(flattenKeys(dict).filter((k) => resolveKey(en, k) == null)).toEqual([]);
        });
        if (/^fr(-|$)/.test(code)) {
            // French sets a no-break space (U+00A0) before a colon, so it never starts a line (#1379).
            it(`${code} puts a no-break space, never a plain one, before a colon`, () => {
                const plain = flattenKeys(dict).filter((k) => / :/.test(resolveKey(dict, k)));
                expect(plain).toEqual([]);
            });
        }
    }

    it("every key the code asks for exists in en.json", () => {
        const unknown: string[] = [];
        for (const dir of ScannedDirs) {
            for (const file of sourceFiles(path.join(Root, dir))) {
                const source = fs.readFileSync(file, "utf8");
                if (!/\b(?:t|mt|phrase)\(/.test(source)) continue;
                for (const key of literalKeys(source)) {
                    if (resolveKey(en, key) == null) unknown.push(`${path.relative(Root, file)}: ${key}`);
                }
            }
        }
        expect(unknown).toEqual([]);
    });
});
