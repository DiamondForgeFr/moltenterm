// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

// Every hook run starts what the molten program links: this package and cmd/molten import the standard library only
// (FR-PERF-012, DS-PERF-011).
func TestImportsTheStandardLibraryOnly(t *testing.T) {
	for _, dir := range []string{".", "../../../cmd/molten"} {
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
				if path == "github.com/wavetermdev/waveterm/pkg/molten/agenthook" {
					continue
				}
				if first := strings.Split(path, "/")[0]; strings.Contains(first, ".") {
					t.Errorf("%s/%s imports %s", dir, e.Name(), path)
				}
			}
		}
	}
}
