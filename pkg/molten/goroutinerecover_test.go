// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// A panic in a goroutine without a recover kills wavesrv, and the app quits
// with it (#2125). Each entry here is a goroutine that deliberately starts
// without one, keyed by "<file>:<enclosing function>", with the reason.
var goroutinesWithoutRecover = map[string]string{
	"localroute/routetest/routetest.go:Ask":     "test helper, never runs in the app",
	"agenthook/relay.go:RunStatusLineCommand":   "runs in wsh, not wavesrv, and only forwards a signal to the child",
	"companion/manager.go:Manager.lease":        "w.loop defers its own recover",
	"browsers/opener.go:ExecRunner":             "only waits for the process (cmd.Wait into a channel)",
	"mission/builds.go:Runs.launchBuild":        "only reaps the process (go cmd.Wait())",
	"mission/runs.go:Runs.launchAt":             "only reaps the process (go cmd.Wait())",
	"mission/depsync.go:Groups.runSyncCommand":  "only waits for the process (cmd.Wait into a channel)",
	"mission/launch.go:Launches.runPrepare":     "only waits for the process (cmd.Wait into a channel)",
	"usage/codexappserver.go:runCodexAppServer": "only waits for the process (cmd.Wait, then close)",
	"review/batch_run.go:BatchRunner.idle":      "only selects on two channels and cancels a context",
}

// TestEveryMoltenGoroutineRecovers fails when a goroutine started in
// pkg/molten neither defers a recover at its top level (directly or through
// a function of its package) nor appears in goroutinesWithoutRecover.
func TestEveryMoltenGoroutineRecovers(t *testing.T) {
	pkgs := map[string]*goPackage{}
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		dir := filepath.Dir(path)
		p := pkgs[dir]
		if p == nil {
			p = &goPackage{funcs: map[string][]*ast.FuncDecl{}}
			pkgs[dir] = p
		}
		p.files = append(p.files, goFile{path: filepath.ToSlash(path), fset: fset, ast: file})
		for _, decl := range file.Decls {
			if fn, ok := decl.(*ast.FuncDecl); ok && fn.Body != nil {
				p.funcs[fn.Name.Name] = append(p.funcs[fn.Name.Name], fn)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk pkg/molten: %v", err)
	}
	var missing []string
	used := map[string]bool{}
	for _, p := range pkgs {
		for _, f := range p.files {
			for _, decl := range f.ast.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					continue
				}
				key := f.path + ":" + funcDeclName(fn)
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					g, ok := n.(*ast.GoStmt)
					if !ok || p.goRecovers(g) {
						return true
					}
					if _, allowed := goroutinesWithoutRecover[key]; allowed {
						used[key] = true
						return true
					}
					missing = append(missing, f.fset.Position(g.Pos()).String()+" ("+key+")")
					return true
				})
			}
		}
	}
	sort.Strings(missing)
	for _, m := range missing {
		t.Errorf("goroutine without a recover: %s; defer panichandler.PanicHandler(\"molten:<pkg>:<what>\", recover()) first, or add it to goroutinesWithoutRecover with the reason", m)
	}
	for key := range goroutinesWithoutRecover {
		if !used[key] {
			t.Errorf("goroutinesWithoutRecover lists %s, which starts no goroutine without a recover any more: remove it", key)
		}
	}
}

type goFile struct {
	path string
	fset *token.FileSet
	ast  *ast.File
}

type goPackage struct {
	files []goFile
	funcs map[string][]*ast.FuncDecl
}

func funcDeclName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return fn.Name.Name
	}
	recv := fn.Recv.List[0].Type
	if star, ok := recv.(*ast.StarExpr); ok {
		recv = star.X
	}
	if idx, ok := recv.(*ast.IndexExpr); ok {
		recv = idx.X
	}
	if id, ok := recv.(*ast.Ident); ok {
		return id.Name + "." + fn.Name.Name
	}
	return fn.Name.Name
}

func (p *goPackage) goRecovers(g *ast.GoStmt) bool {
	switch fun := g.Call.Fun.(type) {
	case *ast.FuncLit:
		return p.bodyRecovers(fun.Body)
	case *ast.Ident:
		return p.namedFuncRecovers(fun.Name)
	case *ast.SelectorExpr:
		return p.namedFuncRecovers(fun.Sel.Name)
	}
	return false
}

// namedFuncRecovers resolves a call by name within the package: every
// function or method of that name must recover, so a name it cannot resolve
// (a method of another package, cmd.Wait) counts as not recovering.
func (p *goPackage) namedFuncRecovers(name string) bool {
	decls := p.funcs[name]
	if len(decls) == 0 {
		return false
	}
	for _, fn := range decls {
		if !p.bodyRecovers(fn.Body) {
			return false
		}
	}
	return true
}

// bodyRecovers reports whether one of the body's top-level defers recovers:
// a deferred closure that calls recover(), or a deferred call to a function
// of the package that calls recover() itself.
func (p *goPackage) bodyRecovers(body *ast.BlockStmt) bool {
	for _, stmt := range body.List {
		d, ok := stmt.(*ast.DeferStmt)
		if !ok {
			continue
		}
		if lit, ok := d.Call.Fun.(*ast.FuncLit); ok && callsRecover(lit.Body) {
			return true
		}
		if id, ok := d.Call.Fun.(*ast.Ident); ok {
			for _, fn := range p.funcs[id.Name] {
				if callsRecover(fn.Body) {
					return true
				}
			}
		}
	}
	return false
}

func callsRecover(n ast.Node) bool {
	found := false
	ast.Inspect(n, func(n ast.Node) bool {
		if found {
			return false
		}
		if _, ok := n.(*ast.FuncLit); ok {
			return false
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "recover" {
			found = true
		}
		return true
	})
	return found
}
