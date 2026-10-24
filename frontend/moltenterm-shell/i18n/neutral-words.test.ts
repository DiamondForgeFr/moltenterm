// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// UI text never names the machine or the OS (#628): "this computer", "Show in folder", "the system keychain" work on
// every platform. Shortcut glyphs adapt per platform elsewhere; a feature that only exists on one platform may say so,
// and its key goes in PlatformOnlyKeys with the reason.

import { describe, expect, it } from "vitest";
import { Strings as CopyBoxStrings } from "../../molten/builtin/copy-box/main.js";
import { availableLanguageCodes, flattenKeys, resolveKey, shippedDictionary } from "./i18n-core";

export const MachineWords = /\b(Mac|Macs|macOS|MacOS|OS X|Finder|Windows Explorer|File Explorer)\b/;

// key → why naming the platform is right there.
export const PlatformOnlyKeys: Record<string, string> = {
    // #1030: the constraint comes from one platform's installer format (MSI), which only takes numbers after the dash;
    // saying "installers" alone would hide why a format is unavailable for every other target.
    "mc.setup.reason.msiNumeric": "MSI installers are a Windows format",
};

export function machineWordProblems(entries: [string, string][]): string[] {
    return entries
        .filter(([key, text]) => PlatformOnlyKeys[key] == null && MachineWords.test(text))
        .map(([key, text]) => `${key}: ${text}`);
}

describe("neutral words (#628)", () => {
    it("catches the machine and OS names", () => {
        expect(machineWordProblems([["a", "Keep the Mac awake"]])).toHaveLength(1);
        expect(machineWordProblems([["a", "Show in Finder"]])).toHaveLength(1);
        expect(machineWordProblems([["a", "the macOS Keychain"]])).toHaveLength(1);
        expect(machineWordProblems([["a", "Keep this computer awake"]])).toEqual([]);
        expect(machineWordProblems([["a", "Machine learning"]])).toEqual([]);
    });

    for (const code of availableLanguageCodes().filter((c) => shippedDictionary(c) != null)) {
        it(`${code}.json names no machine or OS`, () => {
            const dict = shippedDictionary(code);
            const entries = flattenKeys(dict).map((k) => [k, resolveKey(dict, k)] as [string, string]);
            expect(machineWordProblems(entries)).toEqual([]);
        });
    }

    it("the copy box's strings name no machine or OS", () => {
        const entries = Object.entries(CopyBoxStrings).flatMap(([lang, strings]) =>
            Object.entries(strings as Record<string, string>).map(([k, v]) => [`${lang}.${k}`, v] as [string, string])
        );
        expect(machineWordProblems(entries)).toEqual([]);
    });
});
