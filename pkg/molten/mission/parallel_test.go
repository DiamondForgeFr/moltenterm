// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Tests that only run as a program the others start, not as tests of their own.
var testsNeverRunApart = []string{"TestMoltenReleaseHelper"}

// This package's tests take minutes when they run one after the other, and every Go change waits for them (#2019): a
// new test that forgets t.Parallel() brings that back one test at a time. Each one says which it is.
func TestEveryTestRunsInParallelOrSaysWhy(t *testing.T) {
	t.Parallel()
	files, err := filepath.Glob("*_test.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no test files: %v", err)
	}
	fset := token.NewFileSet()
	var undecided []string
	for _, file := range files {
		parsed, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range parsed.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv != nil || fn.Body == nil || !isTestFunc(fn) || slices.Contains(testsNeverRunApart, fn.Name.Name) {
				continue
			}
			if !choosesParallelism(fn) {
				undecided = append(undecided, file+": "+fn.Name.Name)
			}
		}
	}
	if len(undecided) > 0 {
		t.Fatalf("call t.Parallel() first in each of these tests, or serialTest(t) when it changes state the others read (see main_test.go):\n%s", strings.Join(undecided, "\n"))
	}
}

func isTestFunc(fn *ast.FuncDecl) bool {
	if !strings.HasPrefix(fn.Name.Name, "Test") || fn.Name.Name == "TestMain" || len(fn.Type.Params.List) != 1 {
		return false
	}
	star, ok := fn.Type.Params.List[0].Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	sel, ok := star.X.(*ast.SelectorExpr)
	return ok && sel.Sel.Name == "T"
}

// choosesParallelism tells whether the test calls t.Parallel, serialTest or t.Setenv (which Go refuses in a parallel
// test, so it makes the test serial just as well).
func choosesParallelism(fn *ast.FuncDecl) bool {
	found := false
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return !found
		}
		switch callee := call.Fun.(type) {
		case *ast.SelectorExpr:
			found = found || callee.Sel.Name == "Parallel" || callee.Sel.Name == "Setenv"
		case *ast.Ident:
			found = found || callee.Name == "serialTest"
		}
		return !found
	})
	return found
}
