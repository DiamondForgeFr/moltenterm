// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeProjectFile(t *testing.T, dir string, rel string, content string) string {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return full
}

func TestResolveProjectDirRaisesToGitRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(root, "src", "app")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}
	got, err := ResolveProjectDir("", sub)
	if err != nil || got != root {
		t.Fatalf("from cwd: got %q, %v; want %q", got, err, root)
	}
	got, err = ResolveProjectDir("src", root)
	if err != nil || got != root {
		t.Fatalf("relative arg: got %q, %v; want %q", got, err, root)
	}
}

func TestResolveProjectDirWithoutGit(t *testing.T) {
	dir := t.TempDir()
	got, err := ResolveProjectDir(dir, "/")
	if err != nil || got != filepath.Clean(dir) {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := ResolveProjectDir(filepath.Join(dir, "missing"), "/"); err == nil {
		t.Fatal("a missing folder must be refused")
	}
	file := writeProjectFile(t, dir, "notes.txt", "x")
	if _, err := ResolveProjectDir(file, "/"); err == nil {
		t.Fatal("a file must be refused")
	}
}

func TestReadProjectSaaSFoundry(t *testing.T) {
	dir := t.TempDir()
	writeProjectFile(t, dir, "package.json", `{"name":"pkg-name"}`)
	writeProjectFile(t, dir, ".saasfoundry.json", `{
		"projectName": "notulia",
		"mainBranch": "main",
		"workflow": {
			"workingBranch": "develop",
			"prTargetBranch": "develop",
			"branchNaming": {"feature": "feature/{N}-{description}", "release": "rc-{version}"},
			"commitFormat": {"pattern": "type(#N): description", "requireTicket": true}
		}
	}`)
	info := ReadProject(dir)
	if !info.Exists || info.HasPipeline || info.Harness != "saasfoundryai" || info.Name != "notulia" {
		t.Fatalf("unexpected info: %+v", info)
	}
	want := &ProjectConventions{
		WorkingBranch:  "develop",
		PrTargetBranch: "develop",
		MainBranch:     "main",
		BranchNaming:   map[string]string{"feature": "feature/{N}-{description}", "release": "rc-{version}"},
		CommitPattern:  "type(#N): description",
		RequireTicket:  true,
	}
	if !reflect.DeepEqual(info.Conventions, want) {
		t.Fatalf("conventions: got %+v, want %+v", info.Conventions, want)
	}
}

func TestReadProjectNameOrder(t *testing.T) {
	dir := t.TempDir()
	if got := ReadProject(dir).Name; got != filepath.Base(dir) {
		t.Fatalf("folder name: got %q", got)
	}
	writeProjectFile(t, dir, "package.json", `{"name":"pkg-name"}`)
	if got := ReadProject(dir).Name; got != "pkg-name" {
		t.Fatalf("package name: got %q", got)
	}
	writeProjectFile(t, dir, ".molten/project.json", `{"name":"Pipeline Name"}`)
	info := ReadProject(dir)
	if info.Name != "Pipeline Name" || !info.HasPipeline {
		t.Fatalf("pipeline name: got %+v", info)
	}
	writeProjectFile(t, dir, ".molten/project.json", `{broken`)
	info = ReadProject(dir)
	if info.HasPipeline || info.PipelineError == "" || info.Name != "pkg-name" {
		t.Fatalf("broken pipeline: got %+v", info)
	}
}

func TestReadProjectMissingFolder(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "gone")
	info := ReadProject(dir)
	if info.Exists || info.Name != "gone" {
		t.Fatalf("got %+v", info)
	}
}

func TestFindProjectLogos(t *testing.T) {
	dir := t.TempDir()
	favicon := writeProjectFile(t, dir, "public/favicon.svg", "<svg/>")
	tauri := writeProjectFile(t, dir, "src-tauri/icons/icon.png", "png")
	readme := writeProjectFile(t, dir, "docs/brand/mark.svg", "<svg/>")
	writeProjectFile(t, dir, "README.md", "[![CI](https://example.com/badge.svg)](x)\n<img src=\"./docs/brand/mark.svg\" width=\"40\">\n![shot](docs/other.png)\n")
	writeProjectFile(t, dir, "public/logo.txt", "not an image")
	got := FindProjectLogos(dir)
	want := []string{tauri, favicon, readme}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestFindProjectLogosStaysInsideTheProject(t *testing.T) {
	parent := t.TempDir()
	writeProjectFile(t, parent, "outside.png", "png")
	dir := filepath.Join(parent, "project")
	writeProjectFile(t, dir, "README.md", "![x](../outside.png)\n")
	if got := FindProjectLogos(dir); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestReadmeFirstImageMarkdown(t *testing.T) {
	dir := t.TempDir()
	writeProjectFile(t, dir, "README.md", "# Title\n\n![logo](assets/brand.png \"Logo\")\n")
	if got := readmeFirstImage(dir); got != "assets/brand.png" {
		t.Fatalf("got %q", got)
	}
}
