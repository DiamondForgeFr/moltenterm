// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package materials

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A capture MoltenTerm made is kept in the data folder as a material of the project, and the project's own files are
// left as they were (#2327).
func TestAddFileKeepsTheFileAsAMaterialOfTheProject(t *testing.T) {
	t.Parallel()
	h := makeHarness(t)
	path := h.writePng("annotated-page.png", 40, 30)
	m, err := h.r.AddFile(h.project, path, "Annotated page: feature/1-a")
	if err != nil {
		t.Fatal(err)
	}
	if m.Source != molten.MaterialSourceBrought || m.Kind != molten.MaterialKindImage || m.Copy != molten.MaterialCopyKept {
		t.Fatalf("material: %+v", m)
	}
	if m.Title != "Annotated page: feature/1-a" {
		t.Errorf("title %q", m.Title)
	}
	if !strings.HasPrefix(m.CopyPath, h.root+string(filepath.Separator)) {
		t.Errorf("the copy %q is not under the materials folder %q", m.CopyPath, h.root)
	}
	if _, err := os.Stat(m.CopyPath); err != nil {
		t.Errorf("the copy is not there: %v", err)
	}
	if list := h.list(); len(list) != 1 || list[0].Id != m.Id {
		t.Errorf("the project's drawer holds %+v", list)
	}
	entries, err := os.ReadDir(h.project)
	if err != nil || len(entries) != 0 {
		t.Errorf("the project folder holds %v (%v)", entries, err)
	}
}

// What MoltenTerm never copies is not copied because a caller asked: a file of its own data folder is refused.
func TestAddFileRefusesMoltenTermsOwnData(t *testing.T) {
	t.Parallel()
	h := makeHarness(t)
	dataDir := filepath.Dir(filepath.Dir(h.root))
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	own := filepath.Join(dataDir, "annotated-page.png")
	if err := os.WriteFile(own, []byte("not a capture"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.r.AddFile(h.project, own, "Annotated page"); err == nil {
		t.Fatal("a file of MoltenTerm's own data was kept")
	}
	if list := h.list(); len(list) != 0 {
		t.Errorf("the drawer holds %+v", list)
	}
}

// A copy that was not made is an error: the brief would point to nothing.
func TestAddFileErrorsWhenNoCopyIsKept(t *testing.T) {
	t.Parallel()
	h := makeHarness(t)
	h.r.limits.RequestedCopy = 10
	path := h.writePng("annotated-page.png", 200, 200)
	if _, err := h.r.AddFile(h.project, path, "Annotated page"); err == nil {
		t.Fatal("a capture over the limit was reported as kept")
	}
}
