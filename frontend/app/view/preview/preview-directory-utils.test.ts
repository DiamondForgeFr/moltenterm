// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { translate } from "../../../moltenterm-shell/i18n/i18n-core";
import { getLastModifiedTime, typeLabel } from "./preview-directory-utils";

describe("getLastModifiedTime", () => {
    const thisYear = new Date().getFullYear();
    const sameYear = new Date(thisYear, 9, 6, 9, 5).getTime();

    it("writes the month in the interface language", () => {
        expect(getLastModifiedTime(sameYear, "en")).toBe("Oct 6 09:05");
        expect(getLastModifiedTime(sameYear, "fr")).toBe("6 oct. 09:05");
    });

    it("keeps an ISO date for another year", () => {
        const lastYear = new Date(thisYear - 1, 0, 2, 12, 0).getTime();
        expect(getLastModifiedTime(lastYear, "fr")).toBe(`${thisYear - 1}-01-02`);
    });
});

describe("typeLabel", () => {
    it("translates the folder type and leaves MIME types alone", () => {
        const fr = (key: string) => translate("fr", key);
        expect(typeLabel("directory", fr)).toBe("dossier");
        expect(typeLabel("text/plain; charset=utf-8", fr)).toBe("text/plain");
        expect(typeLabel(null, fr)).toBe("");
    });
});
