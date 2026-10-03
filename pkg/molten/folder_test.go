// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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
