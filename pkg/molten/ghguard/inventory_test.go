// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package ghguard

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Packages that name gh as a program and install no guard, and why.
var unguarded = map[string]string{
	"pkg/molten/ghguard": "tests the guard itself, which installs and removes its own",
}

type inventoryPkg struct {
	calls     bool
	testFiles int
	guarded   bool
}

// readInventory reads every package of pkg/ and cmd/: whether its sources name gh as a program, whether it has tests
// and whether a test file installs the guard.
func readInventory(t *testing.T) map[string]*inventoryPkg {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("the repository root is not %s: %v", root, err)
	}
	pkgs := map[string]*inventoryPkg{}
	for _, top := range []string{"pkg", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, top), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			name := entry.Name()
			if entry.IsDir() {
				if name == "testdata" || name == "node_modules" || strings.HasPrefix(name, ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(name, ".go") {
				return nil
			}
			dir, _ := filepath.Rel(root, filepath.Dir(path))
			dir = filepath.ToSlash(dir)
			pkg := pkgs[dir]
			if pkg == nil {
				pkg = &inventoryPkg{}
				pkgs[dir] = pkg
			}
			source, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			text := string(source)
			if !strings.HasSuffix(name, "_test.go") {
				pkg.calls = pkg.calls || strings.Contains(text, `"gh"`)
				return nil
			}
			pkg.testFiles++
			pkg.guarded = pkg.guarded || strings.Contains(text, "ghguard.Main(") || strings.Contains(text, "ghguard.Wrap(")
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return pkgs
}

// The inventory of #1857: a package whose own code names gh as a program installs the guard in its TestMain, so a
// test that reaches the real gh fails the run. A package that only imports one of them runs gh through the callers
// above, in tests that already hand them a fake runner.
func TestEveryTestPackageThatNamesGhInstallsTheGuard(t *testing.T) {
	pkgs := readInventory(t)
	missing := []string{}
	checked := 0
	for dir, pkg := range pkgs {
		if !pkg.calls || pkg.testFiles == 0 {
			continue
		}
		if _, skip := unguarded[dir]; skip {
			continue
		}
		checked++
		if !pkg.guarded {
			missing = append(missing, dir)
		}
	}
	sort.Strings(missing)
	if checked == 0 {
		t.Fatal("the inventory found no package that names gh: it reads nothing")
	}
	if len(missing) > 0 {
		t.Fatalf("these packages name gh as a program and install no guard (call ghguard.Main(m) from a TestMain):\n  %s", strings.Join(missing, "\n  "))
	}
}
