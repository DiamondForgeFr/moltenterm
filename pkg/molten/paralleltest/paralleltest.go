// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package paralleltest is what the slow Go test packages share to run their tests in parallel (#2022, after
// pkg/molten/mission's #2019): the git environment a test process sets once, the serial marker and the test that
// fails a test with neither t.Parallel() nor a marker.
package paralleltest

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// NoGitMaintenanceConfig turns off git's automatic housekeeping in every git the tests start (#794). After a commit,
// fetch or push, git spawns `git maintenance run --auto --detach`: a daemon that outlives the command and the test,
// with no handle to wait on, and that writes into a fixture while t.TempDir empties it ("directory not empty").
//
// It is a global config file, not GIT_CONFIG_COUNT: git drops the config variables of the environment when it starts
// receive-pack or upload-pack for a local remote, and the push's receive-pack in a bare origin starts the same daemon.
const NoGitMaintenanceConfig = "[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n[receive]\n\tautogc = false\n"

const serialEnv = "MOLTEN_SERIAL_TEST"

// The three answers about a test: it chose nothing, it chose, it marked itself serial without saying why.
const (
	undecided           = 0
	chosen              = 1
	chosenWithoutReason = 2
)

// RunWithGit runs the tests with the git environment of a fixture set once for the whole process: no global or system
// git configuration (signing, hooks, aliases) changes what a test's git does, housekeeping is off, and the author and
// the committer are who. A fixture then sets nothing itself: t.Setenv would keep every test that uses it from running in
// parallel.
func RunWithGit(who string, email string, run func() int) int {
	dir, err := os.MkdirTemp("", "paralleltest-gitconfig")
	if err != nil {
		fmt.Printf("making the test git config: %v\n", err)
		return 1
	}
	defer os.RemoveAll(dir)
	config := filepath.Join(dir, "gitconfig")
	if err := os.WriteFile(config, []byte(NoGitMaintenanceConfig), 0644); err != nil {
		fmt.Printf("writing the test git config: %v\n", err)
		return 1
	}
	for name, value := range map[string]string{
		"GIT_CONFIG_GLOBAL":   config,
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_AUTHOR_NAME":     who,
		"GIT_AUTHOR_EMAIL":    email,
		"GIT_COMMITTER_NAME":  who,
		"GIT_COMMITTER_EMAIL": email,
	} {
		os.Setenv(name, value)
	}
	return run()
}

// Serial marks a test that must not run in parallel, and says why: it changes state the other tests read (the
// environment, a package-level variable) or reads state that they disturb. It sets an environment variable only so that
// Go refuses a t.Parallel() on the same test, in either order. Go runs the parallel tests together once every serial
// one is over, so a serial test may change that state without disturbing them.
func Serial(t *testing.T, why string) {
	t.Helper()
	if strings.TrimSpace(why) == "" {
		t.Fatal("a serial test says why it cannot run in parallel")
	}
	t.Setenv(serialEnv, "1")
}

// EveryTestChoosesParallelism fails when a test of the package in the current folder neither calls t.Parallel() nor
// serialTest(t, "why") (or t.Setenv, which Go refuses in a parallel test, so it makes the test serial just as well).
// The packages' tests took minutes when they ran one after the other, and every Go change waits for them: a new test
// that forgets t.Parallel() brings that back one test at a time. The test files named in skip are not checked (a file
// that comes from upstream and is not ours to edit), nor are the tests named in neverApart, which only run as a
// program the others start.
func EveryTestChoosesParallelism(t *testing.T, skip []string, neverApart []string) {
	t.Helper()
	missing, err := testsWithoutAChoice(".", skip, neverApart)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) > 0 {
		t.Fatalf("call t.Parallel() first in each of these tests, or serialTest(t, \"why\") when it changes state the others read (see main_test.go):\n%s", strings.Join(missing, "\n"))
	}
}

func testsWithoutAChoice(dir string, skip []string, neverApart []string) ([]string, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*_test.go"))
	if err != nil || len(files) == 0 {
		return nil, fmt.Errorf("no test files in %s: %v", dir, err)
	}
	fset := token.NewFileSet()
	var missing []string
	for _, file := range files {
		name := filepath.Base(file)
		if slices.Contains(skip, name) {
			continue
		}
		parsed, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			return nil, err
		}
		for _, decl := range parsed.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv != nil || fn.Body == nil || !isTestFunc(fn) || slices.Contains(neverApart, fn.Name.Name) {
				continue
			}
			switch choice(fn) {
			case chosen:
			case chosenWithoutReason:
				missing = append(missing, name+": "+fn.Name.Name+" (serialTest needs a reason)")
			default:
				missing = append(missing, name+": "+fn.Name.Name)
			}
		}
	}
	return missing, nil
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

func choice(fn *ast.FuncDecl) int {
	verdict := undecided
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return verdict != chosen
		}
		switch callee := call.Fun.(type) {
		case *ast.SelectorExpr:
			if callee.Sel.Name == "Parallel" || callee.Sel.Name == "Setenv" {
				verdict = chosen
			}
		case *ast.Ident:
			if callee.Name == "serialTest" && verdict != chosen {
				verdict = chosenWithoutReason
				if saysWhy(call) {
					verdict = chosen
				}
			}
		}
		return verdict != chosen
	})
	return verdict
}

func saysWhy(call *ast.CallExpr) bool {
	if len(call.Args) != 2 {
		return false
	}
	lit, ok := call.Args[1].(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return false
	}
	text, err := strconv.Unquote(lit.Value)
	return err == nil && strings.TrimSpace(text) != ""
}
