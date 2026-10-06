#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Go toolchain every Moltenterm binary is built with (#258): the `toolchain` line of go.mod when there is one, else
// its `go` line (`go mod tidy` drops a `toolchain` line equal to the `go` line, so it only exists to pin a newer one).
// CI reads the same version through `go-version-file: go.mod`.
//
// Those lines are only a minimum for Go: with GOTOOLCHAIN=auto a newer local Go (Homebrew's) is used as is. So the
// Taskfile exports GOTOOLCHAIN=<pinned version> (from this script), which makes `go` fetch and run exactly that one.
//
// Usage:
//   node scripts/moltenterm-go-toolchain.mjs           print the pinned version (e.g. go1.25.6)
//   node scripts/moltenterm-go-toolchain.mjs --check   print the version `go` runs here and exit 1 when it differs

/* global console, process */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const Root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPinned() {
    const gomod = fs.readFileSync(path.join(Root, "go.mod"), "utf8");
    const toolchain = gomod.match(/^toolchain\s+(go\d[\w.]*)\s*$/m);
    if (toolchain != null) {
        return toolchain[1];
    }
    const goline = gomod.match(/^go\s+(\d+\.\d+\.\d+)\s*$/m);
    if (goline == null) {
        console.error("go.mod has no `toolchain` line and no `go x.y.z` line: the Go toolchain is not pinned");
        process.exit(2);
    }
    return `go${goline[1]}`;
}

const pinned = readPinned();
if (!process.argv.includes("--check")) {
    console.log(pinned);
    process.exit(0);
}

let actual;
try {
    actual = execFileSync("go", ["env", "GOVERSION"], {
        cwd: Root,
        encoding: "utf8",
        env: { ...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN || pinned },
    }).trim();
} catch (err) {
    console.error(`cannot run go: ${err.message}`);
    process.exit(2);
}
if (actual !== pinned) {
    console.error(`go builds with ${actual} (GOTOOLCHAIN=${process.env.GOTOOLCHAIN || "unset"}), go.mod pins ${pinned}.`);
    console.error("Unset GOTOOLCHAIN (or set it to the pinned version) so that go switches to the pinned toolchain.");
    process.exit(1);
}
console.log(`go toolchain: ${actual} (pinned by go.mod)`);
