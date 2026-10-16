// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { serverErrorText, serverText, serverTexts, unwireError } from "./server-text";

vi.mock("./i18n-core", () => ({
    hasKey: (key: string) => key === "server.test.known",
}));
vi.mock("./i18n", () => ({
    t: (key: string, vars: Record<string, string>) => `[${key} ${JSON.stringify(vars)}]`,
}));

describe("serverText", () => {
    it("words a known code with its vars", () => {
        expect(serverText({ code: "test.known", vars: { detail: "x" } }, "English")).toBe(
            '[server.test.known {"detail":"x"}]'
        );
    });

    it("shows the English without a code, or for a code the window does not know", () => {
        expect(serverText(null, "English")).toBe("English");
        expect(serverText({ code: "" }, "English")).toBe("English");
        expect(serverText({ code: "test.unknown" }, "English")).toBe("English");
    });

    it("words parts first, and shows the English when a part's code is unknown (#750)", () => {
        const part = { code: "test.known", vars: { n: "3" } };
        expect(serverText({ code: "test.known", vars: { a: "x" }, parts: { p: part } }, "English")).toBe(
            `[server.test.known ${JSON.stringify({ a: "x", p: '[server.test.known {"n":"3"}]' })}]`
        );
        expect(serverText({ code: "test.known", parts: { p: { code: "test.unknown" } } }, "English")).toBe("English");
    });

    it("words lists by position", () => {
        expect(serverTexts([{ code: "test.known" }, null], ["a", "b"])).toEqual(["[server.test.known {}]", "b"]);
        expect(serverTexts(null, ["a"])).toEqual(["a"]);
    });
});

describe("route errors", () => {
    const wired = 'uimsg:{"code":"test.known","vars":{"detail":"line1\\nline2"}}\nit failed: line1\nline2';

    it("splits a wired error", () => {
        expect(unwireError(wired)).toEqual({
            text: { code: "test.known", vars: { detail: "line1\nline2" } },
            english: "it failed: line1\nline2",
        });
    });

    it("leaves a plain error alone", () => {
        expect(unwireError("plain")).toEqual({ text: null, english: "plain" });
        expect(unwireError("uimsg:{broken\nx")).toEqual({ text: null, english: "uimsg:{broken\nx" });
    });

    it("words a caught error", () => {
        expect(serverErrorText(new Error(wired))).toBe('[server.test.known {"detail":"line1\\nline2"}]');
        expect(serverErrorText(new Error('uimsg:{"code":"test.unknown"}\nEnglish'))).toBe("English");
        expect(serverErrorText("text")).toBe("text");
        expect(serverErrorText(new Error("plain"))).toBe("plain");
    });
});
