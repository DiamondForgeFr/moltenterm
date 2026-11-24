// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCheckPathInside(t *testing.T) {
	cases := []struct {
		path string
		dir  string
		want bool
	}{
		{"/p/app", "/p/app", true},
		{"/p/app/src/ui", "/p/app", true},
		{"/p/app/", "/p/app", true},
		{"/p/application", "/p/app", false},
		{"/p", "/p/app", false},
		{"/tmp", "/p/app", false},
		{"/p/..app", "/p", true},
		{"", "/p/app", false},
		{"/p/app", "", false},
	}
	for _, tc := range cases {
		if got := CheckPathInside(tc.path, tc.dir); got != tc.want {
			t.Errorf("CheckPathInside(%q, %q) = %v, want %v", tc.path, tc.dir, got, tc.want)
		}
	}
}

func TestWorkspaceFolder(t *testing.T) {
	cases := []struct {
		name string
		meta waveobj.MetaMapType
		want string
	}{
		{"no folder", nil, ""},
		{"folder without project", waveobj.MetaMapType{WorkspaceFolderMetaKey: "/tmp/x"}, "/tmp/x"},
		{"folder inside the project", waveobj.MetaMapType{WorkspaceFolderMetaKey: "/p/app/src", ProjectMetaKey: "/p/app"}, "/p/app/src"},
		{"folder outside the project", waveobj.MetaMapType{WorkspaceFolderMetaKey: "/tmp", ProjectMetaKey: "/p/app"}, "/p/app"},
		{"project without folder", waveobj.MetaMapType{ProjectMetaKey: "/p/app"}, "/p/app"},
	}
	for _, tc := range cases {
		if got := WorkspaceFolder(tc.meta); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

// #2516: the context's folder bounds its workspaces, a workspace's chosen folder replaces it, a project inside the bound
// narrows it, and a folder chosen in the settings is where new blocks start whatever the terminal did.
func TestBoundingAndStartFolder(t *testing.T) {
	chosen := func(folder string, more waveobj.MetaMapType) waveobj.MetaMapType {
		meta := waveobj.MetaMapType{WorkspaceFolderMetaKey: folder, WorkspaceFolderChosenMetaKey: true}
		for k, v := range more {
			meta[k] = v
		}
		return meta
	}
	cases := []struct {
		name      string
		context   string
		meta      waveobj.MetaMapType
		wantBound string
		wantStart string
	}{
		{"nothing set", "", nil, "", ""},
		{"context only", "/c", nil, "/c", "/c"},
		{"followed folder inside the context", "/c", waveobj.MetaMapType{WorkspaceFolderMetaKey: "/c/x"}, "/c", "/c/x"},
		{"followed folder outside the context", "/c", waveobj.MetaMapType{WorkspaceFolderMetaKey: "/home/me"}, "/c", "/c"},
		{"chosen workspace folder", "", chosen("/w", nil), "/w", "/w"},
		{"chosen folder inside the context narrows it", "/c", chosen("/c/w", nil), "/c/w", "/c/w"},
		{"chosen folder outside the context was confirmed and applies", "/c", chosen("/elsewhere", nil), "/elsewhere", "/elsewhere"},
		{"project outside the context is not a bound", "/c", waveobj.MetaMapType{ProjectMetaKey: "/q"}, "/c", "/c"},
		{"project inside the chosen folder narrows it", "", chosen("/w", waveobj.MetaMapType{ProjectMetaKey: "/w/p"}), "/w/p", "/w/p"},
		{"project outside the chosen folder is ignored", "", chosen("/w", waveobj.MetaMapType{ProjectMetaKey: "/q"}), "/w", "/w"},
		{"all three nested", "/c", chosen("/c/w", waveobj.MetaMapType{ProjectMetaKey: "/c/w/p"}), "/c/w/p", "/c/w/p"},
		{"project alone", "", waveobj.MetaMapType{ProjectMetaKey: "/p"}, "/p", "/p"},
	}
	for _, tc := range cases {
		if got := BoundingFolder(tc.context, tc.meta); got != tc.wantBound {
			t.Errorf("%s: bound %q, want %q", tc.name, got, tc.wantBound)
		}
		if got := StartFolder(tc.context, tc.meta); got != tc.wantStart {
			t.Errorf("%s: start %q, want %q", tc.name, got, tc.wantStart)
		}
	}
}

// #2518: a folder chosen for a workspace needs the confirmation when it lies outside its context's folder. Only whole
// path elements count, so a sibling that shares a prefix is outside, and trailing separators or ".." do not hide it.
func TestOutsideContextFolder(t *testing.T) {
	cases := []struct {
		name    string
		folder  string
		context string
		want    bool
	}{
		{"the context's own folder", "/a/b", "/a/b", false},
		{"inside", "/a/b/c", "/a/b", false},
		{"trailing separators on both", "/a/b/c/", "/a/b/", false},
		{"the same folder with a trailing separator", "/a/b/", "/a/b", false},
		{"a sibling sharing the prefix", "/a/bc", "/a/b", true},
		{"a sibling sharing the prefix with a separator", "/a/bc/", "/a/b/", true},
		{"the parent", "/a", "/a/b", true},
		{"a folder named like a parent step", "/a/b/..c", "/a/b", false},
		{"leaving through a parent step", "/a/b/../c", "/a/b", true},
		{"coming back through a parent step", "/a/c/../b/x", "/a/b", false},
		{"elsewhere", "/home/me", "/a/b", true},
		{"the root context", "/anything", "/", false},
		{"no context folder is no bound", "/home/me", "", false},
		{"no workspace folder asks nothing", "", "/a/b", false},
		{"a relative folder cannot be confirmed as inside", "b/c", "/a/b", true},
	}
	for _, tc := range cases {
		if got := OutsideContextFolder(tc.folder, tc.context); got != tc.want {
			t.Errorf("%s: OutsideContextFolder(%q, %q) = %v, want %v", tc.name, tc.folder, tc.context, got, tc.want)
		}
	}
}

func TestBlockMetaInFolder(t *testing.T) {
	cases := []struct {
		name    string
		meta    waveobj.MetaMapType
		want    waveobj.MetaMapType
		changed bool
	}{
		{
			"local terminal starts in the folder",
			waveobj.MetaMapType{"view": "term", "controller": "shell"},
			waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/p/app"},
			true,
		},
		{
			"terminal of an explicit local shell",
			waveobj.MetaMapType{"view": "term", "controller": "shell", "connection": "local:zsh"},
			waveobj.MetaMapType{"view": "term", "controller": "shell", "connection": "local:zsh", "cmd:cwd": "/p/app"},
			true,
		},
		{
			"split terminal keeps its source's folder",
			waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/elsewhere"},
			waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/elsewhere"},
			false,
		},
		{
			"remote terminal untouched",
			waveobj.MetaMapType{"view": "term", "controller": "shell", "connection": "user@host"},
			waveobj.MetaMapType{"view": "term", "controller": "shell", "connection": "user@host"},
			false,
		},
		{
			"wsl terminal untouched",
			waveobj.MetaMapType{"view": "term", "controller": "shell", "connection": "wsl://Ubuntu"},
			waveobj.MetaMapType{"view": "term", "controller": "shell", "connection": "wsl://Ubuntu"},
			false,
		},
		{
			"command block untouched",
			waveobj.MetaMapType{"view": "term", "controller": "cmd", "cmd": "make"},
			waveobj.MetaMapType{"view": "term", "controller": "cmd", "cmd": "make"},
			false,
		},
		{
			"file explorer opens the folder",
			waveobj.MetaMapType{"view": "preview"},
			waveobj.MetaMapType{"view": "preview", "file": "/p/app"},
			true,
		},
		{
			"file view of a given file untouched",
			waveobj.MetaMapType{"view": "preview", "file": "~/notes.md"},
			waveobj.MetaMapType{"view": "preview", "file": "~/notes.md"},
			false,
		},
		{
			"other views untouched",
			waveobj.MetaMapType{"view": "molten-timeline"},
			waveobj.MetaMapType{"view": "molten-timeline"},
			false,
		},
	}
	for _, tc := range cases {
		before := waveobj.MetaMapType{}
		for k, v := range tc.meta {
			before[k] = v
		}
		got, changed := BlockMetaInFolder(tc.meta, "/p/app")
		if changed != tc.changed || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got (%v, %v), want (%v, %v)", tc.name, got, changed, tc.want, tc.changed)
		}
		if !reflect.DeepEqual(tc.meta, before) {
			t.Errorf("%s: the block definition's meta was modified", tc.name)
		}
	}
	if _, changed := BlockMetaInFolder(waveobj.MetaMapType{"view": "term", "controller": "shell"}, ""); changed {
		t.Errorf("without a folder nothing changes")
	}
}

// #749: linking a project puts its folder first in the recent folders the command palette offers.
func TestPushRecentFolder(t *testing.T) {
	got := PushRecentFolder([]any{"/a", "/proj", 3, "", "/b"}, "/proj")
	if !reflect.DeepEqual(got, []string{"/proj", "/a", "/b"}) {
		t.Errorf("got %v", got)
	}
	if got := PushRecentFolder(nil, "/proj"); !reflect.DeepEqual(got, []string{"/proj"}) {
		t.Errorf("from nothing %v", got)
	}
	many := []any{"/1", "/2", "/3", "/4", "/5", "/6", "/7", "/8"}
	if got := PushRecentFolder(many, "/new"); len(got) != MaxRecentFolders || got[0] != "/new" || got[7] != "/7" {
		t.Errorf("capped %v", got)
	}
}
