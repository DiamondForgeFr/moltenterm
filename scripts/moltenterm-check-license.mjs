#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the licence headers honest (#1870). Moltenterm's own files are AGPL-3.0-only; the files that come from Wave
// Terminal, patched ones included, stay Apache-2.0 with Command Line Inc.'s copyright. A file is Wave's when it exists
// in the Wave release named in UPSTREAM.md "Current base", or carries Command Line Inc.'s copyright (a Wave file moved
// to another path); every other file is Moltenterm's. The check fails when:
//   - a Moltenterm file has another identifier than AGPL-3.0-only, or none when its format takes a comment header;
//   - a Wave file's copyright line or identifier differs from the base's;
//   - a licence file (LICENSE, LICENSE-APACHE, LICENSE-EXCEPTION, NOTICE, TRADEMARKS.md, CLA.md) is missing or is not
//     the expected text, or package.json states another licence;
//   - a document or a string of the interface claims a registered trademark (the filing is in progress).
// `--apply` rewrites the identifier of the Moltenterm files that still say Apache-2.0 and writes the missing headers. It
// never touches a Wave file. Third-party material and the SaaSFoundryAI harness carry their own headers and are skipped.
//
// Usage: node scripts/moltenterm-check-license.mjs [--apply]   (exit code 1 on a problem, 2 when it cannot run)

/* global console, process */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCurrentBase } from "./moltenterm-check-ledger.mjs";

export const OwnLicense = "AGPL-3.0-only";
export const WaveLicense = "Apache-2.0";
export const OwnCopyright = "Copyright 2026, DiamondForge";
export const PackageLicense = `${OwnLicense} AND ${WaveLicense}`;
export const HeaderLines = 12;

// Formats that take a comment header, and the ones that must carry it in a Moltenterm file.
export const HeaderExts = new Set([
    ...[".ts", ".tsx", ".js", ".cjs", ".mjs", ".go", ".css", ".scss"],
    ...[".html", ".svg", ".sh", ".yml", ".yaml"],
]);
export const RequiredExts = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs", ".go", ".css", ".scss"]);

// Third-party material, the harness installed by SaaSFoundryAI, and files whose text is data for a test or an example a
// user copies: none of them is Moltenterm's code, so none is touched.
export const ExemptPrefixes = [
    ".agents/",
    ".claude/",
    ".codex/",
    ".git/",
    ".github/workflows/pr-review-sync.yml",
    "node_modules/",
    "public/fontawesome-free/",
];
// The example mods the guides print for mod authors to copy (LICENSE-EXCEPTION, section 4). The copy box example is a
// byte copy of the built-in mod (pkg/molten/agents_test.go), so a header it has follows the built-in's; the others
// stay without one, and a header is never required there.
export const OptionalHeaderPrefixes = ["pkg/molten/agentdocs/examples/"];
export const ExemptSegments = ["testdata", "fixtures", "fontawesome-free"];
const MinifiedFile = /\.min\.[A-Za-z0-9]+$/;

export const LicenseFiles = [
    { file: "LICENSE", mustContain: ["GNU AFFERO GENERAL PUBLIC LICENSE", "Version 3, 19 November 2007"] },
    { file: "LICENSE-APACHE", mustContain: ["Apache License", "Version 2.0, January 2004"] },
    { file: "LICENSE-EXCEPTION", mustContain: ["section 7", "Public Mod Interface"] },
    { file: "NOTICE", mustContain: ["Copyright 2025, Command Line Inc.", OwnLicense, WaveLicense] },
    { file: "TRADEMARKS.md", mustContain: ["Trademark policy"] },
    { file: "CLA.md", mustContain: ["Contributor License Agreement"] },
    { file: "CONTRIBUTING.md", mustContain: ["CLA.md"] },
];

// The filing is in progress: no document and no string of the interface says the marks are registered.
export const RegisteredMarkGuards = ["README.md", "NOTICE", "TRADEMARKS.md", "MANIFESTO.md", "CONTRIBUTING.md"];
export const RegisteredMarkPrefixes = ["frontend/moltenterm-shell/i18n/locales/"];
const RegisteredMarkSymbol = "®";

export function isExempt(file) {
    if (ExemptPrefixes.some((p) => file.startsWith(p)) || MinifiedFile.test(file)) {
        return true;
    }
    return file.split("/").some((segment) => ExemptSegments.includes(segment));
}

export function isHeaderOptional(file) {
    return OptionalHeaderPrefixes.some((p) => file.startsWith(p));
}

export function headerOf(content) {
    const head = content.split("\n").slice(0, HeaderLines);
    const copyright = head.find((l) => /\bCopyright\b/.test(l));
    const spdx = /SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/.exec(head.join("\n"));
    return { copyright: copyright == null ? null : copyright.trim(), spdx: spdx == null ? null : spdx[1] };
}

export function originOf({ file, content, inBase }) {
    if (inBase) {
        return "wave";
    }
    const { copyright } = headerOf(content);
    return copyright != null && /Command Line/.test(copyright) ? "wave" : "own";
}

export function headerFor(file) {
    const ext = path.extname(file);
    if (ext === ".css" || ext === ".scss") {
        return `/* ${OwnCopyright} */\n/* SPDX-License-Identifier: ${OwnLicense} */\n\n`;
    }
    return `// ${OwnCopyright}\n// SPDX-License-Identifier: ${OwnLicense}\n\n`;
}

// Where a new header goes: after a shebang line, which must stay first.
export function withHeader(file, content) {
    const header = headerFor(file);
    if (!content.startsWith("#!")) {
        return header + content;
    }
    const eol = content.indexOf("\n");
    return `${content.slice(0, eol + 1)}${header}${content.slice(eol + 1)}`;
}

export function switchIdentifier(content) {
    const lines = content.split("\n");
    const limit = Math.min(lines.length, HeaderLines);
    for (let i = 0; i < limit; i++) {
        const next = lines[i].replace(
            /(SPDX-License-Identifier:\s*)Apache-2\.0(?![A-Za-z0-9.+-])/,
            `$1${OwnLicense}`
        );
        if (next !== lines[i]) {
            lines[i] = next;
            return lines.join("\n");
        }
    }
    return content;
}

// Pure core of the check. `files` lists [{ file, content, inBase, baseContent }] for every file to look at
// (baseContent is the file as the Wave base has it, null when the file is not in the base).
export function checkHeaders(files) {
    const problems = [];
    const counts = { wave: 0, own: 0, ownOk: 0, ownSwitch: 0, ownAdd: 0, ownNoHeader: 0, skipped: 0 };
    const switches = [];
    const additions = [];
    for (const f of files) {
        const ext = path.extname(f.file);
        if (isExempt(f.file) || !HeaderExts.has(ext)) {
            counts.skipped++;
            continue;
        }
        const { copyright, spdx } = headerOf(f.content);
        if (originOf(f) === "wave") {
            counts.wave++;
            if (f.baseContent != null) {
                const base = headerOf(f.baseContent);
                if (base.copyright !== copyright) {
                    problems.push({
                        file: f.file,
                        message: `Wave file whose copyright line changed (was "${base.copyright}"); never edit it`,
                    });
                }
                if (base.spdx !== spdx) {
                    problems.push({
                        file: f.file,
                        message: `Wave file whose licence identifier changed (was ${base.spdx ?? "none"}, now ${spdx ?? "none"}); Wave's files keep their header`,
                    });
                }
            } else if (spdx !== WaveLicense) {
                problems.push({
                    file: f.file,
                    message: `carries Command Line Inc.'s copyright, so it is a Wave file: its identifier must be ${WaveLicense}, not ${spdx ?? "none"}`,
                });
            }
            continue;
        }
        counts.own++;
        if (spdx === OwnLicense) {
            counts.ownOk++;
            continue;
        }
        if (spdx === WaveLicense) {
            counts.ownSwitch++;
            switches.push(f.file);
            problems.push({
                file: f.file,
                message: `Moltenterm file with ${WaveLicense}; it must be ${OwnLicense} (node scripts/moltenterm-check-license.mjs --apply)`,
            });
            continue;
        }
        if (spdx != null) {
            problems.push({
                file: f.file,
                message: `identifier ${spdx} on a Moltenterm file; third-party material belongs in ExemptPrefixes (scripts/moltenterm-check-license.mjs)`,
            });
            continue;
        }
        if (!RequiredExts.has(ext) || isHeaderOptional(f.file)) {
            counts.ownNoHeader++;
            continue;
        }
        counts.ownAdd++;
        additions.push(f.file);
        problems.push({
            file: f.file,
            message: `Moltenterm file without a licence header; it must start with "${OwnCopyright}" and "SPDX-License-Identifier: ${OwnLicense}" (--apply writes it)`,
        });
    }
    return { counts, problems, switches, additions };
}

export function checkLicenseFiles({ readFile, packageJson }) {
    const problems = [];
    for (const { file, mustContain } of LicenseFiles) {
        const content = readFile(file);
        if (content == null || content.trim() === "") {
            problems.push({ file, message: "missing or empty licence file" });
            continue;
        }
        for (const text of mustContain) {
            if (!content.includes(text)) {
                problems.push({ file, message: `does not contain "${text}"` });
            }
        }
    }
    if (packageJson == null || packageJson.license !== PackageLicense) {
        problems.push({
            file: "package.json",
            message: `"license" must be "${PackageLicense}" (found ${JSON.stringify(packageJson?.license)})`,
        });
    }
    return problems;
}

export function checkRegisteredMark(files) {
    return files
        .filter((f) => f.content.includes(RegisteredMarkSymbol))
        .map((f) => ({ file: f.file, message: "claims a registered trademark; the filing is in progress (TRADEMARKS.md)" }));
}

function git(root, args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function fail(message) {
    console.error(`licence headers: ${message}`);
    process.exit(2);
}

function readIfExists(root, rel) {
    try {
        return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
        return null;
    }
}

function main() {
    const apply = process.argv.includes("--apply");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const base = parseCurrentBase(fs.readFileSync(path.join(root, "UPSTREAM.md"), "utf8"));
    if (base == null) {
        fail('cannot read the base commit from the "Current base" table of UPSTREAM.md');
    }
    let baseSha;
    try {
        baseSha = git(root, ["rev-parse", "--verify", "--quiet", `${base.commit}^{commit}`]).trim();
    } catch {
        fail(
            `base commit ${base.commit} (${base.release}) is not in this clone; fetch the full history (actions/checkout: fetch-depth: 0)`
        );
    }
    const baseFiles = new Set(git(root, ["ls-tree", "-r", "--name-only", "-z", baseSha]).split("\0").filter(Boolean));
    const tracked = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean);
    const changed = new Set(
        git(root, ["diff", "--name-only", "--no-renames", "-z", baseSha, "--"]).split("\0").filter(Boolean)
    );

    const files = [];
    const texts = [];
    let notExamined = 0;
    for (const file of [...new Set(tracked)]) {
        const ext = path.extname(file);
        const watched = RegisteredMarkGuards.includes(file) || RegisteredMarkPrefixes.some((g) => file.startsWith(g));
        const examined = !isExempt(file) && HeaderExts.has(ext);
        if (!watched && !examined) {
            notExamined++;
            continue;
        }
        const content = readIfExists(root, file);
        if (content == null) {
            continue;
        }
        if (watched) {
            texts.push({ file, content });
        }
        if (!examined) {
            notExamined++;
            continue;
        }
        const inBase = baseFiles.has(file);
        let baseContent = null;
        if (inBase && changed.has(file)) {
            try {
                baseContent = git(root, ["show", `${baseSha}:${file}`]);
            } catch {
                baseContent = null;
            }
        } else if (inBase) {
            baseContent = content;
        }
        files.push({ file, content, inBase, baseContent });
    }

    let { counts, problems, switches, additions } = checkHeaders(files);
    const todo = { switch: switches.length, add: additions.length };
    if (apply) {
        for (const file of switches) {
            const content = readIfExists(root, file);
            fs.writeFileSync(path.join(root, file), switchIdentifier(content));
        }
        for (const file of additions) {
            const content = readIfExists(root, file);
            fs.writeFileSync(path.join(root, file), withHeader(file, content));
        }
        const rechecked = files.map((f) => ({ ...f, content: readIfExists(root, f.file) }));
        ({ counts, problems, switches, additions } = checkHeaders(rechecked));
    }
    let packageJson = null;
    try {
        packageJson = JSON.parse(readIfExists(root, "package.json"));
    } catch {
        packageJson = null;
    }
    problems = [
        ...problems,
        ...checkLicenseFiles({ readFile: (f) => readIfExists(root, f), packageJson }),
        ...checkRegisteredMark(texts),
    ];

    const summary = [
        `licence headers: base ${base.release} (${base.commit})`,
        `  Wave files, header as the base has it (${WaveLicense}): ${counts.wave}`,
        `  Moltenterm files: ${counts.own}`,
        `    ${OwnLicense}: ${counts.ownOk}`,
        `    ${apply ? "identifier rewritten to " + OwnLicense : "to rewrite"}: ${todo.switch}`,
        `    ${apply ? "header written" : "to head"}: ${todo.add}`,
        `    no header (format without comments, or not source code): ${counts.ownNoHeader}`,
        `  not examined (third-party, harness, test data, formats without a header): ${notExamined + counts.skipped}`,
    ];
    console.log(summary.join("\n"));
    if (problems.length === 0) {
        console.log("licence headers: all consistent");
        process.exit(0);
    }
    console.log(`licence headers: ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
    for (const p of problems.slice(0, 200)) {
        console.log(`  ${p.file}: ${p.message}`);
        if (process.env.GITHUB_ACTIONS === "true") {
            console.log(`::error file=${p.file}::${p.message}`);
        }
    }
    if (problems.length > 200) {
        console.log(`  ... and ${problems.length - 200} more`);
    }
    process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
