// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthook

import (
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

// Every hook run starts what the molten program links: this package, cmd/molten and the line reader this package uses
// (pkg/molten/jobline, #2583) import the standard library only (FR-PERF-012, DS-PERF-011), and none compiles a regular
// expression at start.
func TestImportsTheStandardLibraryOnly(t *testing.T) {
	for _, dir := range []string{".", "../../../cmd/molten", "../jobline"} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			if !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			f, err := parser.ParseFile(token.NewFileSet(), dir+"/"+e.Name(), nil, parser.ImportsOnly)
			if err != nil {
				t.Fatal(err)
			}
			for _, imp := range f.Imports {
				path, _ := strconv.Unquote(imp.Path.Value)
				if path == "github.com/wavetermdev/waveterm/pkg/molten/agenthook" || path == "github.com/wavetermdev/waveterm/pkg/molten/jobline" {
					continue
				}
				if first := strings.Split(path, "/")[0]; strings.Contains(first, ".") {
					t.Errorf("%s/%s imports %s", dir, e.Name(), path)
				}
				if dir == "../jobline" && path == "regexp" {
					t.Errorf("%s/%s imports regexp: it would compile at every hook run", dir, e.Name())
				}
			}
		}
	}
}
