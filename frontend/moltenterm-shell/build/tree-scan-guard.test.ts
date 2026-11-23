// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// No test scans a tree inside its body (AGENTS.md "Load-proof tests", #2274, #2496). Collection has no timeout, a test has
// 5 s, and a loaded machine stretches a whole-tree scan ten times: the scan runs while the file is collected (module level
// or a describe body) and the test only asserts on the result. This guard reads every test file of the repository and
// fails when the body of an it, a test or a hook (beforeAll, beforeEach, afterAll, afterEach) walks a tree:
//   - a directory listing asked to recurse (readdirSync(dir, { recursive: true })), or a glob;
//   - a call to a walker the file defines (a function that lists a directory and calls itself, or that calls such a
//     walker), directly or through a helper;
//   - a call to a walker helper imported from another module (ImportedWalkers).
// A listing of one folder, with no recursion, is not a tree: it is left to the author.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const Root = resolve(__dirname, "../../..");
const TestDirs = ["frontend", "emain", "scripts"];
const TestFile = /\.(test|spec)\.[cm]?[jt]sx?$/;

const TestCalls = new Set(["it", "test", "beforeAll", "beforeEach", "afterAll", "afterEach"]);
const Listers = new Set(["readdirSync", "readdir", "opendirSync", "opendir"]);
const Globbers = new Set(["glob", "globSync", "fastGlob"]);
// Walkers a file may import: a file that defines one of these names itself is judged by its own definition instead.
const ImportedWalkers = new Set(["sourceFiles", "walkFiles", "walkDir", "listFiles", "collectFiles"]);

// A file that names none of these cannot hold a walker: it is not parsed.
const MayScan = /readdir|opendir|glob|sourceFiles|walkFiles|walkDir|listFiles|collectFiles/i;

type Finding = { line: number; what: string };

function calleeName(call: ts.CallExpression): string | undefined {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
        return callee.text;
    }
    return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

// `it`, for it("x", fn), it.skip("x", fn) and it.each(table)("x", fn).
function rootName(expr: ts.Expression): string | undefined {
    let node = expr;
    while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isParenthesizedExpression(node)) {
        node = node.expression;
    }
    return ts.isIdentifier(node) ? node.text : undefined;
}

function callsIn(node: ts.Node): ts.CallExpression[] {
    const found: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
            found.push(n);
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
}

function isRecursiveOption(arg: ts.Expression): boolean {
    if (!ts.isObjectLiteralExpression(arg)) {
        return false;
    }
    return arg.properties.some((prop) => {
        if (ts.isShorthandPropertyAssignment(prop)) {
            return prop.name.text === "recursive";
        }
        return (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === "recursive" &&
            prop.initializer.kind !== ts.SyntaxKind.FalseKeyword
        );
    });
}

function directScan(call: ts.CallExpression): string | undefined {
    const name = calleeName(call);
    if (name == null) {
        return undefined;
    }
    if (Globbers.has(name)) {
        return `${name}() over a tree`;
    }
    if (Listers.has(name) && call.arguments.some(isRecursiveOption)) {
        return `${name}() with recursive`;
    }
    return undefined;
}

function callsByName(calls: ts.CallExpression[]): Set<string> {
    const names = new Set<string>();
    for (const call of calls) {
        if (ts.isIdentifier(call.expression)) {
            names.add(call.expression.text);
        }
    }
    return names;
}

// The functions a file defines by a name: declarations, and arrow or function expressions bound to a variable.
function functionDefs(source: ts.SourceFile): Map<string, ts.Node[]> {
    const defs = new Map<string, ts.Node[]>();
    const add = (name: string, node: ts.Node) => defs.set(name, [...(defs.get(name) ?? []), node]);
    const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name != null) {
            add(node.name.text, node);
        }
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer != null &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ) {
            add(node.name.text, node.initializer);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return defs;
}

// The names of the functions of the file that walk a tree: they recurse over a directory listing, or call one that does.
function walkerNames(defs: Map<string, ts.Node[]>): Set<string> {
    const walkers = new Set<string>();
    const walks = (name: string, node: ts.Node): boolean => {
        const calls = callsIn(node);
        if (calls.some((call) => directScan(call) != null)) {
            return true;
        }
        const called = callsByName(calls);
        if (called.has(name) && calls.some((call) => Listers.has(calleeName(call)))) {
            return true;
        }
        return [...called].some((other) => walkers.has(other));
    };
    for (let grew = true; grew; ) {
        grew = false;
        for (const [name, nodes] of defs) {
            if (!walkers.has(name) && nodes.some((node) => walks(name, node))) {
                walkers.add(name);
                grew = true;
            }
        }
    }
    return walkers;
}

// The local names under which the file imports vitest's it, test and hooks.
function vitestNames(source: ts.SourceFile): Set<string> {
    const names = new Set<string>();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (statement.moduleSpecifier.text !== "vitest" || bindings == null || !ts.isNamedImports(bindings)) {
            continue;
        }
        for (const element of bindings.elements) {
            if (TestCalls.has((element.propertyName ?? element.name).text)) {
                names.add(element.name.text);
            }
        }
    }
    return names;
}

// The bodies the runner times: the function arguments of it, test and the hooks, or the local function they name.
function timedBodies(source: ts.SourceFile, defs: Map<string, ts.Node[]>, names: Set<string>): ts.Node[] {
    const bodies = new Set<ts.Node>();
    for (const call of callsIn(source)) {
        const root = rootName(call.expression);
        if (root == null || !names.has(root)) {
            continue;
        }
        for (const arg of call.arguments) {
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
                bodies.add(arg);
            }
            if (ts.isIdentifier(arg)) {
                (defs.get(arg.text) ?? []).forEach((node) => bodies.add(node));
            }
        }
    }
    return [...bodies];
}

// A walker's own recursive call is the walker, not one more scan.
function isInside(node: ts.Node, owners: ts.Node[] = []): boolean {
    for (let parent = node.parent; parent != null; parent = parent.parent) {
        if (owners.includes(parent)) {
            return true;
        }
    }
    return false;
}

function findTreeScans(fileName: string, text: string): Finding[] {
    if (!MayScan.test(text)) {
        return [];
    }
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    const names = vitestNames(source);
    if (names.size === 0) {
        return [];
    }
    const defs = functionDefs(source);
    const walkers = walkerNames(defs);
    const findings: Finding[] = [];
    for (const body of timedBodies(source, defs, names)) {
        for (const call of callsIn(body)) {
            const name = calleeName(call);
            if (isInside(call, defs.get(name))) {
                continue;
            }
            const what =
                directScan(call) ??
                (ts.isIdentifier(call.expression) && walkers.has(name) ? `${name}() walks a tree` : undefined) ??
                (ts.isIdentifier(call.expression) && ImportedWalkers.has(name) && !defs.has(name)
                    ? `${name}() walks a tree`
                    : undefined);
            if (what != null) {
                findings.push({ line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1, what });
            }
        }
    }
    return findings;
}

function testFiles(): string[] {
    const found: string[] = [];
    for (const dir of TestDirs) {
        for (const rel of readdirSync(join(Root, dir), { recursive: true }) as string[]) {
            const parts = rel.split(sep);
            if (TestFile.test(rel) && !parts.includes("node_modules")) {
                found.push(`${dir}/${parts.join("/")}`);
            }
        }
    }
    return found.sort();
}

const Prelude = 'import { beforeAll, describe, expect, it, test } from "vitest";\n';

function scansOf(code: string): string[] {
    return findTreeScans("sample.test.ts", Prelude + code).map((f) => f.what);
}

describe("no test body scans a tree (#2496)", () => {
    // Every test file is read here, while the file is collected: collection has no timeout (#2274). The tests below only
    // read the result.
    const files = testFiles();
    const scans = files.flatMap((file) =>
        findTreeScans(file, readFileSync(join(Root, file), "utf8")).map((f) => `${file}:${f.line}: ${f.what}`)
    );

    it("reads the test files of the frontend, Electron main and the scripts, this one included", () => {
        expect(files.length).toBeGreaterThan(500);
        expect(files).toContain("frontend/moltenterm-shell/build/tree-scan-guard.test.ts");
        expect(files.some((file) => file.startsWith("emain/"))).toBe(true);
        expect(files.some((file) => file.startsWith("scripts/"))).toBe(true);
    });

    it("leaves every whole-tree scan to collection time, outside it, test and the hooks", () => {
        expect(
            scans,
            "scan while the file is collected (module level or a describe body) and assert on the result in the test"
        ).toEqual([]);
    });
});

describe("the guard sees a tree scan in a test body", () => {
    it("sees a recursive listing, in a test, a test.each row and a hook", () => {
        const scan = "readdirSync(root, { recursive: true })";
        expect(scansOf(`it("a", () => { for (const f of ${scan}) {} });`)).toEqual(["readdirSync() with recursive"]);
        expect(scansOf(`test.each([1])("a", () => { ${scan}; });`)).toEqual(["readdirSync() with recursive"]);
        expect(scansOf(`beforeAll(() => { ${scan}; });`)).toEqual(["readdirSync() with recursive"]);
        expect(scansOf(`it.skip("a", () => { fs.readdirSync(root, { withFileTypes: true, recursive: true }); });`)).toEqual(
            ["readdirSync() with recursive"]
        );
    });

    it("sees a glob", () => {
        expect(scansOf('it("a", () => { globSync("**/*.ts"); });')).toEqual(["globSync() over a tree"]);
    });

    it("sees a walker the file defines, called directly, through a helper or by name", () => {
        const walker = "function sourceFiles(dir) { for (const n of readdirSync(dir)) { sourceFiles(n); } }\n";
        expect(scansOf(`${walker}it("a", () => { sourceFiles("x"); });`)).toEqual(["sourceFiles() walks a tree"]);
        expect(scansOf(`${walker}const all = () => sourceFiles("x");\nit("a", () => { all(); });`)).toEqual([
            "all() walks a tree",
        ]);
        expect(scansOf(`${walker}function check() { sourceFiles("x"); }\nit("a", check);`)).toEqual([
            "sourceFiles() walks a tree",
        ]);
    });

    it("sees a walker defined inside the test", () => {
        expect(
            scansOf(
                'it("a", () => { const walk = (dir) => { for (const n of readdirSync(dir)) { walk(n); } }; walk("x"); });'
            )
        ).toEqual(["walk() walks a tree"]);
    });

    it("sees a walker helper imported from another module", () => {
        expect(scansOf('import { sourceFiles } from "./files";\nit("a", () => { sourceFiles("x"); });')).toEqual([
            "sourceFiles() walks a tree",
        ]);
    });
});

describe("the guard leaves a scan made while the file is collected", () => {
    it("leaves a scan at module level and in a describe body", () => {
        const walker = "function sourceFiles(dir) { for (const n of readdirSync(dir)) { sourceFiles(n); } }\n";
        expect(scansOf(`${walker}const all = sourceFiles("x");\nit("a", () => { expect(all).toEqual([]); });`)).toEqual([]);
        expect(
            scansOf(
                `describe("d", () => { const files = readdirSync(root, { recursive: true });\nit("a", () => { expect(files).toEqual([]); }); });`
            )
        ).toEqual([]);
    });

    it("leaves a listing of one folder, a walk over a layout and a file that is not a vitest test", () => {
        expect(scansOf('it("a", () => { expect(readdirSync(dir)).toEqual(["a"]); });')).toEqual([]);
        expect(
            scansOf('it("a", () => { const walk = (node) => node.children?.forEach(walk); walk(root); readdirSync(dir); });')
        ).toEqual([]);
        expect(scansOf('it("a", () => { readdirSync(root, { recursive: false }); });')).toEqual([]);
        expect(
            findTreeScans("plain.test.ts", 'it("a", () => { readdirSync(root, { recursive: true }); });')
        ).toEqual([]);
    });
});
