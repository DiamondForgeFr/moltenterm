// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

/* global process, URL */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
    changedFiles,
    extraVitestFiles,
    goGraph,
    GoReaders,
    goReadersOf,
    localeChange,
    MaxChangedFiles,
    parseArgs,
    parseJsonStream,
    planChanges,
    queryImporters,
    select,
    selectGoPackages,
    selectGoReaders,
    VitestSetupFiles,
} from "./moltenterm-affected.mjs";

const RepoRoot = path.resolve(path.dirname(fileURLToPath(new URL(import.meta.url))), "..");
// Only the bound of a hung git on a loaded machine.
const GitTimeout = { timeout: 60_000 };

// A small module: leaf <- mid <- top <- cmd/app, top embeds nothing but imports db (which embeds a migration),
// testuser imports leaf from its tests only, other depends on nothing.
function fixtureGraph() {
    const root = "/repo";
    const pkg = (dir, deps = [], extra = {}) => ({
        ImportPath: `m/${dir}`,
        Dir: `${root}/${dir}`,
        Deps: deps.map((d) => `m/${d}`),
        ...extra,
    });
    const test = (dir, deps) => ({
        ImportPath: `m/${dir}.test`,
        Dir: `${root}/${dir}`,
        Deps: [...deps.map((d) => `m/${d}`), `m/${dir} [m/${dir}.test]`],
    });
    const entries = [
        pkg("pkg/leaf"),
        pkg("pkg/mid", ["pkg/leaf"]),
        pkg("db", [], { EmbedFiles: ["migrations/1.sql"] }),
        pkg("pkg/top", ["pkg/mid", "pkg/leaf", "db"]),
        pkg("pkg/other"),
        pkg("pkg/testuser"),
        pkg("cmd/app", ["pkg/top", "pkg/mid", "pkg/leaf", "db"]),
        { ImportPath: "fmt", Dir: "/usr/local/go/src/fmt", Standard: true },
        test("pkg/leaf", []),
        test("pkg/mid", ["pkg/leaf"]),
        test("pkg/top", ["pkg/mid", "pkg/leaf", "db"]),
        test("pkg/other", []),
        test("pkg/testuser", ["pkg/leaf"]),
        { ImportPath: "m/pkg/leaf [m/pkg/leaf.test]", Dir: `${root}/pkg/leaf`, ForTest: "m/pkg/leaf" },
    ];
    return goGraph(entries, root);
}

const dirsOf = (selection) => selection.packages.map((pkg) => pkg.dir);

describe("Go selection", () => {
    it("selects a leaf package's dependents, test-only importers included, and nothing else", () => {
        const selection = selectGoPackages(["pkg/leaf/leaf.go"], fixtureGraph());
        expect(selection.full).toBeNull();
        expect(dirsOf(selection)).toEqual(["cmd/app", "pkg/leaf", "pkg/mid", "pkg/testuser", "pkg/top"]);
    });

    it("selects only the package itself when its tests or testdata change", () => {
        expect(dirsOf(selectGoPackages(["pkg/leaf/leaf_test.go"], fixtureGraph()))).toEqual(["pkg/leaf"]);
        expect(dirsOf(selectGoPackages(["pkg/leaf/testdata/case.json"], fixtureGraph()))).toEqual(["pkg/leaf"]);
    });

    it("selects the dependents of the package that embeds a changed file", () => {
        // db itself is outside `go test ./cmd/... ./pkg/...`, so only what depends on it runs.
        expect(dirsOf(selectGoPackages(["db/migrations/1.sql"], fixtureGraph()))).toEqual(["cmd/app", "pkg/top"]);
    });

    it("treats a file only read by the nearest package's tests as a test input", () => {
        expect(dirsOf(selectGoPackages(["pkg/mid/notes.md"], fixtureGraph()))).toEqual(["pkg/mid"]);
        // Deleted, it may have been embedded: the nearest package counts as changed.
        const deleted = selectGoPackages(["pkg/mid/notes.md"], fixtureGraph(), {
            exists: (p) => p !== "pkg/mid/notes.md",
        });
        expect(dirsOf(deleted)).toEqual(["cmd/app", "pkg/mid", "pkg/top"]);
    });

    it("runs everything when the graph is incomplete or a Go file is in no known package", () => {
        const graph = fixtureGraph();
        graph.errors.push("m/pkg/top: syntax error");
        expect(selectGoPackages(["pkg/leaf/leaf.go"], graph).full).toMatch(/go list reports an error/);
        expect(selectGoPackages(["pkg/unknown/x.go"], fixtureGraph()).full).toMatch(/in no package/);
        // A package removed with its folder leaves nothing to run.
        expect(selectGoPackages(["pkg/gone/x.go"], fixtureGraph(), { exists: () => false })).toEqual({
            full: null,
            packages: [],
        });
    });

    it("adds the tests that read a changed file outside their package", () => {
        const readers = goReadersOf(
            {
                "pkg/other/a_test.go": 'os.ReadFile(filepath.Join("..", "..", "UPSTREAM.md"))',
                "pkg/mid/b_test.go": 'const root = "../.."',
                "pkg/leaf/c_test.go": "func TestPlain(t *testing.T) {}",
            },
            { "pkg/other": ["UPSTREAM.md"] }
        );
        expect(readers).toEqual({ "pkg/other": ["UPSTREAM.md"], "pkg/mid": null });
        const picked = selectGoReaders(["UPSTREAM.md"], readers);
        expect(picked.map((r) => r.dir)).toEqual(["pkg/mid", "pkg/other"]);
        // A reader the table does not describe runs on every change.
        expect(selectGoReaders(["README.md"], readers).map((r) => r.dir)).toEqual(["pkg/mid"]);
        expect(dirsOf(selectGoPackages(["README.md"], fixtureGraph(), { readers: picked }))).toEqual([
            "pkg/mid",
            "pkg/other",
        ]);
    });

    it("lists only folders that exist in GoReaders", () => {
        for (const dir of Object.keys(GoReaders)) {
            expect(fs.existsSync(path.join(RepoRoot, dir)), dir).toBe(true);
        }
    });

    it("parses go list's stream of objects, braces inside strings included", () => {
        const text =
            '{\n\t"ImportPath": "a",\n\t"Error": {"Err": "unexpected } in {x"}\n}\n{\n\t"ImportPath": "b"\n}\n';
        expect(parseJsonStream(text).map((e) => e.ImportPath)).toEqual(["a", "b"]);
        expect(() => parseJsonStream('{"ImportPath": "a"')).toThrow(/truncated/);
    });
});

describe("shared ground and job decisions", () => {
    const shared = [
        "go.mod",
        "go.sum",
        "package.json",
        "package-lock.json",
        "vitest.config.ts",
        "electron.vite.config.ts",
        "tsconfig.json",
        "Taskfile.yml",
        ".github/workflows/ci.yml",
        "frontend/types/gotypes.d.ts",
        "frontend/app/store/wshclientapi.ts",
        "pkg/wshrpc/wshrpctypes.go",
        "pkg/wshrpc/wshclient/wshclient.go",
        "scripts/moltenterm-affected.mjs",
        ...VitestSetupFiles,
    ];
    it.each(shared)("runs everything when %s changes", (file) => {
        const plan = planChanges(["frontend/app/view/term/term.tsx", file]);
        expect(plan.full ?? "(a selection)", `${file} must run everything`).toContain(file);
        expect(Object.values(plan.jobs).every((job) => job.run)).toBe(true);
    });

    it("traces the RPC handlers like any other code", () => {
        expect(planChanges(["pkg/wshrpc/wshserver/wshserver.go"]).full).toBeNull();
    });

    it("runs everything with no change, or with too many", () => {
        expect(planChanges([]).full).toMatch(/no change/);
        const many = Array.from({ length: MaxChangedFiles + 1 }, (_, i) => `frontend/f${i}.ts`);
        expect(planChanges(many).full).toMatch(/more than/);
        expect(planChanges(many.slice(1)).full).toBeNull();
    });

    it("keeps the selection when a locale only gains keys, and runs everything when a text changes", () => {
        const en = "frontend/moltenterm-shell/i18n/locales/en.json";
        expect(planChanges([en], { localeKinds: { [en]: "added" } })).toMatchObject({ full: null, localesAdded: [en] });
        expect(planChanges([en], { localeKinds: { [en]: "changed" } }).full).toMatch(/existing text/);
        expect(planChanges([en]).full).toMatch(/existing text/);
    });

    it("decides the CI jobs from the paths", () => {
        const jobs = (files) => Object.fromEntries(Object.entries(planChanges(files).jobs).map(([k, v]) => [k, v.run]));
        expect(jobs(["frontend/app/view/term/term.tsx"])).toEqual({
            backend: false,
            gobuild: false,
            perf: true,
            deps: false,
        });
        expect(jobs(["frontend/app/view/term/term.test.tsx"])).toEqual({
            backend: false,
            gobuild: false,
            perf: false,
            deps: false,
        });
        expect(jobs(["pkg/molten/x_test.go"])).toEqual({ backend: true, gobuild: false, perf: false, deps: false });
        expect(jobs(["pkg/molten/x.go"])).toEqual({ backend: true, gobuild: true, perf: false, deps: false });
        expect(jobs(["cmd/server/main-server.go"])).toEqual({ backend: true, gobuild: true, perf: true, deps: false });
        expect(jobs(["security/dependencies.json"])).toEqual({
            backend: false,
            gobuild: false,
            perf: false,
            deps: true,
        });
        expect(jobs(["tsunami/go.mod"]).deps).toBe(true);
        expect(jobs(["README.md"])).toEqual({ backend: false, gobuild: false, perf: false, deps: false });
        const withReader = planChanges(["UPSTREAM.md"], { goReaders: { "cmd/wsh/cmd": ["UPSTREAM.md"] } });
        expect(withReader.jobs.backend).toMatchObject({ run: true });
        expect(withReader.jobs.gobuild.run).toBe(false);
    });

    it("names every vitest setup file of the configuration as shared ground", () => {
        const config = fs.readFileSync(path.join(RepoRoot, "vitest.config.ts"), "utf8");
        const listed = config.match(/setupFiles:\s*\[([^\]]*)\]/)?.[1] ?? "";
        const files = [...listed.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
        expect(files.length).toBeGreaterThan(0);
        expect(VitestSetupFiles).toEqual(expect.arrayContaining(files));
    });
});

describe("locale changes", () => {
    it("tells added keys from changed or removed texts", () => {
        const base = JSON.stringify({ a: { b: "one", c: "two" } });
        expect(localeChange(base, JSON.stringify({ a: { b: "one", c: "two", d: "new" }, e: "new" }))).toBe("added");
        expect(localeChange(base, JSON.stringify({ a: { b: "one", c: "TWO" } }))).toBe("changed");
        expect(localeChange(base, JSON.stringify({ a: { b: "one" } }))).toBe("changed");
        expect(localeChange(base, "{ not json")).toBe("changed");
        expect(localeChange(base, null)).toBe("changed");
        expect(localeChange(null, base)).toBe("added");
    });
});

describe("frontend selection inputs", () => {
    it("finds the importers of a file imported with a query", () => {
        const sources = {
            "frontend/molten/molten-builtins.ts": 'import main from "./builtin/copy-box/main.js?raw";',
            "frontend/molten/other.ts": 'import { x } from "./builtin/copy-box/main";',
        };
        expect(queryImporters(["frontend/molten/builtin/copy-box/main.js"], sources)).toEqual([
            "frontend/molten/molten-builtins.ts",
        ]);
        expect(queryImporters([], sources)).toEqual([]);
    });

    it("runs the tests that read files, and the dictionary tests when a locale gains keys", () => {
        const sources = {
            "frontend/a.test.ts": 'import fs from "node:fs";',
            "frontend/b.test.ts": 'import { execFileSync } from "child_process";',
            "frontend/c.test.ts": 'import en from "./i18n/locales/en.json";',
            "frontend/moltenterm-shell/i18n/d.test.ts": 'import { t } from "./i18n";',
            "frontend/e.test.ts": 'import { thing } from "./thing";',
        };
        expect(extraVitestFiles(sources, { localesAdded: [] })).toEqual({
            readers: ["frontend/a.test.ts", "frontend/b.test.ts"],
            locales: [],
        });
        expect(extraVitestFiles(sources, { localesAdded: ["x"] }).locales).toEqual([
            "frontend/c.test.ts",
            "frontend/moltenterm-shell/i18n/d.test.ts",
        ]);
    });
});

describe("arguments", () => {
    it("parses the modes and refuses what it cannot do", () => {
        expect(parseArgs(["--run", "--only", "go", "--base", "HEAD^1", "--", "-count=1"])).toMatchObject({
            mode: "run",
            only: "go",
            base: "HEAD^1",
            extra: ["-count=1"],
        });
        expect(parseArgs(["--plan", "--full", "--full-reason", "push to develop"])).toMatchObject({
            mode: "plan",
            full: true,
            fullReason: "push to develop",
        });
        expect(() => parseArgs(["--only", "rust"])).toThrow(/go or vitest/);
        expect(() => parseArgs(["--run", "--", "-v"])).toThrow(/need --only/);
        expect(() => parseArgs(["--base"])).toThrow(/needs a value/);
        expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
    });
});

describe("the change, from git", () => {
    let dir;
    afterEach(() => {
        if (dir != null) {
            fs.rmSync(dir, { recursive: true, force: true });
            dir = null;
        }
    });
    const git = (...args) => {
        const env = {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@example.invalid",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@example.invalid",
        };
        const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
    };
    const write = (file, text) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
    };
    function repo() {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mt-affected-")));
        git("init", "--quiet", "-b", "develop");
        write("frontend/a.ts", "a\n");
        write("frontend/moltenterm-shell/i18n/locales/en.json", '{"a": "one"}\n');
        write("old.txt", "old\n");
        git("add", ".");
        git("commit", "--quiet", "-m", "base");
        git("checkout", "--quiet", "-b", "feature/1-x");
    }

    it(
        "lists commits, staged, unstaged and untracked files, and both sides of a rename",
        () => {
            repo();
            git("mv", "old.txt", "new.txt");
            git("commit", "--quiet", "-m", "rename");
            write("frontend/staged.ts", "s\n");
            git("add", "frontend/staged.ts");
            write("frontend/a.ts", "edited\n");
            write("frontend/untracked.ts", "u\n");
            const changes = changedFiles(dir, "develop");
            expect(changes.files).toEqual([
                "frontend/a.ts",
                "frontend/staged.ts",
                "frontend/untracked.ts",
                "new.txt",
                "old.txt",
            ]);
            expect(changedFiles(dir, "develop", "HEAD").files).toEqual(["new.txt", "old.txt"]);
        },
        GitTimeout.timeout
    );

    it(
        "plans from the change, reads a locale's base text, and runs everything when the base cannot be read",
        async () => {
            repo();
            write("frontend/moltenterm-shell/i18n/locales/en.json", '{"a": "one", "b": "two"}\n');
            const added = await select({ root: dir, base: "develop", mode: "plan" });
            expect(added.plan).toMatchObject({
                full: null,
                localesAdded: ["frontend/moltenterm-shell/i18n/locales/en.json"],
            });
            write("frontend/moltenterm-shell/i18n/locales/en.json", '{"a": "ONE"}\n');
            expect((await select({ root: dir, base: "develop", mode: "plan" })).plan.full).toMatch(/existing text/);
            const missing = await select({ root: dir, base: "origin/nowhere", mode: "plan" });
            expect(missing.plan.full).toMatch(/cannot be read/);
            expect(Object.values(missing.plan.jobs).every((job) => job.run)).toBe(true);
            git("checkout", "--quiet", "--", ".");
            expect((await select({ root: dir, base: "develop", mode: "plan" })).plan.full).toMatch(/no change/);
        },
        GitTimeout.timeout
    );
});
