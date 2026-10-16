// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { tipCode } from "./tips-view";

function translator(locale: any): (key: string) => string {
    return (key) => key.split(".").reduce((node, part) => node?.[part], locale);
}

describe("Tips commands (#749)", () => {
    it("translates a shown command's placeholder and keeps the command literal", () => {
        expect(tipCode({ id: "morph", code: "/morph", placeholder: "request" }, translator(fr))).toBe(
            "/morph <ce que vous voulez>"
        );
        expect(tipCode({ id: "copy", code: "molten copy", placeholder: "text" }, translator(fr))).toBe(
            "molten copy <texte>"
        );
        expect(tipCode({ id: "morph", code: "/morph", placeholder: "request" }, translator(en))).toBe(
            "/morph <what you want>"
        );
        expect(tipCode({ id: "undo", code: "molten undo" }, translator(fr))).toBe("molten undo");
    });
});
