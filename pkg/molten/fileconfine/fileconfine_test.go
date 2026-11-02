// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package fileconfine

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// tree builds <tmp>/project/{src,inner-link,outer-link} and <tmp>/outside/{docs}: inner-link points at src, outer-link
// at outside. The temp folder itself is resolved, since it can sit behind a link (/var → /private/var).
func tree(t *testing.T) (project string, outside string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	project = filepath.Join(base, "project")
	outside = filepath.Join(base, "outside")
	for _, dir := range []string{filepath.Join(project, "src"), filepath.Join(outside, "docs")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if runtime.GOOS == "windows" {
		return project, outside
	}
	if err := os.Symlink(filepath.Join(project, "src"), filepath.Join(project, "inner-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(project, "outer-link")); err != nil {
		t.Fatal(err)
	}
	return project, outside
}

func TestCheck(t *testing.T) {
	project, outside := tree(t)
	type checkCase struct {
		name   string
		path   string
		inside bool
	}
	cases := []checkCase{
		{"root", project, true},
		{"root with a trailing separator", project + string(filepath.Separator), true},
		{"below", filepath.Join(project, "src"), true},
		{"not created yet", filepath.Join(project, "src", "new", "file.go"), true},
		{"parent of the root", filepath.Dir(project), false},
		{"dot dot out", filepath.Join(project, "src", "..", ".."), false},
		{"dot dot back in", filepath.Join(project, "..", "project", "src"), true},
		{"sibling", outside, false},
		{"prefix sibling", project + "-other", false},
	}
	if runtime.GOOS != "windows" {
		cases = append(cases,
			checkCase{"link inside to inside", filepath.Join(project, "inner-link"), true},
			checkCase{"link inside to outside", filepath.Join(project, "outer-link"), false},
			checkCase{"below a link to outside", filepath.Join(project, "outer-link", "docs"), false},
			checkCase{"not created yet below a link to outside", filepath.Join(project, "outer-link", "new"), false},
		)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Check(tc.path, project)
			if got.Inside != tc.inside {
				t.Fatalf("Check(%q) = %+v, want inside %v", tc.path, got, tc.inside)
			}
		})
	}
}

func TestCheckProjectThroughLink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links need privileges on Windows")
	}
	project, outside := tree(t)
	// A project linked through a symbolic link, and a path inside it reached through a link from outside.
	projectLink := filepath.Join(outside, "project-link")
	if err := os.Symlink(project, projectLink); err != nil {
		t.Fatal(err)
	}
	if got := Check(filepath.Join(project, "src"), projectLink); !got.Inside {
		t.Fatalf("a path below the project's real folder is inside the project linked from elsewhere: %+v", got)
	}
	if got := Check(filepath.Join(projectLink, "src"), project); !got.Inside {
		t.Fatalf("a path inside the project reached through a link from outside is inside: %+v", got)
	}
}

func TestCheckUnresolvableIsOutside(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links need privileges on Windows")
	}
	project, _ := tree(t)
	broken := filepath.Join(project, "broken")
	if err := os.Symlink(filepath.Join(project, "missing-target"), broken); err != nil {
		t.Fatal(err)
	}
	got := Check(broken, project)
	if got.Inside || got.Error == "" {
		t.Fatalf("a broken link counts as outside with an error: %+v", got)
	}
	if got := Check(filepath.Join(project, "src"), ""); got.Inside {
		t.Fatalf("no project is never inside: %+v", got)
	}
	if got := Check("", project); got.Inside {
		t.Fatalf("no path is never inside: %+v", got)
	}
}

func TestCheckHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home folder")
	}
	resolvedHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Skip("home folder cannot be resolved")
	}
	if got := Check("~", home); !got.Inside || got.Path != resolvedHome {
		t.Fatalf("~ is the home folder: %+v", got)
	}
}

func TestMetaFromAsker(t *testing.T) {
	write := waveobj.MetaMapType{waveobj.MetaKey_File: "/etc", ApprovedMetaKey: "/p", OriginMetaKey: "user"}

	got, changed := MetaFromAsker(write, Asker{IsUi: true})
	if changed || got[ApprovedMetaKey] != "/p" {
		t.Fatalf("a window's write is kept: %v", got)
	}

	got, changed = MetaFromAsker(write, Asker{FirstName: "Olivia"})
	if !changed {
		t.Fatal("an agent's write changes")
	}
	if _, ok := got[ApprovedMetaKey]; ok {
		t.Fatalf("an agent cannot approve: %v", got)
	}
	if got[OriginMetaKey] != OriginAgent || got[OriginNameMetaKey] != "Olivia" || got[waveobj.MetaKey_File] != "/etc" {
		t.Fatalf("an agent's file meta names it: %v", got)
	}
	if write[ApprovedMetaKey] != "/p" || write[OriginMetaKey] != "user" {
		t.Fatalf("the write passed in is never modified: %v", write)
	}

	got, _ = MetaFromAsker(write, Asker{})
	if got[OriginMetaKey] != OriginCommand || got[OriginNameMetaKey] != nil {
		t.Fatalf("a command's file meta says a command asked: %v", got)
	}

	got, changed = MetaFromAsker(waveobj.MetaMapType{ApprovedMetaKey: "/p"}, Asker{})
	if !changed || len(got) != 0 {
		t.Fatalf("an approval alone is dropped: %v", got)
	}

	other := waveobj.MetaMapType{"term:fontsize": 12}
	if got, changed := MetaFromAsker(other, Asker{}); changed || got["term:fontsize"] != 12 {
		t.Fatalf("a write without file keys is kept: %v", got)
	}
}
