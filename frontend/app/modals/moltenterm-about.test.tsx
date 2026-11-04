// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The About panel names the licence (#1870): AGPL-3.0 for MoltenTerm, Apache-2.0 for the parts from Wave Terminal, with a
// link to NOTICE, which says which part is under which licence.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AboutLicenseLine } from "./moltenterm-about";

describe("AboutLicenseLine", () => {
    it("names both licences and links to NOTICE", () => {
        const html = renderToStaticMarkup(<AboutLicenseLine />);
        expect(html).toContain("AGPL-3.0");
        expect(html).toContain("Apache-2.0");
        expect(html).toContain("/blob/main/NOTICE");
        expect(html).toContain('data-testid="about-license"');
    });

    it("does not claim a registered trademark", () => {
        expect(renderToStaticMarkup(<AboutLicenseLine />)).not.toContain("®");
    });
});
