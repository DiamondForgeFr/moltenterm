// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestViewProjectDir(t *testing.T) {
	cases := []struct {
		name string
		meta waveobj.MetaMapType
		want string
	}{
		{"nothing", waveobj.MetaMapType{}, ""},
		{"project", waveobj.MetaMapType{viewpin.ProjectMetaKey: "/p", "molten:folder": "/p/sub"}, "/p"},
		{"folder only (#1642)", waveobj.MetaMapType{"molten:folder": "/notes"}, "/notes"},
	}
	for _, c := range cases {
		if got := viewProjectDir(c.meta); got != c.want {
			t.Errorf("%s: viewProjectDir = %q, want %q", c.name, got, c.want)
		}
	}
	pane := viewpin.ResolvePane(waveobj.MetaMapType{"view": "preview", "file": viewpin.ProjectToken}, viewpin.Project{Dir: viewProjectDir(waveobj.MetaMapType{"molten:folder": "/notes"})})
	if pane["file"] != "/notes" {
		t.Errorf("a pinned file panel opens on %v, want the workspace folder", pane["file"])
	}
}
