// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package buildchannel

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

var everyChannel = []string{Dev, Local, Gold, RC, Public, Unknown, "", "Gold", "nightly"}

func registryIds() map[string]bool {
	ids := map[string]bool{}
	for _, feature := range Registry() {
		ids[feature.Id] = true
	}
	return ids
}

func TestTheRegistryIsWellFormed(t *testing.T) {
	t.Parallel()
	features := Registry()
	if len(features) == 0 {
		t.Fatal("the registry lists no feature")
	}
	seen := map[string]bool{}
	for _, feature := range features {
		if feature.Id == "" || seen[feature.Id] {
			t.Errorf("feature %+v has no id or repeats one", feature)
		}
		seen[feature.Id] = true
		if feature.LabelKey == "" || feature.DescriptionKey == "" || feature.Ticket <= 0 {
			t.Errorf("feature %q lacks a name key, a description key or its ticket: %+v", feature.Id, feature)
		}
		if len(feature.Channels) == 0 {
			t.Errorf("feature %q is open on no channel", feature.Id)
		}
		opened := map[string]bool{}
		for _, channel := range feature.Channels {
			if !known(channel) || opened[channel] {
				t.Errorf("feature %q lists %q, which is not a channel or is listed twice", feature.Id, channel)
			}
			opened[channel] = true
		}
	}
	if !seen[FeatureBrainstorm] {
		t.Errorf("the brainstorm (%q) is not in the registry", FeatureBrainstorm)
	}
}

// The brainstorm is the registry's first entry (FR-BOSS-011): the same channels as before the registry.
func TestFeatureAllowedFollowsTheRegistry(t *testing.T) {
	t.Parallel()
	want := map[string]bool{Gold: true, Dev: true, Local: true}
	for _, channel := range everyChannel {
		if got := FeatureAllowed(FeatureBrainstorm, channel); got != want[channel] {
			t.Errorf("FeatureAllowed(brainstorm, %q) = %v, want %v", channel, got, want[channel])
		}
	}
	for _, id := range []string{"", "nope", "Brainstorm"} {
		for _, channel := range everyChannel {
			if FeatureAllowed(id, channel) {
				t.Errorf("FeatureAllowed(%q, %q): a feature outside the registry opened", id, channel)
			}
		}
	}
}

// FR-BOSS-011 AC5: whatever the developer stored, a feature is never on where its channel does not open it, and the
// switches only remove from what the channel opens. Must match gated-features.test.ts.
func TestASwitchOnlyNarrows(t *testing.T) {
	t.Parallel()
	states := []Narrowing{
		{},
		{Public: true},
		{Off: []string{FeatureBrainstorm}},
		{Off: []string{"another"}},
		{Public: true, Off: []string{FeatureBrainstorm}},
		{Off: []string{"", "nope"}},
	}
	for _, feature := range Registry() {
		for _, channel := range everyChannel {
			for _, state := range states {
				got := FeatureOn(feature.Id, channel, state)
				allowed := FeatureAllowed(feature.Id, channel)
				switch {
				case got && !allowed:
					t.Errorf("FeatureOn(%q, %q, %+v): a switch opened a feature its channel does not open", feature.Id, channel, state)
				case got && state.Closes(feature.Id):
					t.Errorf("FeatureOn(%q, %q, %+v): a feature switched off is on", feature.Id, channel, state)
				case allowed && !state.Closes(feature.Id) && !got:
					t.Errorf("FeatureOn(%q, %q, %+v): a feature nobody switched off is off", feature.Id, channel, state)
				}
				if (channel == RC || channel == Public) && got {
					t.Errorf("FeatureOn(%q, %q, %+v): on a release", feature.Id, channel, state)
				}
			}
		}
	}
}

func TestParseNarrowing(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		raw  any
		want Narrowing
	}{
		{"nothing stored", nil, Narrowing{}},
		{"not an object", "brainstorm", Narrowing{}},
		{"a list", []any{"brainstorm"}, Narrowing{}},
		{"the stored shape", map[string]any{"public": true, "off": []any{"brainstorm"}}, Narrowing{Public: true, Off: []string{"brainstorm"}}},
		{"typed lists", map[string]any{"off": []string{"a", "b"}}, Narrowing{Off: []string{"a", "b"}}},
		{"a string is not a yes", map[string]any{"public": "true", "off": []any{"brainstorm"}}, Narrowing{Off: []string{"brainstorm"}}},
		{"a bad list leaves the other field", map[string]any{"public": true, "off": 5}, Narrowing{Public: true}},
		{"only ids count", map[string]any{"off": []any{"brainstorm", 5, "", nil}}, Narrowing{Off: []string{"brainstorm"}}},
	}
	for _, c := range cases {
		got := ParseNarrowing(c.raw)
		if got.Public != c.want.Public || strings.Join(got.Off, ",") != strings.Join(c.want.Off, ",") {
			t.Errorf("%s: ParseNarrowing(%v) = %+v, want %+v", c.name, c.raw, got, c.want)
		}
	}
}

// FR-BOSS-011 AC3, AC5: wavesrv reads the switches at each call, and not at all where its channel does not open the
// feature.
func TestFeatureEnabledReadsTheSwitchesAtEachCall(t *testing.T) {
	var reads atomic.Int32
	state := Narrowing{}
	restore := StartAsForTest(Gold, Narrowing{})
	t.Cleanup(restore)
	UseNarrowing(func() Narrowing {
		reads.Add(1)
		return state
	})
	if !FeatureEnabled(FeatureBrainstorm) || !BrainstormEnabled() {
		t.Fatal("a gold with nothing switched off has no brainstorm")
	}
	state = Narrowing{Off: []string{FeatureBrainstorm}}
	if FeatureEnabled(FeatureBrainstorm) || BrainstormEnabled() {
		t.Error("the brainstorm stays on after the developer switched it off")
	}
	state = Narrowing{Public: true}
	if BrainstormEnabled() {
		t.Error("the brainstorm stays on in the public version")
	}
	state = Narrowing{}
	if !BrainstormEnabled() {
		t.Error("the brainstorm does not come back when the switches are cleared")
	}
	if FeatureEnabled("nope") {
		t.Error("a feature outside the registry is on")
	}

	reads.Store(0)
	for _, channel := range []string{RC, Public, Unknown, ""} {
		restoreChannel := StartAsForTest(channel, Narrowing{})
		UseNarrowing(func() Narrowing {
			reads.Add(1)
			return Narrowing{}
		})
		if BrainstormEnabled() {
			t.Errorf("the brainstorm is on for a build on %q", channel)
		}
		restoreChannel()
	}
	if reads.Load() != 0 {
		t.Errorf("the switches were read %d times on channels that do not open the feature", reads.Load())
	}
}

func TestNothingIsOnBeforeElectronMainGivesTheChannel(t *testing.T) {
	restore := StartAsForTest(Gold, Narrowing{})
	restore()
	if FeatureEnabled(FeatureBrainstorm) {
		t.Error("a wavesrv started without a channel has the brainstorm")
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("the repository root is not %s: %v", root, err)
	}
	return root
}

// featureConstants reads the Feature* constants of features.go.
func featureConstants(t *testing.T, root string) map[string]string {
	t.Helper()
	path := filepath.Join(root, "pkg", "molten", "buildchannel", "features.go")
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	constants := map[string]string{}
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			value := spec.(*ast.ValueSpec)
			for i, name := range value.Names {
				literal, ok := value.Values[i].(*ast.BasicLit)
				if !strings.HasPrefix(name.Name, "Feature") || !ok || literal.Kind != token.STRING {
					continue
				}
				unquoted, err := strconv.Unquote(literal.Value)
				if err != nil {
					t.Fatal(err)
				}
				constants[name.Name] = unquoted
			}
		}
	}
	return constants
}

var gateFunctions = map[string]bool{"FeatureEnabled": true, "FeatureAllowed": true, "FeatureOn": true, "FeatureById": true}

// gateProblems lists the calls of src that check a gate for something that is not a feature of the registry: a name
// that is not in it, a constant it does not know, or a value computed at run time.
func gateProblems(name string, src []byte, constants map[string]string, ids map[string]bool) (problems []string, checked int) {
	file, err := parser.ParseFile(token.NewFileSet(), name, src, parser.SkipObjectResolution)
	if err != nil {
		return []string{name + ": " + err.Error()}, 0
	}
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) == 0 {
			return true
		}
		var function string
		switch fun := call.Fun.(type) {
		case *ast.SelectorExpr:
			if pkg, ok := fun.X.(*ast.Ident); ok && pkg.Name == "buildchannel" {
				function = fun.Sel.Name
			}
		case *ast.Ident:
			function = fun.Name
		}
		if !gateFunctions[function] {
			return true
		}
		checked++
		var constant string
		switch arg := call.Args[0].(type) {
		case *ast.BasicLit:
			if unquoted, err := strconv.Unquote(arg.Value); err == nil && ids[unquoted] {
				return true
			}
			problems = append(problems, name+": "+function+"("+arg.Value+") checks a feature that is not in the registry")
			return true
		case *ast.Ident:
			constant = arg.Name
		case *ast.SelectorExpr:
			constant = arg.Sel.Name
		default:
			problems = append(problems, name+": "+function+" is asked about a feature computed at run time: name a buildchannel.Feature constant")
			return true
		}
		if value, ok := constants[constant]; !ok || !ids[value] {
			problems = append(problems, name+": "+function+"("+constant+") checks a feature that is not in the registry")
		}
		return true
	})
	return problems, checked
}

// FR-BOSS-011 AC2: a gate that checks a feature the registry does not declare fails the tests. The scan reads every Go
// file of the repository; the guard itself is proved on synthetic sources.
func TestEveryGateNamesARegistryFeature(t *testing.T) {
	t.Parallel()
	root := repositoryRoot(t)
	ids := registryIds()
	constants := featureConstants(t, root)
	for name, value := range constants {
		if !ids[value] {
			t.Errorf("constant %s = %q is not a feature of the registry", name, value)
		}
	}
	for id := range ids {
		found := false
		for _, value := range constants {
			found = found || value == id
		}
		if !found {
			t.Errorf("registry feature %q has no Feature constant for the gates to name it", id)
		}
	}

	synthetic := map[string]struct {
		src      string
		problems int
	}{
		"a constant":   {"package x\nvar _ = buildchannel.FeatureEnabled(buildchannel.FeatureBrainstorm)", 0},
		"its value":    {"package x\nvar _ = buildchannel.FeatureAllowed(\"brainstorm\", \"gold\")", 0},
		"a stranger":   {"package x\nvar _ = buildchannel.FeatureEnabled(\"nope\")", 1},
		"a constant 2": {"package x\nvar _ = buildchannel.FeatureOn(buildchannel.FeatureNope, \"gold\", n)", 1},
		"a variable":   {"package x\nfunc f(id string) bool { return buildchannel.FeatureEnabled(id) == true }", 1},
		"a call":       {"package x\nvar _ = buildchannel.FeatureEnabled(name())", 1},
		"other calls":  {"package x\nvar _ = other.FeatureEnabled(\"nope\")\nvar _ = fmt.Sprint(\"nope\")", 0},
	}
	for name, c := range synthetic {
		if problems, _ := gateProblems(name, []byte(c.src), constants, ids); len(problems) != c.problems {
			t.Errorf("synthetic %q: %d problems %v, want %d", name, len(problems), problems, c.problems)
		}
	}

	var problems []string
	checked := 0
	for _, dir := range []string{"pkg", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() && (entry.Name() == "node_modules" || entry.Name() == "testdata") {
				return filepath.SkipDir
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			// features.go implements the gates and passes the id it was given on.
			if !bytes.Contains(src, []byte("Feature")) || filepath.Base(path) == "features.go" && filepath.Base(filepath.Dir(path)) == "buildchannel" {
				return nil
			}
			found, count := gateProblems(path, src, constants, ids)
			problems = append(problems, found...)
			checked += count
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	sort.Strings(problems)
	for _, problem := range problems {
		t.Error(problem)
	}
	if checked == 0 {
		t.Error("the scan found no gate to check: BrainstormAllowed names the brainstorm")
	}
}

// StartAsForTest sets wavesrv's channel by hand: production code must never call it.
func TestStartAsForTestIsOnlyCalledFromTests(t *testing.T) {
	t.Parallel()
	root := repositoryRoot(t)
	for _, dir := range []string{"pkg", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() && (entry.Name() == "node_modules" || entry.Name() == "testdata") {
				return filepath.SkipDir
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			if filepath.Base(path) == "features.go" && filepath.Base(filepath.Dir(path)) == "buildchannel" {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if bytes.Contains(src, []byte("StartAsForTest")) {
				t.Errorf("%s uses StartAsForTest, which is for tests", path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
