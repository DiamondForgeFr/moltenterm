// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import "testing"

func TestDecideProjectTab(t *testing.T) {
	cases := []struct {
		name  string
		facts ProjectTabFacts
		open  bool
		want  string
	}{
		{"linked, never made", ProjectTabFacts{Dir: "/p"}, false, ProjectTabCreate},
		{"linked, tab there", ProjectTabFacts{Dir: "/p", RecordedDir: "/p", TabId: "t", HasView: true}, false, ProjectTabKeep},
		{"tab there, pane replaced, automatic", ProjectTabFacts{Dir: "/p", RecordedDir: "/p", TabId: "t"}, false, ProjectTabKeep},
		{"tab there, pane replaced, asked", ProjectTabFacts{Dir: "/p", RecordedDir: "/p", TabId: "t"}, true, ProjectTabRestore},
		{"closed by the user", ProjectTabFacts{Dir: "/p", RecordedDir: "/p"}, false, ProjectTabClosed},
		{"closed, then asked", ProjectTabFacts{Dir: "/p", RecordedDir: "/p"}, true, ProjectTabCreate},
		{"linked to another project", ProjectTabFacts{Dir: "/q", RecordedDir: "/p"}, false, ProjectTabCreate},
		{"another project, old tab kept", ProjectTabFacts{Dir: "/q", RecordedDir: "/p", TabId: "t", HasView: true}, false, ProjectTabKeep},
		{"unlinked after a close", ProjectTabFacts{RecordedDir: "/p"}, false, ProjectTabClear},
		{"never linked", ProjectTabFacts{}, false, ProjectTabNone},
		{"unlinked, tab kept", ProjectTabFacts{RecordedDir: "/p", TabId: "t", HasView: true}, false, ProjectTabKeep},
		{"template views, linked", ProjectTabFacts{Dir: "/p", TemplateViews: true}, false, ProjectTabNone},
		{"template views, asked", ProjectTabFacts{Dir: "/p", TemplateViews: true}, true, ProjectTabCreate},
		{"template views, asked tab kept", ProjectTabFacts{Dir: "/p", RecordedDir: "/p", TabId: "t", HasView: true, TemplateViews: true}, false, ProjectTabKeep},
		// #1760: the tab is the workspace's, shared by its projects.
		{"closed on one project, switched to the other", ProjectTabFacts{Dir: "/q", RecordedDir: "/p", ProjectDirs: []string{"/p", "/q"}}, false, ProjectTabClosed},
		{"closed on one project, switched to the other and back", ProjectTabFacts{Dir: "/p", RecordedDir: "/p", ProjectDirs: []string{"/p", "/q"}}, false, ProjectTabClosed},
		{"closed, switched to a listed project, trailing slash", ProjectTabFacts{Dir: "/q/", RecordedDir: "/p", ProjectDirs: []string{"/p", "/q"}}, false, ProjectTabClosed},
		{"closed, then asked on another project", ProjectTabFacts{Dir: "/q", RecordedDir: "/p", ProjectDirs: []string{"/p", "/q"}}, true, ProjectTabCreate},
		{"closed, linked to a folder outside the projects", ProjectTabFacts{Dir: "/z", RecordedDir: "/p", ProjectDirs: []string{"/p", "/q"}}, false, ProjectTabCreate},
		{"closed for a project the list no longer holds", ProjectTabFacts{Dir: "/q", RecordedDir: "/gone", ProjectDirs: []string{"/p", "/q"}}, false, ProjectTabCreate},
		{"tab there, switched to the other project", ProjectTabFacts{Dir: "/q", RecordedDir: "/p", TabId: "t", HasView: true, ProjectDirs: []string{"/p", "/q"}}, false, ProjectTabKeep},
	}
	for _, c := range cases {
		if got := DecideProjectTab(c.facts, c.open); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestEnsureProjectTabWithoutWcore(t *testing.T) {
	saved := projectTabs.ensure
	defer UseProjectTabs(saved)
	UseProjectTabs(nil)
	if _, err := ensureProjectTab(ProjectTabRequest{WorkspaceId: "w"}); err == nil {
		t.Fatalf("expected an error without an implementation")
	}
}
