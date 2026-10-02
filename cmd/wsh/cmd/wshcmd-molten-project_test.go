// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestMoltenProjectRouting(t *testing.T) {
	cases := map[string]string{
		"molten project link":             "link",
		"molten project link ../x --json": "link",
		"molten project unlink":           "unlink",
		"molten project show --json":      "show",
		"molten project logo icon.png":    "logo",
		"molten project":                  "project",
	}
	for line, want := range cases {
		found, _, err := rootCmd.Find(strings.Fields(line))
		if err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		if found.Name() != want {
			t.Errorf("%q routes to %q, want %q", line, found.Name(), want)
		}
	}
}

func TestMoltenProjectCheckLogo(t *testing.T) {
	dir := t.TempDir()
	logo := filepath.Join(dir, "public", "logo.svg")
	if err := os.MkdirAll(filepath.Dir(logo), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logo, []byte("<svg/>"), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := moltenProjectCheckLogo("public/logo.svg", dir)
	if err != nil || got != logo {
		t.Fatalf("relative to the project: got %q, %v", got, err)
	}
	if _, err := moltenProjectCheckLogo(filepath.Join(dir, "public", "missing.png"), dir); err == nil {
		t.Fatal("a missing image must be refused")
	}
	notes := filepath.Join(dir, "notes.txt")
	os.WriteFile(notes, []byte("x"), 0644)
	if _, err := moltenProjectCheckLogo(notes, dir); err == nil {
		t.Fatal("a file that is not an image must be refused")
	}
}

func TestFormatMoltenProjectDetails(t *testing.T) {
	status := MoltenProjectStatus{
		Linked: true,
		Project: &molten.ProjectInfo{
			Dir:    "/p",
			Name:   "p",
			Exists: true,
			Conventions: &molten.ProjectConventions{
				WorkingBranch:  "develop",
				PrTargetBranch: "develop",
				BranchNaming:   map[string]string{"fix": "fix/{N}-{description}", "feature": "feature/{N}-{description}"},
				CommitPattern:  "type(#N): description",
			},
		},
		Logos: []string{"/p/public/logo.svg"},
	}
	out := formatMoltenProjectDetails(status)
	for _, want := range []string{
		"pipeline: none yet",
		"harness: SaaSFoundryAI",
		"working branch: develop, pull requests into develop",
		"feature branches: feature/{N}-{description}\n  fix branches: fix/{N}-{description}",
		"commits: type(#N): description",
		"    /p/public/logo.svg",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	status.Logo = "/p/public/logo.svg"
	if out := formatMoltenProjectDetails(status); !strings.Contains(out, "icon: /p/public/logo.svg") {
		t.Errorf("chosen logo not shown:\n%s", out)
	}
	status.Project.Exists = false
	if out := formatMoltenProjectDetails(status); !strings.Contains(out, "no longer exists") {
		t.Errorf("missing folder not reported:\n%s", out)
	}
}
