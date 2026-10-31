// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package filesearch

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func writeFile(t *testing.T, root string, rel string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func names(r Result) []string {
	rtn := make([]string, 0, len(r.Matches))
	for _, m := range r.Matches {
		rtn = append(rtn, m.Name)
	}
	return rtn
}

func TestIsGlob(t *testing.T) {
	for pattern, want := range map[string]bool{"test": false, "*.tsx": true, "a?c": true, "[ab]x": true, "a.b-c": false} {
		if got := IsGlob(pattern); got != want {
			t.Errorf("IsGlob(%q) = %v, want %v", pattern, got, want)
		}
	}
}

func TestMatchName(t *testing.T) {
	cases := []struct {
		name, pattern string
		want          bool
	}{
		{"Button.test.tsx", "", true},
		{"Button.test.tsx", "TEST", true},
		{"Button.test.tsx", "est.t", true},
		{"Button.tsx", "test", false},
		{"Button.TSX", "*.tsx", true},
		{"Button.tsx.map", "*.tsx", false},
		{"file1.go", "file?.go", true},
		{"file10.go", "file?.go", false},
		{"a.go", "[ab].go", true},
		{"c.go", "[ab].go", false},
		{"c.go", "[^ab].go", true},
		{"x", "[", false},
	}
	for _, c := range cases {
		if got := MatchName(c.name, c.pattern); got != c.want {
			t.Errorf("MatchName(%q, %q) = %v, want %v", c.name, c.pattern, got, c.want)
		}
	}
}

func TestValidatePattern(t *testing.T) {
	for _, ok := range []string{"", "test", "*.tsx", "[a-z]*", strings.Repeat("é", MaxPatternLen)} {
		if err := ValidatePattern(ok); err != nil {
			t.Errorf("ValidatePattern(%q): %v", ok, err)
		}
	}
	for _, bad := range []string{strings.Repeat("a", MaxPatternLen+1), "a\nb", "tab\there", "\x1b[31m", "[abc", "*abc\\"} {
		err := ValidatePattern(bad)
		if !errors.Is(err, ErrBadPattern) {
			t.Errorf("ValidatePattern(%q) = %v, want a bad pattern", bad, err)
		}
	}
}

func TestSearchOneFolder(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"test-a.ts", "b.ts", ".test-hidden", "src/test-deep.ts", "Testing/readme"} {
		writeFile(t, root, rel)
	}
	r, err := Search(root, "test", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(names(r), ","); got != "Testing,test-a.ts" {
		t.Fatalf("matches %q", got)
	}
	if !r.Matches[0].IsFolder() || r.Matches[0].Path != filepath.Join(root, "Testing") {
		t.Fatalf("folder match %+v", r.Matches[0])
	}
	r, _ = Search(root, "test", false, true)
	if got := strings.Join(names(r), ","); got != "Testing,.test-hidden,test-a.ts" {
		t.Fatalf("with hidden files %q", got)
	}
	r, _ = Search(root, "nothing", false, true)
	if len(r.Matches) != 0 || r.Matches == nil {
		t.Fatalf("zero matches is an empty list: %+v", r)
	}
}

func TestSearchRecursiveSkipsAndHidden(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{
		"src/app.tsx", "src/ui/button.tsx", "src/ui/button.css", "node_modules/lib/x.tsx", ".git/hooks/y.tsx",
		"pkg/node_modules/z.tsx", ".config/hidden.tsx", "docs/.draft.tsx", "top.TSX",
	} {
		writeFile(t, root, rel)
	}
	r, err := Search(root, "*.tsx", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(names(r), ","); got != "src/app.tsx,src/ui/button.tsx,top.TSX" {
		t.Fatalf("matches %q", got)
	}
	r, _ = Search(root, "*.tsx", true, true)
	if got := strings.Join(names(r), ","); got != ".config/hidden.tsx,docs/.draft.tsx,src/app.tsx,src/ui/button.tsx,top.TSX" {
		t.Fatalf("with hidden files %q", got)
	}
	r, _ = Search(root, "ui", true, false)
	if got := strings.Join(names(r), ","); got != "src/ui" || !r.Matches[0].IsFolder() {
		t.Fatalf("folder matches %+v", r.Matches)
	}
}

func TestSearchRecursiveStopsAtTheLimit(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < MaxMatches+5; i++ {
		writeFile(t, root, fmt.Sprintf("d%d/f%d.txt", i%7, i))
	}
	r, err := Search(root, "*.txt", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Matches) != MaxMatches || !r.Truncated {
		t.Fatalf("%d matches, truncated %v", len(r.Matches), r.Truncated)
	}
	exact := t.TempDir()
	for i := 0; i < MaxMatches; i++ {
		writeFile(t, exact, fmt.Sprintf("f%d.txt", i))
	}
	r, _ = Search(exact, "*.txt", true, false)
	if len(r.Matches) != MaxMatches || r.Truncated {
		t.Fatalf("exactly the limit: %d matches, truncated %v", len(r.Matches), r.Truncated)
	}
}

func TestSearchDoesNotFollowLinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	writeFile(t, outside, "secret.tsx")
	writeFile(t, root, "in.tsx")
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skip("symbolic links unavailable:", err)
	}
	r, err := Search(root, "*", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(names(r), ","); got != "linked,in.tsx" {
		t.Fatalf("matches %q", got)
	}
	if !r.Matches[0].IsFolder() {
		t.Fatalf("a link to a folder lists with the folders: %+v", r.Matches[0])
	}
}

func TestSearchErrors(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "f.txt")
	if _, err := Search(filepath.Join(root, "missing"), "", false, false); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing folder: %v", err)
	}
	if _, err := Search(filepath.Join(root, "f.txt"), "", false, false); err == nil || !strings.Contains(err.Error(), "not a folder") {
		t.Fatalf("a file: %v", err)
	}
	if _, err := Search(root, "[x", true, false); !errors.Is(err, ErrBadPattern) {
		t.Fatalf("bad glob: %v", err)
	}
}

func TestSortMatches(t *testing.T) {
	matches := []Match{{Name: "file10"}, {Name: "File2"}, {Name: "b", IsDir: true}, {Name: "a"}, {Name: "link", MimeType: "directory"}, {Name: "file2"}}
	SortMatches(matches)
	var got []string
	for _, m := range matches {
		got = append(got, m.Name)
	}
	if strings.Join(got, ",") != "b,link,a,File2,file2,file10" {
		t.Fatalf("order %v", got)
	}
}

func TestFilterMeta(t *testing.T) {
	meta := FilterMeta("/p/src", "test", true)
	if meta[FilterMetaKey] != "test" || meta[FilterRecursiveMetaKey] != true || meta[FilterDirMetaKey] != "/p/src" {
		t.Fatalf("filter meta %v", meta)
	}
	clear := FilterMeta("/p/src", "", false)
	for _, key := range []string{FilterMetaKey, FilterRecursiveMetaKey, FilterDirMetaKey, FilterByMetaKey, FilterByNameMetaKey} {
		if v, ok := clear[key]; !ok || v != nil {
			t.Fatalf("clearing writes %s = null: %v", key, clear)
		}
	}
}

func TestFilterMetaFromAsker(t *testing.T) {
	forged := waveobj.MetaMapType{FilterMetaKey: "x", FilterByMetaKey: "agent", FilterByNameMetaKey: "Mallory"}
	got := FilterMetaFromAsker(forged, false, "Olivia")
	if got[FilterByMetaKey] != FilterByAgent || got[FilterByNameMetaKey] != "Olivia" {
		t.Fatalf("an agent's filter names it: %v", got)
	}
	if forged[FilterByNameMetaKey] != "Mallory" {
		t.Fatal("the request's meta is never modified")
	}
	got = FilterMetaFromAsker(forged, false, "")
	if got[FilterByMetaKey] != FilterByCommand || got[FilterByNameMetaKey] != nil {
		t.Fatalf("a terminal without an agent: %v", got)
	}
	got = FilterMetaFromAsker(waveobj.MetaMapType{FilterByNameMetaKey: "Mallory"}, false, "")
	if v, ok := got[FilterByNameMetaKey]; !ok || v != nil {
		t.Fatalf("a terminal cannot write who set the filter alone: %v", got)
	}
	ui := waveobj.MetaMapType{FilterMetaKey: "x", FilterByMetaKey: nil}
	if got := FilterMetaFromAsker(ui, true, ""); got[FilterByMetaKey] != nil || got[FilterMetaKey] != "x" {
		t.Fatalf("a window's write is kept: %v", got)
	}
	other := waveobj.MetaMapType{"file": "/x"}
	if got := FilterMetaFromAsker(other, false, "Olivia"); len(got) != 1 {
		t.Fatalf("a write without filter keys is kept: %v", got)
	}
}
