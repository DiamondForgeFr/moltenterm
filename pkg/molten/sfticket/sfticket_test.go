// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sfticket

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir string, rel string, text string) {
	t.Helper()
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestToolOfNeedsABoardAndTheCli(t *testing.T) {
	dir := t.TempDir()
	if ToolOf(dir) != "" {
		t.Fatal("no manifest, no tool")
	}
	write(t, dir, ".saasfoundry.json", `{"workflow":{"tool":"github-projects","projectUrl":"https://github.com/orgs/o/projects/1"}}`)
	if ToolOf(dir) != "" {
		t.Fatal("no CLI, no tool")
	}
	write(t, dir, ".agents/skills/sf-tool-github-projects/"+ToolName, "#!/bin/sh\n")
	if got := ToolOf(dir); got != ".agents/skills/sf-tool-github-projects/"+ToolName {
		t.Fatalf("tool %q", got)
	}
	write(t, dir, ".claude/skills/sf-tool-github-projects/"+ToolName, "#!/bin/sh\n")
	if got := ToolOf(dir); got != ".claude/skills/sf-tool-github-projects/"+ToolName {
		t.Fatalf("Claude Code's copy comes first: %q", got)
	}
	write(t, dir, ".saasfoundry.json", `{"workflow":{"tool":"jira","projectUrl":"https://example.com"}}`)
	if ToolOf(dir) != "" {
		t.Fatal("another tool is not the board's CLI")
	}
	write(t, dir, ".saasfoundry.json", `{"workflow":{"tool":"github-projects"}}`)
	if ToolOf(dir) != "" {
		t.Fatal("no board URL, no tool")
	}
}

func TestIssueNumber(t *testing.T) {
	for url, want := range map[string]int{
		"https://github.com/o/r/issues/12":    12,
		" https://github.com/o/r/issues/12\n": 12,
		"https://github.com/o/r/pull/12":      0,
		"https://github.com/o/r/issues/x":     0,
		"":                                    0,
	} {
		if got := IssueNumber(url); got != want {
			t.Errorf("%q: %d, want %d", url, got, want)
		}
	}
}

func TestCreateRunsTheGivenScriptAndKeepsAnUnfinishedTicket(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, ".saasfoundry.json", `{"tools":{"srs":{"backend":"notion"}}}`)
	var seen []string
	run := func(ctx context.Context, cwd string, name string, args ...string) ([]byte, error) {
		seen = append([]string{cwd, name}, args...)
		script, err := os.ReadFile(args[0])
		if err != nil || string(script) != "the script" {
			t.Errorf("the tool run is not the script given: %q %v", script, err)
		}
		if info, err := os.Stat(args[0]); err != nil || info.Mode().Perm()&0077 != 0 {
			t.Errorf("the tool must be private: %v %v", info, err)
		}
		return []byte("Creating task...\nIssue URL: https://github.com/o/r/issues/31\n"), fmt.Errorf("add-to-project failed")
	}
	spec := Spec{Type: TypeTask, Title: "Release v1.0.0", Body: "body", Complexity: ComplexityLow, Nature: NatureInternal, Milestone: "1.0.0", SrsBypassReason: "why"}
	n, ok, unfinished := Create(context.Background(), run, dir, []byte("the script"), filepath.Join(t.TempDir(), "trees"), spec)
	if !ok || n != 31 || unfinished == nil {
		t.Fatalf("%d %v %v", n, ok, unfinished)
	}
	args := strings.Join(seen[2:], " ")
	if seen[0] != dir || seen[1] != "bash" || !strings.Contains(args, "create-ticket task Release v1.0.0 --body-file ") ||
		!strings.HasSuffix(args, " --complexity low --nature internal --milestone 1.0.0 --bypass-srs why") {
		t.Fatalf("call: %v", seen)
	}
	if _, err := os.Stat(seen[2]); err == nil {
		t.Fatal("the private copy of the tool was left behind")
	}

	write(t, dir, ".saasfoundry.json", `{}`)
	n, ok, _ = Create(context.Background(), run, dir, []byte("the script"), t.TempDir(), spec)
	if !ok || n != 31 || strings.Contains(strings.Join(seen, " "), "--bypass-srs") {
		t.Fatalf("a project without SRS is not asked to bypass it: %v", seen)
	}
}

func TestCreateMakesNothingWithoutAScriptOrAnAddress(t *testing.T) {
	run := func(ctx context.Context, cwd string, name string, args ...string) ([]byte, error) {
		return []byte("Error: nope\n"), fmt.Errorf("exit 1")
	}
	spec := Spec{Type: TypeTask, Title: "t", Complexity: ComplexityLow, Nature: NatureInternal}
	if _, ok, _ := Create(context.Background(), run, t.TempDir(), nil, t.TempDir(), spec); ok {
		t.Fatal("no script, no ticket")
	}
	if _, ok, _ := Create(context.Background(), run, t.TempDir(), []byte("x"), t.TempDir(), spec); ok {
		t.Fatal("no address printed, no ticket")
	}
}
