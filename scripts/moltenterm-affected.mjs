#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The tests a change affects (#2011). CI, the local CI and agents run these instead of the whole suites; the full suites
// run on every push to develop and every night, so a gap in the selection shows within a day.
//
// The change is the diff between the merge base of HEAD with the base (origin/<workflow.prTargetBranch> by default) and
// the working tree: commits, staged and unstaged edits, untracked files. From it:
// - Go: the packages that hold a changed file, and every package whose test binary depends on one of them
//   (`go list -deps -test`). A file that is not Go source (an embedded file) selects the packages above it. A change to
//   `_test.go` or `testdata/` files only selects its own package. Tests that read files outside their package are listed
//   in GoReaders with what they read; one the script finds but the list lacks runs on every change.
// - Frontend: vitest's own graph (`vitest related`), plus the importers of a file imported with a query (`?raw`), which
//   the graph does not follow. Test files that read files or start processes run on every change: no graph sees what
//   they read. A locale change that only adds keys runs the i18n tests and the tests that read the dictionaries.
// What it cannot trace runs everything: shared ground (SharedGround), a changed or removed locale text, more than
// MaxChangedFiles files, no change at all (the base itself is being checked, like the gold's local CI on develop), and
// any error on the way. Never less.
//
// Usage: node scripts/moltenterm-affected.mjs [--print | --run | --plan] [--base <ref>] [--head <ref>]
//            [--only go|vitest] [--full [--full-reason <text>]] [--json] [--summary] [--outputs] [-- <suite args>]
//   --print    what to run (the default). --run runs it. --plan prints the CI's job decisions (needs neither Go nor
//              node_modules).
//   --head     diffs the base with that commit instead of the working tree; the graphs stay the working tree's.
//   --summary  appends the selection to $GITHUB_STEP_SUMMARY; --outputs writes the plan to $GITHUB_OUTPUT.
//   -- <args>  extra arguments for the one suite --only names (e.g. `-- -count=1` for go test).
// Exit code: the suites' with --run, 2 on a usage error.

/* global console, process */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MaxChangedFiles = 100;
export const DefaultBaseBranch = "develop";
export const LocalesDir = "frontend/moltenterm-shell/i18n/locales/";
export const I18nDir = "frontend/moltenterm-shell/i18n/";
export const VitestSetupFiles = ["frontend/moltenterm-shell/i18n/i18n-test-setup.js"];
// What `go test ./cmd/... ./pkg/...` covers; db/ and tsunami/ (a replaced module) only carry changes to them.
export const GoTestRoots = ["cmd/", "pkg/"];
export const GoSourceRoots = ["cmd/", "pkg/", "db/", "tsunami/"];
export const FullGoArgs = ["test", "./cmd/...", "./pkg/..."];
export const FullVitestArgs = ["vitest", "run"];

// A change here can move any test, and no graph says which.
export const SharedGround = [
    { pattern: /^go\.(mod|sum)$/, why: "the Go modules" },
    { pattern: /^(package\.json|package-lock\.json|\.npmrc)$/, why: "the npm manifests" },
    { pattern: /^(vitest|vite|electron\.vite)\.config\.[cm]?[jt]s$/, why: "the vite and vitest configuration" },
    { pattern: /^tsconfig[^/]*\.json$/, why: "the TypeScript configuration" },
    { pattern: /^Taskfile[^/]*\.ya?ml$/, why: "the Taskfile" },
    { pattern: /^\.github\/(workflows|actions)\//, why: "the CI workflows" },
    {
        pattern: /^frontend\/types\/(gotypes|waveevent)\.d\.ts$|^frontend\/app\/store\/(services|wshclientapi)\.ts$/,
        why: "the generated RPC types",
    },
    // The RPC types and their generated client; the handlers (wshserver, wshremote) are code like any other.
    { pattern: /^pkg\/wshrpc\/([^/]+\.go|wshclient\/.*)$/, why: "the RPC types (pkg/wshrpc)" },
    { pattern: new RegExp(`^(${VitestSetupFiles.map(escapeRegExp).join("|")})$`), why: "the test setup" },
    { pattern: /^scripts\/moltenterm-affected\.mjs$/, why: "the test selection itself" },
];

// Go tests that read files outside their package, by package directory, with the paths they read (a prefix, or a file).
// A change under one of them runs the package's tests. [] marks a false positive of GoReaderPattern.
export const GoReaders = {
    "cmd/wsh/cmd": ["UPSTREAM.md"],
    // ValidatePipeline("../..") reads the pipeline and the scripts, icon and files it names; agents_test the built-in mod.
    "pkg/molten": [".molten/", "scripts/", "build/", "frontend/molten/builtin/"],
    // The compatibility matrix names tests and adapter code anywhere in the code (TestConformanceCoherence).
    "pkg/molten/agentcontinuity": ["cmd/", "pkg/", "frontend/", "emain/"],
    "pkg/molten/agenthook": ["cmd/molten/"],
    "pkg/molten/companion": [],
    "pkg/molten/ghguard": ["cmd/", "pkg/"],
    "pkg/molten/materials": [],
    "pkg/molten/mission": [".molten/", "frontend/moltenterm-shell/reviews/testdata/"],
    "pkg/molten/onboarding": [LocalesDir],
    "pkg/molten/release": [".molten/", "scripts/", "build/"],
    "pkg/molten/reviewsession": [LocalesDir],
    "pkg/molten/sessions": [LocalesDir],
    "pkg/molten/uimsg": [LocalesDir, "pkg/molten/"],
    "pkg/util/shellutil": [],
    "pkg/wconfig": [LocalesDir],
};
export const GoReaderPattern =
    /filepath\.(Join|Abs)\(\s*"\.\."|"\.\.\/\.\.|runtime\.Caller\(|os\.(ReadFile|Open|Stat|ReadDir|Lstat)\("\.\.\/|=\s*"\.\."\s*$/m;
export const VitestReaderPattern =
    /\bfrom\s+["'](node:)?(fs|fs\/promises|child_process)["']|\b(require|import)\(\s*["'](node:)?(fs|fs\/promises|child_process)["']\s*\)/;

// What the Perf budgets measure (scripts/perf/README.md): the renderer bundle, Electron main, wavesrv's start-up and
// the harness. Test files move none of it.
export const PerfPaths = ["frontend/", "emain/", "index.html", "public/", "scripts/perf/", "cmd/server/", "db/"];
// What the dependency scan reads (scripts/security/scan.mjs), and the scanner itself.
export const DepsPaths = [
    "package.json",
    "package-lock.json",
    "docs/package.json",
    "docs/package-lock.json",
    "tsunami/frontend/package.json",
    "go.mod",
    "go.sum",
    "tsunami/go.mod",
    "tsunami/go.sum",
    "security/",
    "scripts/security/",
    ".github/workflows/security-scan.yml",
];

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function under(file, prefixes) {
    return prefixes.find(
        (prefix) => prefix === "" || file === prefix || (prefix.endsWith("/") && file.startsWith(prefix))
    );
}

export function isTestFile(file) {
    return (
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
        /_test\.go$/.test(file) ||
        /(^|\/)(testdata|__snapshots__)\//.test(file)
    );
}

export function isLocaleFile(file) {
    return file.startsWith(LocalesDir) && file.endsWith(".json");
}

export function sharedGroundOf(file) {
    return SharedGround.find((rule) => rule.pattern.test(file))?.why;
}

function leaves(value, prefix, out) {
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, inner] of Object.entries(value)) {
            leaves(inner, prefix === "" ? key : `${prefix}.${key}`, out);
        }
        return out;
    }
    out.set(prefix, JSON.stringify(value));
    return out;
}

// "added" when every text of `before` is still in `after`, word for word; "changed" otherwise. null is a missing file.
export function localeChange(before, after) {
    if (after == null) {
        return "changed";
    }
    let old;
    let now;
    try {
        old = before == null ? {} : JSON.parse(before);
        now = JSON.parse(after);
    } catch {
        return "changed";
    }
    const kept = leaves(now, "", new Map());
    for (const [key, text] of leaves(old, "", new Map())) {
        if (kept.get(key) !== text) {
            return "changed";
        }
    }
    return "added";
}

// Go packages whose tests read outside them, from their _test.go sources: { dir: [paths read] | null when unlisted }.
export function goReadersOf(testSources, table = GoReaders) {
    const readers = {};
    for (const [file, source] of Object.entries(testSources)) {
        if (!GoReaderPattern.test(source)) {
            continue;
        }
        const dir = path.posix.dirname(file);
        readers[dir] = Object.hasOwn(table, dir) ? table[dir] : null;
    }
    return readers;
}

// The readers a change selects: [{ dir, why }].
export function selectGoReaders(files, readers) {
    const selected = [];
    for (const [dir, reads] of Object.entries(readers).sort(([a], [b]) => a.localeCompare(b))) {
        if (reads == null) {
            selected.push({ dir, why: "its tests read outside their package and GoReaders does not say what" });
            continue;
        }
        for (const file of files) {
            const prefix = under(file, reads);
            if (prefix != null) {
                selected.push({ dir, why: `its tests read ${prefix} (${file})` });
                break;
            }
        }
    }
    return selected;
}

// The job decisions, from the changed paths alone (no Go, no node_modules): what CI's Select job needs.
export function planChanges(files, { localeKinds = {}, goReaders = {}, full = null } = {}) {
    const plan = { files, full, localesAdded: [], goReaders: [], jobs: {} };
    if (plan.full == null && files.length === 0) {
        plan.full = "no change against the base: the base itself is checked";
    }
    if (plan.full == null && files.length > MaxChangedFiles) {
        plan.full = `${files.length} changed files, more than ${MaxChangedFiles}`;
    }
    for (const file of files) {
        const shared = sharedGroundOf(file);
        if (shared != null) {
            plan.full ??= `${file} is shared ground (${shared})`;
        }
        if (isLocaleFile(file)) {
            if (localeKinds[file] === "added") {
                plan.localesAdded.push(file);
            } else {
                plan.full ??= `${file} changes or removes an existing text`;
            }
        }
    }
    plan.goReaders = selectGoReaders(files, goReaders);
    const goFiles = files.filter((file) => under(file, GoSourceRoots) != null);
    const goBuilt = goFiles.filter((file) => !isTestFile(file));
    const perf = files.filter((file) => under(file, PerfPaths) != null && !isTestFile(file));
    const deps = files.filter((file) => under(file, DepsPaths) != null);
    const changed = (list) =>
        list.length > 0 ? `${list[0]} changed${list.length > 1 ? ` (and ${list.length - 1} more)` : ""}` : null;
    const reader = plan.goReaders[0] != null ? `${plan.goReaders[0].dir}: ${plan.goReaders[0].why}` : null;
    const decide = (runWhy, skipWhy) => {
        if (plan.full != null) {
            return { run: true, why: `everything runs: ${plan.full}` };
        }
        return runWhy != null ? { run: true, why: runWhy } : { run: false, why: skipWhy };
    };
    plan.jobs = {
        backend: decide(changed(goFiles) ?? reader, "no Go file changed and no Go test reads a changed file"),
        gobuild: decide(changed(goBuilt), "no Go file the build compiles or embeds changed"),
        perf: decide(
            changed(perf),
            `the change touches nothing the budgets measure (${PerfPaths.join(", ")}; test files excluded)`
        ),
        deps: decide(changed(deps), "no manifest, lock file or scanner file changed"),
    };
    return plan;
}

// go list prints one JSON object after another.
export function parseJsonStream(text) {
    const out = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (c === "\\") {
                escaped = true;
            } else if (c === '"') {
                inString = false;
            }
            continue;
        }
        if (c === '"') {
            inString = true;
        } else if (c === "{") {
            if (depth === 0) {
                start = i;
            }
            depth++;
        } else if (c === "}") {
            depth--;
            if (depth === 0) {
                out.push(JSON.parse(text.slice(start, i + 1)));
            }
        }
    }
    if (depth !== 0) {
        throw new Error("go list printed a truncated JSON stream");
    }
    return out;
}

const stripVariant = (importPath) => importPath.replace(/ \[.*\]$/, "");

// The repository's packages from `go list -e -deps -test -json`: { packages: Map<dir, pkg>, errors }. A pkg's deps are
// its own and its test binary's (the ".test" main links the package, its tests and everything they import).
export function goGraph(entries, root) {
    const packages = new Map();
    const testMains = new Map();
    const errors = [];
    const inRepo = (dir) => dir === root || dir.startsWith(root + path.sep);
    for (const entry of entries) {
        if (entry.Standard || !entry.Dir || !inRepo(entry.Dir)) {
            continue;
        }
        const dir = path.relative(root, entry.Dir).split(path.sep).join("/");
        if (entry.Error) {
            errors.push(`${entry.ImportPath}: ${entry.Error.Err}`);
        }
        for (const err of entry.DepsErrors ?? []) {
            errors.push(`${entry.ImportPath}: ${err.Err}`);
        }
        if (entry.ImportPath.endsWith(".test")) {
            testMains.set(entry.ImportPath.slice(0, -".test".length), (entry.Deps ?? []).map(stripVariant));
            continue;
        }
        if (entry.ForTest || entry.ImportPath.includes(" [")) {
            continue;
        }
        const inDir = (names) => (names ?? []).map((name) => `${dir}/${name}`);
        packages.set(dir, {
            dir,
            importPath: entry.ImportPath,
            deps: new Set((entry.Deps ?? []).map(stripVariant)),
            embeds: new Set(inDir(entry.EmbedFiles)),
            testEmbeds: new Set([...inDir(entry.TestEmbedFiles), ...inDir(entry.XTestEmbedFiles)]),
        });
    }
    for (const pkg of packages.values()) {
        for (const dep of testMains.get(pkg.importPath) ?? []) {
            pkg.deps.add(dep);
        }
        pkg.tests = testMains.has(pkg.importPath);
    }
    return { packages, errors: [...new Set(errors)] };
}

function ancestors(file) {
    const dirs = [];
    for (let dir = path.posix.dirname(file); dir !== "." && dir !== "/"; dir = path.posix.dirname(dir)) {
        dirs.push(dir);
    }
    return dirs;
}

// The Go packages to test: { full: reason | null, packages: [{ dir, why }] }. `exists(path)` says whether a file or a
// directory is still there (a package removed with its files has nothing left to run).
//
// A file that is not Go source changes the packages that embed it (go list's EmbedFiles), and is a test input of the
// nearest package above it; once deleted, go list no longer names its embedder, so that nearest package counts as one.
export function selectGoPackages(files, graph, { readers = [], exists = () => true } = {}) {
    if (graph.errors.length > 0) {
        return { full: `go list reports an error, so the graph is incomplete: ${graph.errors[0]}`, packages: [] };
    }
    const direct = new Map();
    const mark = (dir, propagate, file) => {
        const seen = direct.get(dir);
        direct.set(dir, { propagate: propagate || (seen?.propagate ?? false), file: seen?.file ?? file });
    };
    for (const file of files) {
        if (under(file, GoSourceRoots) == null) {
            continue;
        }
        const testOnly = isTestFile(file);
        if (file.endsWith(".go") && !/(^|\/)testdata\//.test(file)) {
            const dir = path.posix.dirname(file);
            if (graph.packages.has(dir)) {
                mark(dir, !testOnly, file);
            } else if (exists(dir) && !file.startsWith("tsunami/")) {
                // A tsunami package missing from the graph is one no package of this module imports.
                return { full: `${file} is in no package go list knows`, packages: [] };
            }
            continue;
        }
        for (const pkg of graph.packages.values()) {
            if (pkg.embeds.has(file)) {
                mark(pkg.dir, true, file);
            } else if (pkg.testEmbeds.has(file)) {
                mark(pkg.dir, false, file);
            }
        }
        const nearest = ancestors(file).find((dir) => graph.packages.has(dir));
        if (nearest != null) {
            mark(nearest, !testOnly && !exists(file), file);
        }
    }
    const changed = new Map();
    for (const [dir, { propagate }] of direct) {
        if (propagate) {
            changed.set(graph.packages.get(dir).importPath, dir);
        }
    }
    const selected = new Map();
    for (const pkg of [...graph.packages.values()].sort((a, b) => a.dir.localeCompare(b.dir))) {
        if (under(pkg.dir + "/", GoTestRoots) == null) {
            continue;
        }
        if (direct.has(pkg.dir)) {
            selected.set(pkg.dir, `${direct.get(pkg.dir).file} changed`);
            continue;
        }
        for (const dep of pkg.deps) {
            if (changed.has(dep)) {
                selected.set(pkg.dir, `depends on ${changed.get(dep)}`);
                break;
            }
        }
    }
    for (const reader of readers) {
        if (!selected.has(reader.dir) && graph.packages.has(reader.dir)) {
            selected.set(reader.dir, reader.why);
        }
    }
    return {
        full: null,
        packages: [...selected].map(([dir, why]) => ({ dir, why })).sort((a, b) => a.dir.localeCompare(b.dir)),
    };
}

// Files that import one of `files` with a query (`./main.js?raw`): vitest's graph stops at the query.
export function queryImporters(files, sources) {
    const names = [...new Set(files.map((file) => path.posix.basename(file)))];
    if (names.length === 0) {
        return [];
    }
    const pattern = new RegExp(`["'][^"'\\n]*\\b(${names.map(escapeRegExp).join("|")})\\?[a-z]+["']`);
    return Object.entries(sources)
        .filter(([, source]) => pattern.test(source))
        .map(([file]) => file)
        .sort();
}

// The vitest files to run besides vitest's graph: { readers, locales } from the test files' sources.
export function extraVitestFiles(testSources, plan) {
    const readers = [];
    const locales = [];
    for (const [file, source] of Object.entries(testSources)) {
        if (VitestReaderPattern.test(source)) {
            readers.push(file);
        } else if (plan.localesAdded.length > 0 && (file.startsWith(I18nDir) || source.includes("locales/"))) {
            locales.push(file);
        }
    }
    return { readers: readers.sort(), locales: locales.sort() };
}

// ---- git, go and vitest

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 30, ...options });
    if (result.error != null) {
        throw new Error(`${command} could not run: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim().split("\n")[0]}`
        );
    }
    return result.stdout;
}

const git = (root, args) => run("git", args, { cwd: root });

export function repoRoot(cwd = process.cwd()) {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

export function defaultBase(root) {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, ".saasfoundry.json"), "utf8"));
        return `origin/${manifest.workflow?.prTargetBranch || DefaultBaseBranch}`;
    } catch {
        return `origin/${DefaultBaseBranch}`;
    }
}

const nulList = (text) => text.split("\0").filter((name) => name !== "");

// { mergeBase, files }: what changed since the merge base of `head` (or HEAD and the working tree) with `base`.
export function changedFiles(root, base, head) {
    const mergeBase = git(root, ["merge-base", head ?? "HEAD", base]).trim();
    const files = new Set();
    if (head != null) {
        nulList(git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase, head])).forEach((f) => files.add(f));
    } else {
        nulList(git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase])).forEach((f) => files.add(f));
        nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).forEach((f) => files.add(f));
    }
    return { mergeBase, files: [...files].sort() };
}

function readAt(root, rev, file) {
    const result = spawnSync("git", ["show", `${rev}:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 1 << 30 });
    return result.status === 0 ? result.stdout : null;
}

function readNow(root, head, file) {
    if (head != null) {
        return readAt(root, head, file);
    }
    try {
        return fs.readFileSync(path.join(root, file), "utf8");
    } catch {
        return null;
    }
}

function trackedAndNew(root, pathspecs) {
    return nulList(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs]));
}

function sourcesOf(root, files) {
    const sources = {};
    for (const file of files) {
        try {
            sources[file] = fs.readFileSync(path.join(root, file), "utf8");
        } catch {
            // Deleted in the working tree but still in the index: nothing to read.
        }
    }
    return sources;
}

export function goTestSources(root) {
    return sourcesOf(
        root,
        trackedAndNew(root, GoTestRoots).filter((file) => file.endsWith("_test.go"))
    );
}

function goList(root) {
    const fields = "ImportPath,Dir,Deps,Error,DepsErrors,ForTest,Standard,EmbedFiles,TestEmbedFiles,XTestEmbedFiles";
    const patterns = GoSourceRoots.filter((dir) => dir !== "tsunami/").map((dir) => `./${dir}...`);
    return goGraph(
        parseJsonStream(run("go", ["list", "-e", "-deps", "-test", `-json=${fields}`, ...patterns], { cwd: root })),
        root
    );
}

async function vitestFiles(root, plan) {
    const { createVitest } = await import("vitest/node");
    const vitest = await createVitest("test", { root, watch: false, run: true, passWithNoTests: true, reporters: [] });
    try {
        const all = (await vitest.globTestSpecifications()).map((spec) => spec.moduleId);
        const rel = (file) => path.relative(root, file).split(path.sep).join("/");
        const testFiles = [...new Set(all.map(rel))].sort();
        const sourceFiles = trackedAndNew(root, ["frontend", "emain"]).filter((f) => /\.[cm]?[jt]sx?$/.test(f));
        const inputs = plan.files.filter((file) => !plan.localesAdded.includes(file));
        const importers = queryImporters(inputs, sourcesOf(root, sourceFiles));
        vitest.config.related = [...new Set([...inputs, ...importers])].map((file) => path.join(root, file));
        const related = [...new Set((await vitest.getRelevantTestSpecifications()).map((spec) => rel(spec.moduleId)))];
        const extra = extraVitestFiles(sourcesOf(root, testFiles), plan);
        const files = [...new Set([...related, ...extra.readers, ...extra.locales])].sort();
        return {
            total: testFiles.length,
            files,
            related: related.length,
            readers: extra.readers.length,
            locales: extra.locales.length,
            importers,
        };
    } finally {
        await vitest.close();
    }
}

// ---- the selection

export async function select(options) {
    const root = options.root;
    const selection = {
        base: options.base,
        head: options.head ?? "the working tree",
        mergeBase: null,
        plan: null,
        go: null,
        vitest: null,
    };
    let files = [];
    let full = options.full ? options.fullReason || "--full was given" : null;
    const localeKinds = {};
    if (full == null) {
        try {
            const changes = changedFiles(root, options.base, options.head);
            selection.mergeBase = changes.mergeBase;
            files = changes.files;
            for (const file of files.filter(isLocaleFile)) {
                localeKinds[file] = localeChange(
                    readAt(root, changes.mergeBase, file),
                    readNow(root, options.head, file)
                );
            }
        } catch (err) {
            full = `the change against ${options.base} cannot be read: ${err.message}`;
        }
    }
    let goReaders = {};
    try {
        goReaders = goReadersOf(goTestSources(root));
    } catch (err) {
        full ??= `the Go tests cannot be read: ${err.message}`;
    }
    const plan = planChanges(files, { localeKinds, goReaders, full });
    selection.plan = plan;
    if (options.mode === "plan") {
        return selection;
    }
    if (options.only !== "vitest") {
        selection.go = selectGo(root, plan);
    }
    if (options.only !== "go") {
        selection.vitest = await selectVitest(root, plan);
    }
    return selection;
}

function selectGo(root, plan) {
    if (plan.full != null) {
        return { full: plan.full, packages: [] };
    }
    try {
        const graph = goList(root);
        const picked = selectGoPackages(plan.files, graph, {
            readers: plan.goReaders,
            exists: (dir) => fs.existsSync(path.join(root, dir)),
        });
        const tested = new Set(
            [...graph.packages.values()]
                .filter((pkg) => pkg.tests && under(pkg.dir + "/", GoTestRoots) != null)
                .map((pkg) => pkg.dir)
        );
        return {
            ...picked,
            total: tested.size,
            withTests: picked.packages.filter((pkg) => tested.has(pkg.dir)).length,
        };
    } catch (err) {
        return { full: `the Go graph cannot be read: ${err.message}`, packages: [] };
    }
}

async function selectVitest(root, plan) {
    if (plan.full != null) {
        return { full: plan.full, files: [] };
    }
    try {
        return { full: null, ...(await vitestFiles(root, plan)) };
    } catch (err) {
        return { full: `the vitest graph cannot be read: ${err.message}`, files: [] };
    }
}

// ---- output

function goCommand(go, extra) {
    return go.full != null
        ? ["go", ...FullGoArgs, ...extra]
        : ["go", "test", ...go.packages.map((pkg) => `./${pkg.dir}`), ...extra];
}

function vitestCommand(vitest, extra) {
    return vitest.full != null
        ? ["npx", ...FullVitestArgs, ...extra]
        : ["npx", "vitest", "run", ...vitest.files, ...extra];
}

export function describeSelection(selection) {
    const lines = [];
    const { plan } = selection;
    const base = selection.mergeBase
        ? `${selection.base} (merge base ${selection.mergeBase.slice(0, 9)})`
        : selection.base;
    lines.push(`Base: ${base}, compared with ${selection.head}: ${plan.files.length} changed file(s)`);
    if (plan.full != null) {
        lines.push(`Everything runs: ${plan.full}`);
    }
    for (const [job, { run: runs, why }] of Object.entries(plan.jobs)) {
        lines.push(`  ${job.padEnd(8)} ${runs ? "runs" : "skips"}: ${why}`);
    }
    if (selection.go != null) {
        const go = selection.go;
        if (go.full != null) {
            lines.push(`Go: every package (${go.full})`);
        } else {
            lines.push(`Go: ${go.withTests} of ${go.total} packages with tests (${go.packages.length} packages built)`);
            for (const pkg of go.packages) {
                lines.push(`  ./${pkg.dir.padEnd(40)} ${pkg.why}`);
            }
        }
    }
    if (selection.vitest != null) {
        const vitest = selection.vitest;
        if (vitest.full != null) {
            lines.push(`Frontend: every test file (${vitest.full})`);
        } else {
            lines.push(
                `Frontend: ${vitest.files.length} of ${vitest.total} test files (${vitest.related} from vitest's graph, ` +
                    `${vitest.readers} that read files or start processes, ${vitest.locales} for added locale keys)`
            );
            for (const file of vitest.files) {
                lines.push(`  ${file}`);
            }
        }
    }
    return lines.join("\n");
}

function markdownSummary(selection) {
    const { plan } = selection;
    const lines = ["### Affected tests (scripts/moltenterm-affected.mjs)", ""];
    lines.push(`${plan.files.length} changed file(s) against \`${selection.base}\`.`);
    if (plan.full != null) {
        lines.push("", `**Everything runs:** ${plan.full}.`);
    }
    lines.push("", "| Job | Decision | Why |", "| --- | --- | --- |");
    for (const [job, { run: runs, why }] of Object.entries(plan.jobs)) {
        lines.push(`| ${job} | ${runs ? "runs" : "skips"} | ${why.replaceAll("|", "\\|")} |`);
    }
    const list = (title, items) => {
        lines.push(
            "",
            `<details><summary>${title}</summary>`,
            "",
            ...items.map((item) => `- \`${item}\``),
            "",
            "</details>"
        );
    };
    if (selection.go?.full == null && selection.go != null) {
        list(
            `Go: ${selection.go.withTests} of ${selection.go.total} packages with tests`,
            selection.go.packages.map((p) => `./${p.dir}: ${p.why}`)
        );
    }
    if (selection.vitest?.full == null && selection.vitest != null) {
        list(
            `Frontend: ${selection.vitest.files.length} of ${selection.vitest.total} test files`,
            selection.vitest.files
        );
    }
    lines.push("", "Add the `ci:full` label and re-run the jobs to run the full suites.", "");
    return lines.join("\n");
}

function writeOutputs(selection) {
    const { plan } = selection;
    const out = [`full=${plan.full != null}`, `reason=${(plan.full ?? "").replaceAll("\n", " ")}`];
    for (const [job, { run: runs, why }] of Object.entries(plan.jobs)) {
        out.push(`${job}=${runs}`, `${job}why=${why.replaceAll("\n", " ")}`);
    }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out.join("\n") + "\n");
}

function elapsed(ms) {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function runSuite(name, command, root) {
    console.log(
        `\n▶ ${name}: ${command.length > 12 ? [...command.slice(0, 12), `… (${command.length - 12} more)`].join(" ") : command.join(" ")}`
    );
    const started = Date.now();
    const result = spawnSync(command[0], command.slice(1), { cwd: root, stdio: "inherit" });
    const status = result.error != null ? 1 : (result.status ?? 1);
    console.log(
        `${status === 0 ? "✓" : "✗"} ${name}: ${status === 0 ? "passed" : `failed (exit ${status})`} in ${elapsed(Date.now() - started)}`
    );
    return status;
}

export function runSelection(selection, root, extra) {
    let status = 0;
    if (selection.vitest != null) {
        if (selection.vitest.full == null && selection.vitest.files.length === 0) {
            console.log("\n▶ frontend: no test file selected");
        } else {
            status ||= runSuite("frontend", vitestCommand(selection.vitest, extra), root);
        }
    }
    if (selection.go != null) {
        if (selection.go.full == null && selection.go.packages.length === 0) {
            console.log("\n▶ go: no package selected");
        } else {
            status ||= runSuite("go", goCommand(selection.go, extra), root);
        }
    }
    return status;
}

const Usage =
    "Usage: node scripts/moltenterm-affected.mjs [--print | --run | --plan] [--base <ref>] [--head <ref>] [--only go|vitest] " +
    "[--full [--full-reason <text>]] [--json] [--summary] [--outputs] [-- <suite args>]";

export function parseArgs(argv) {
    const options = {
        mode: "print",
        base: null,
        head: null,
        only: null,
        full: false,
        fullReason: null,
        json: false,
        summary: false,
        outputs: false,
        extra: [],
    };
    const value = (i, flag) => {
        if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
            throw new Error(`${flag} needs a value`);
        }
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--print":
            case "--run":
            case "--plan":
                options.mode = arg.slice(2);
                break;
            case "--base":
            case "--head":
            case "--only":
            case "--full-reason":
                options[arg === "--full-reason" ? "fullReason" : arg.slice(2)] = value(i, arg);
                i++;
                break;
            case "--full":
            case "--json":
            case "--summary":
            case "--outputs":
                options[arg.slice(2)] = true;
                break;
            case "--":
                options.extra = argv.slice(i + 1);
                i = argv.length;
                break;
            default:
                throw new Error(`unknown argument ${arg}`);
        }
    }
    if (options.only != null && !["go", "vitest"].includes(options.only)) {
        throw new Error("--only takes go or vitest");
    }
    if (options.extra.length > 0 && options.only == null) {
        throw new Error("arguments after -- need --only, to say which suite takes them");
    }
    return options;
}

async function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (err) {
        console.error(`${err.message}\n${Usage}`);
        return 2;
    }
    const root = repoRoot();
    options.root = root;
    options.base ??= defaultBase(root);
    const selection = await select(options);
    if (options.summary && process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdownSummary(selection));
    }
    if (options.outputs && process.env.GITHUB_OUTPUT) {
        writeOutputs(selection);
    }
    if (options.json) {
        console.log(JSON.stringify(selection, null, 2));
    } else {
        console.log(describeSelection(selection));
    }
    return options.mode === "run" ? runSelection(selection, root, options.extra) : 0;
}

if (process.argv[1] != null && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main(process.argv.slice(2));
}
