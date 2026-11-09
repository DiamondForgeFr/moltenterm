// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { isTextFile } from "./preview-model";
import { fileExtension, fileKindOf } from "./preview-nopreview";

const Xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const Docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const Pptx = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("the Files panel's text decision (#2114)", () => {
    it.each([Xlsx, Docx, Pptx])("never opens the Office document %s in the editor", (mime) => {
        expect(isTextFile(mime)).toBe(false);
    });

    it.each([
        "application/vnd.software602.filler.form-xml-zip",
        "application/prs.rdf-xml-crypt",
        "application/zip",
        "application/octet-stream",
    ])("treats the binary type %s as not text", (mime) => {
        expect(isTextFile(mime)).toBe(false);
    });

    it.each([
        "application/xml",
        "application/xml; charset=utf-8",
        "text/xml",
        "text/xml; charset=utf-8",
        "application/xhtml+xml",
        "application/x-rss+xml",
        "application/atom+xml",
        "application/xslt+xml",
        "application/xml-dtd",
        "application/CDFX+XML",
    ])("opens the XML type %s in the editor", (mime) => {
        expect(isTextFile(mime)).toBe(true);
    });

    it("keeps the other text types", () => {
        expect(isTextFile("text/plain")).toBe(true);
        expect(isTextFile("application/json")).toBe(true);
        expect(isTextFile("application/x-sh")).toBe(true);
    });
});

describe("the no-preview state's kind of file", () => {
    it("names the Office documents", () => {
        expect(fileKindOf(Xlsx, "budget.xlsx")).toBe("spreadsheet");
        expect(fileKindOf(Docx, "notes.docx")).toBe("document");
        expect(fileKindOf(Pptx, "deck.pptx")).toBe("presentation");
        expect(fileKindOf("application/vnd.ms-excel", "old.xls")).toBe("spreadsheet");
        expect(fileKindOf("application/msword", "old.doc")).toBe("document");
    });

    it("names archives and falls back to a plain file", () => {
        expect(fileKindOf("application/zip", "a.zip")).toBe("archive");
        expect(fileKindOf("application/gzip", "a.tar.gz")).toBe("archive");
        expect(fileKindOf("", "blob")).toBe("other");
        expect(fileKindOf(null, null)).toBe("other");
    });

    it("reads the extension", () => {
        expect(fileExtension("Report.XLSX")).toBe(".xlsx");
        expect(fileExtension(".bashrc")).toBe("");
        expect(fileExtension("noext")).toBe("");
        expect(fileExtension("trailing.")).toBe("");
    });
});
