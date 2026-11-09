// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MitText, tempRoot, write } from "./fixtures.mjs";
import { Binaries, modulesOf, parseListLine, pinnedToolchain } from "./golang.mjs";

const Root = path.join(import.meta.dirname, "..", "..");
const taskfile = fs.readFileSync(path.join(Root, "Taskfile.yml"), "utf8");
const roots = [];
// A test that starts go only bounds a failing run: a loaded machine takes a while to start it.
const GenerousMs = 120000;
const hasGo = spawnSync("go", ["version"]).status === 0;

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The (GOOS, GOARCH) pairs a Taskfile task is called with.
function platformsOf(task) {
  const start = taskfile.indexOf(`    build:wsh:parallel:`);
  const block = taskfile.slice(start, taskfile.indexOf("        internal: true", start));
  const pairs = [];
  for (const match of block.matchAll(/task: build:(\w+):internal\s+vars:\s+GOOS: (\w+)\s+GOARCH: (\w+)/g)) {
    if (match[1] === task) {
      pairs.push(`${match[2]}/${match[3]}`);
    }
  }
  return pairs.sort();
}

describe("Binaries", () => {
  it("builds wsh and molten for the platforms of the Taskfile", () => {
    const byName = Object.fromEntries(Binaries.map((binary) => [binary.name, binary]));
    expect([...byName.wsh.platforms].sort()).toEqual(platformsOf("wsh"));
    expect([...byName.molten.platforms].sort()).toEqual(platformsOf("molten"));
  });

  it("builds wavesrv with the tags and the platforms of build:server:internal", () => {
    const wavesrv = Binaries.find((binary) => binary.name === "wavesrv");
    expect(taskfile).toContain(`-tags "${wavesrv.tags}`);
    expect(taskfile).toContain("CGO_ENABLED=1 GOARCH=");
    expect(taskfile).toContain("cmd/server/main-server.go");
    expect(taskfile).toMatch(/task: build:server:linux[^]*task: build:server:macos/);
    expect([...wavesrv.platforms].sort()).toEqual(["darwin/amd64", "darwin/arm64", "linux/amd64", "linux/arm64"]);
  });

  it("names the packages the Taskfile builds", () => {
    expect(taskfile).toContain("./cmd/molten");
    expect(taskfile).toContain("cmd/wsh/main-wsh.go");
    expect(Binaries.map((binary) => binary.pkg)).toEqual(["./cmd/server", "./cmd/wsh", "./cmd/molten"]);
  });
});

describe("parseListLine", () => {
  it("reads a module from the cache", () => {
    expect(parseListLine("github.com/google/uuid\tv1.6.0\t/mod/uuid@v1.6.0\t\t")).toEqual({
      path: "github.com/google/uuid",
      version: "v1.6.0",
      dir: "/mod/uuid@v1.6.0",
      main: false,
      replaced: null,
    });
  });

  it("reads the module a fork replaces as the fork", () => {
    const module = parseListLine(
      "github.com/creack/pty\tv1.1.24\t/mod/photostorm/pty@v1.1.19\t\tgithub.com/photostorm/pty\tv1.1.19\t/mod/photostorm/pty@v1.1.19"
    );
    expect(module).toMatchObject({
      path: "github.com/photostorm/pty",
      version: "v1.1.19",
      replaced: "github.com/creack/pty",
    });
  });

  it("keeps the name of a module a folder replaces", () => {
    const module = parseListLine("github.com/x/tsunami\tv0.1.0\t/repo/tsunami\t\t./tsunami\t\t/repo/tsunami");
    expect(module).toMatchObject({ path: "github.com/x/tsunami", version: "v0.1.0", dir: "/repo/tsunami" });
  });

  it("marks the main module and skips the standard library's empty lines", () => {
    expect(parseListLine("example.com/app\t\t/repo\tmain\t")).toMatchObject({ main: true });
    expect(parseListLine("")).toBeNull();
  });
});

describe("pinnedToolchain", () => {
  it("is the version go.mod pins", () => {
    expect(pinnedToolchain(Root)).toMatch(/^go1\.\d+\.\d+$/);
  });
});

describe.skipIf(!hasGo)("modulesOf", () => {
  // A program that imports a module kept outside its repository, one kept inside it, and the standard library.
  function program() {
    const root = tempRoot();
    roots.push(root);
    const app = path.join(root, "app");
    write(
      app,
      "go.mod",
      "module example.com/app\n\ngo 1.21\n\nrequire (\n\texample.com/outside v0.0.0\n\texample.com/inside v0.0.0\n)\n\nreplace example.com/outside => ../outside\n\nreplace example.com/inside => ./inside\n"
    );
    write(
      app,
      "main.go",
      'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/inside"\n\t"example.com/outside"\n)\n\nfunc main() { fmt.Println(outside.Name, inside.Name) }\n'
    );
    write(app, "inside/go.mod", "module example.com/inside\n\ngo 1.21\n");
    write(app, "inside/inside.go", 'package inside\n\nconst Name = "inside"\n');
    write(root, "outside/go.mod", "module example.com/outside\n\ngo 1.21\n");
    write(root, "outside/outside.go", 'package outside\n\nconst Name = "outside"\n');
    write(root, "outside/LICENSE", MitText);
    return app;
  }

  it(
    "lists the modules a program links, the repository's own ones excepted",
    () => {
      const app = program();
      const binary = { name: "app", pkg: ".", cgo: "0", tags: "" };
      const modules = modulesOf(app, binary, "linux/amd64");
      expect([...modules.keys()]).toEqual(["example.com/outside@v0.0.0"]);
      expect(fs.realpathSync(modules.get("example.com/outside@v0.0.0").dir)).toBe(
        fs.realpathSync(path.join(path.dirname(app), "outside"))
      );
    },
    GenerousMs
  );
});
