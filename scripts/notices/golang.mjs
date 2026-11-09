// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Go modules that ship (#2126): the ones compiled into wavesrv, wsh and molten, for every platform they are built
// for, taken from `go list -deps` (the packages the compiler really links, not the modules go.mod lists) and read from the
// module cache, so it needs no network once the modules are downloaded (`go mod download`, which any Go build does).

/* global process */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readLicenseFiles } from "./files.mjs";

// The binaries and platforms of the Taskfile (build:server:internal, build:wsh:parallel, build:molten:internal);
// scripts/notices/golang.test.mjs fails when they drift apart.
export const Binaries = [
  {
    name: "wavesrv",
    pkg: "./cmd/server",
    cgo: "1",
    tags: "osusergo,sqlite_omit_load_extension",
    platforms: ["darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64"],
  },
  {
    name: "wsh",
    pkg: "./cmd/wsh",
    cgo: "0",
    tags: "",
    platforms: [
      "darwin/arm64",
      "darwin/amd64",
      "linux/arm64",
      "linux/amd64",
      "linux/mips",
      "linux/mips64",
      "windows/amd64",
      "windows/arm64",
    ],
  },
  {
    name: "molten",
    pkg: "./cmd/molten",
    cgo: "0",
    tags: "",
    platforms: ["darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64"],
  },
];

// The toolchain go.mod pins, as the Taskfile builds with it (scripts/moltenterm-go-toolchain.mjs); null when it pins none.
export function pinnedToolchain(root) {
  const gomod = fs.readFileSync(path.join(root, "go.mod"), "utf8");
  const toolchain = gomod.match(/^toolchain\s+(go\d[\w.]*)\s*$/m);
  if (toolchain != null) {
    return toolchain[1];
  }
  const goline = gomod.match(/^go\s+(\d+\.\d+\.\d+)\s*$/m);
  return goline == null ? null : `go${goline[1]}`;
}

const ListFormat = [
  "{{with .Module}}",
  "{{.Path}}\t{{.Version}}\t{{.Dir}}\t{{if .Main}}main{{end}}",
  "\t{{with .Replace}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}",
  "{{end}}",
].join("");

// One line of `go list`: the module a package belongs to, with the replacement it is built from. A module replaced by
// another module (a fork) is that fork; one replaced by a folder keeps its own name, the folder is its source.
export function parseListLine(line) {
  const [modPath, modVersion, modDir, main, replacePath, replaceVersion, replaceDir] = line.split("\t");
  if (!modPath) {
    return null;
  }
  const fork = Boolean(replacePath) && Boolean(replaceVersion);
  return {
    path: fork ? replacePath : modPath,
    version: fork ? replaceVersion : modVersion,
    dir: replaceDir || modDir,
    main: main === "main",
    replaced: replacePath ? modPath : null,
  };
}

// A module built from a folder of the repository (tsunami, the main module) is the project's own code.
function insideRepository(root, dir) {
  const real = (target) => {
    try {
      return fs.realpathSync(target);
    } catch {
      return target;
    }
  };
  const rel = path.relative(real(root), real(dir));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function goEnv(root, extra) {
  const toolchain = process.env.GOTOOLCHAIN || pinnedToolchain(root);
  return { ...process.env, ...(toolchain ? { GOTOOLCHAIN: toolchain } : {}), GOWORK: "off", ...extra };
}

function run(root, args, env) {
  return execFileSync("go", args, {
    cwd: root,
    env: goEnv(root, env),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// The modules a binary links for one platform: Map<"path@version", module>.
export function modulesOf(root, binary, platform) {
  const [goos, goarch] = platform.split("/");
  const args = ["list", "-deps"];
  if (binary.tags) {
    args.push("-tags", binary.tags);
  }
  args.push("-f", ListFormat, binary.pkg);
  const out = run(root, args, { GOOS: goos, GOARCH: goarch, CGO_ENABLED: binary.cgo });
  const modules = new Map();
  for (const line of out.split("\n")) {
    const module = parseListLine(line);
    if (module == null || module.main || insideRepository(root, module.dir)) {
      continue;
    }
    modules.set(`${module.path}@${module.version}`, module);
  }
  return modules;
}

function goroot(root) {
  return run(root, ["env", "GOROOT"]).trim();
}

function goVersion(root) {
  return run(root, ["env", "GOVERSION"]).trim();
}

// The components, one per module and version, each with the binaries it is linked into; the Go standard library, which
// every one of them carries, comes first in the list of components.
export function collectGo(root) {
  const problems = [];
  const byKey = new Map();
  for (const binary of Binaries) {
    for (const platform of binary.platforms) {
      let modules;
      try {
        modules = modulesOf(root, binary, platform);
      } catch (err) {
        const stderr = String(err.stderr ?? err.message).trim();
        problems.push(
          `go list ${binary.pkg} for ${platform} failed (are the modules downloaded: go mod download?): ${stderr}`
        );
        continue;
      }
      for (const [key, module] of modules) {
        const known = byKey.get(key) ?? { module, binaries: new Set() };
        known.binaries.add(binary.name);
        byKey.set(key, known);
      }
    }
  }
  const components = [...byKey.values()].map(({ module, binaries }) => ({
    ecosystem: "go",
    name: module.path,
    version: module.version,
    declared: null,
    url: `https://${module.path.replace(/\/v\d+$/, "")}`,
    files: readLicenseFiles(module.dir),
    dirs: [module.dir],
    targets: [...binaries].sort(),
  }));
  try {
    const home = goroot(root);
    components.push({
      ecosystem: "go",
      name: "Go standard library",
      version: goVersion(root),
      declared: null,
      url: "https://go.dev",
      files: readLicenseFiles(home),
      dirs: [home],
      targets: Binaries.map((binary) => binary.name).sort(),
    });
  } catch (err) {
    problems.push(`go env failed: ${String(err.stderr ?? err.message).trim()}`);
  }
  return { components, problems };
}
