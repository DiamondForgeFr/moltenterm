// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    checkHeaders,
    checkLicenseFiles,
    checkRegisteredMark,
    headerFor,
    headerOf,
    isExempt,
    originOf,
    PackageLicense,
    switchIdentifier,
    withHeader,
} from "./moltenterm-check-license.mjs";

const Wave = "// Copyright 2025, Command Line Inc.\n// SPDX-License-Identifier: Apache-2.0\n\nexport {};\n";
const Own = "// Copyright 2026, DiamondForge\n// SPDX-License-Identifier: AGPL-3.0-only\n\nexport {};\n";
const OwnApache = "// Copyright 2026, DiamondForge\n// SPDX-License-Identifier: Apache-2.0\n\nexport {};\n";

function wave(file, content, baseContent = content) {
    return { file, content, inBase: true, baseContent };
}

function own(file, content) {
    return { file, content, inBase: false, baseContent: null };
}

describe("headerOf", () => {
    it("reads the copyright line and the identifier in any comment syntax", () => {
        expect(headerOf(Wave)).toEqual({
            copyright: "// Copyright 2025, Command Line Inc.",
            spdx: "Apache-2.0",
        });
        expect(headerOf("/* SPDX-License-Identifier: Apache-2.0 */\n")).toEqual({ copyright: null, spdx: "Apache-2.0" });
        expect(headerOf("# Copyright 2026, DiamondForge\n# SPDX-License-Identifier: AGPL-3.0-only\n").spdx).toBe(
            "AGPL-3.0-only"
        );
    });

    it("keeps Wave's own typo as it is, so it compares equal to the base", () => {
        expect(headerOf("// SPDX-License-Identifier: Apache-2.0s\n").spdx).toBe("Apache-2.0s");
    });

    it("looks only at the first lines", () => {
        const late = `${"x\n".repeat(20)}// SPDX-License-Identifier: MIT\n`;
        expect(headerOf(late)).toEqual({ copyright: null, spdx: null });
    });
});

describe("originOf", () => {
    it("is Wave for a file of the base, whatever its header says", () => {
        expect(originOf({ file: "a.ts", content: Own, inBase: true })).toBe("wave");
    });

    it("is Wave for a file added since the base that carries Command Line Inc.'s copyright", () => {
        expect(originOf({ file: "moved.ts", content: Wave, inBase: false })).toBe("wave");
    });

    it("is Moltenterm's for any other file", () => {
        expect(originOf({ file: "b.ts", content: OwnApache, inBase: false })).toBe("own");
        expect(originOf({ file: "c.ts", content: "export {};\n", inBase: false })).toBe("own");
    });
});

describe("checkHeaders", () => {
    it("accepts a Wave file with Wave's header and a Moltenterm file with AGPL-3.0-only", () => {
        const r = checkHeaders([wave("emain/a.ts", Wave), own("emain/b.ts", Own)]);
        expect(r.problems).toEqual([]);
        expect(r.counts).toMatchObject({ wave: 1, own: 1, ownOk: 1 });
    });

    it("keeps a patched Wave file Apache-2.0 whatever the patch", () => {
        const patched = Wave.replace("export {};", "// MOLTENTERM-PATCH (#1)\nexport {};");
        expect(checkHeaders([wave("emain/a.ts", patched, Wave)]).problems).toEqual([]);
    });

    it("fails a Wave file whose copyright line changed", () => {
        const edited = Wave.replace("Command Line Inc.", "DiamondForge");
        const r = checkHeaders([wave("emain/a.ts", edited, Wave)]);
        expect(r.problems.map((p) => p.message)).toEqual([expect.stringContaining("copyright line changed")]);
    });

    it("fails a Wave file switched to AGPL-3.0-only", () => {
        const switched = Wave.replace("Apache-2.0", "AGPL-3.0-only");
        const r = checkHeaders([wave("emain/a.ts", switched, Wave)]);
        expect(r.problems.map((p) => p.message)).toEqual([expect.stringContaining("identifier changed")]);
    });

    it("fails a header added to a Wave file that had none", () => {
        const r = checkHeaders([wave("emain/a.ts", Own, "export {};\n")]);
        expect(r.problems).toHaveLength(2);
    });

    it("fails a moved Wave file that is not Apache-2.0", () => {
        const r = checkHeaders([own("moved.ts", Wave.replace("Apache-2.0", "AGPL-3.0-only"))]);
        expect(r.problems.map((p) => p.message)).toEqual([expect.stringContaining("is a Wave file")]);
    });

    it("fails a Moltenterm file that still says Apache-2.0 and lists it for --apply", () => {
        const r = checkHeaders([own("frontend/new.ts", OwnApache)]);
        expect(r.switches).toEqual(["frontend/new.ts"]);
        expect(r.problems).toHaveLength(1);
    });

    it("fails a Moltenterm source file without a header and lists it for --apply", () => {
        const r = checkHeaders([own("frontend/new.test.ts", "export {};\n")]);
        expect(r.additions).toEqual(["frontend/new.test.ts"]);
        expect(r.problems).toHaveLength(1);
    });

    it("lets a Moltenterm file of a format without a required header stay without one", () => {
        const r = checkHeaders([own("scripts/run.sh", "echo hi\n"), own("a/b.svg", "<svg/>\n")]);
        expect(r.problems).toEqual([]);
        expect(r.counts.ownNoHeader).toBe(2);
    });

    it("fails another identifier on a Moltenterm file", () => {
        const r = checkHeaders([own("frontend/new.ts", OwnApache.replace("Apache-2.0", "MIT"))]);
        expect(r.problems.map((p) => p.message)).toEqual([expect.stringContaining("identifier MIT")]);
    });

    it("skips third-party material, the harness, test data and other formats", () => {
        const r = checkHeaders([
            own(".claude/skills/x/run.sh", "echo\n"),
            own("pkg/molten/mission/testdata/cijobs/nightly.yml", "# SPDX-License-Identifier: Apache-2.0\n"),
            own("pkg/molten/agentdocs/examples/test-band/main.js", "export {};\n"),
            own("package.json", "{}\n"),
        ]);
        expect(r.problems).toEqual([]);
        expect(r.counts.skipped).toBe(4);
    });
});

describe("switchIdentifier", () => {
    it("rewrites the identifier in the header and nothing else", () => {
        const text = `${OwnApache}const s = "SPDX-License-Identifier: Apache-2.0";\n`;
        expect(switchIdentifier(text)).toBe(`${Own}const s = "SPDX-License-Identifier: Apache-2.0";\n`);
    });

    it("handles block comments and hash comments", () => {
        expect(switchIdentifier("/* SPDX-License-Identifier: Apache-2.0 */\n.a {}\n")).toBe(
            "/* SPDX-License-Identifier: AGPL-3.0-only */\n.a {}\n"
        );
        expect(switchIdentifier("# SPDX-License-Identifier: Apache-2.0\nname: x\n")).toBe(
            "# SPDX-License-Identifier: AGPL-3.0-only\nname: x\n"
        );
    });

    it("leaves another identifier alone, Wave's Apache-2.0s typo included", () => {
        const typo = "// SPDX-License-Identifier: Apache-2.0s\n";
        expect(switchIdentifier(typo)).toBe(typo);
    });

    it("does not touch the copyright line", () => {
        expect(switchIdentifier(OwnApache).split("\n")[0]).toBe("// Copyright 2026, DiamondForge");
    });
});

describe("withHeader", () => {
    it("puts the header first and a blank line after it", () => {
        expect(withHeader("a.ts", "export {};\n")).toBe(Own);
    });

    it("keeps a shebang on the first line", () => {
        const out = withHeader("run.mjs", "#!/usr/bin/env node\nconsole.log(1);\n");
        expect(out.startsWith("#!/usr/bin/env node\n// Copyright 2026, DiamondForge\n")).toBe(true);
    });

    it("writes a block comment in a stylesheet", () => {
        expect(headerFor("a.css")).toBe(
            "/* Copyright 2026, DiamondForge */\n/* SPDX-License-Identifier: AGPL-3.0-only */\n\n"
        );
    });

    it("yields a file the check accepts", () => {
        const out = withHeader("frontend/a.test.ts", "export {};\n");
        expect(checkHeaders([own("frontend/a.test.ts", out)]).problems).toEqual([]);
    });
});

describe("isExempt", () => {
    it("matches the harness, third-party folders and test data", () => {
        expect(isExempt(".claude/skills/sf-workflow/workflow-cli.sh")).toBe(true);
        expect(isExempt("public/fontawesome-free/css/all.css")).toBe(true);
        expect(isExempt("docs/static/fontawesome-free/css/brands.min.css")).toBe(true);
        expect(isExempt("vendor/lib/thing.min.js")).toBe(true);
        expect(isExempt("frontend/app/admin.js")).toBe(false);
        expect(isExempt("pkg/molten/mission/testdata/x.yml")).toBe(true);
        expect(isExempt("scripts/fixtures/x.mjs")).toBe(true);
        expect(isExempt(".github/workflows/ci.yml")).toBe(false);
        expect(isExempt("emain/emain.ts")).toBe(false);
    });
});

describe("checkLicenseFiles", () => {
    const Good = {
        LICENSE: "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n",
        "LICENSE-APACHE": "Apache License\nVersion 2.0, January 2004\n",
        "LICENSE-EXCEPTION": "section 7\nPublic Mod Interface\n",
        NOTICE: "Copyright 2025, Command Line Inc.\nAGPL-3.0-only\nApache-2.0\n",
        "TRADEMARKS.md": "# Trademark policy\n",
        "CLA.md": "# MoltenTerm Contributor License Agreement\n",
        "CONTRIBUTING.md": "see CLA.md\n",
    };
    const read = (files) => (f) => files[f] ?? null;

    it("accepts the expected texts and package license", () => {
        expect(checkLicenseFiles({ readFile: read(Good), packageJson: { license: PackageLicense } })).toEqual([]);
    });

    it("fails a missing file, a wrong text and a wrong package license", () => {
        const files = { ...Good, LICENSE: "Apache License\n" };
        delete files["CLA.md"];
        const problems = checkLicenseFiles({ readFile: read(files), packageJson: { license: "Apache-2.0" } });
        expect(problems.map((p) => p.file).sort()).toEqual(["CLA.md", "LICENSE", "LICENSE", "package.json"]);
    });

    it("fails a NOTICE that lost Wave's notice", () => {
        const files = { ...Good, NOTICE: "AGPL-3.0-only Apache-2.0\n" };
        const problems = checkLicenseFiles({ readFile: read(files), packageJson: { license: PackageLicense } });
        expect(problems).toEqual([{ file: "NOTICE", message: 'does not contain "Copyright 2025, Command Line Inc."' }]);
    });
});

describe("checkRegisteredMark", () => {
    it("fails a text that claims a registered trademark", () => {
        const problems = checkRegisteredMark([
            { file: "README.md", content: "MoltenTerm®\n" },
            { file: "NOTICE", content: "MoltenTerm\n" },
        ]);
        expect(problems.map((p) => p.file)).toEqual(["README.md"]);
    });
});
