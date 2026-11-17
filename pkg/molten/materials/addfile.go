// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package materials

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// AddFile keeps a file MoltenTerm made itself for the developer (the capture of a page the developer annotated, #2327)
// as a material of the drawer of projectDir ("" gives No project): it is copied under MoltenTerm's data folder, which
// is where the agents are pointed to and where the developer finds it in the library, never in the project. The file
// is read from wherever the caller wrote it, which is not MoltenTerm's data folder (that is never copied), and the
// caller removes it afterwards. A copy that was not made (too large, the drawer is full) is an error: the caller would
// point an agent to nothing.
func (r *Registry) AddFile(projectDir string, path string, title string) (molten.Material, error) {
	key, folder := ProjectKey(projectDir)
	m, _, err := r.capture(Capture{
		Project: key, Folder: folder, Source: molten.MaterialSourceBrought, Path: path, ToolTitle: title, Requested: true,
	})
	if err != nil {
		return molten.Material{}, err
	}
	if m.Copy != molten.MaterialCopyKept || m.CopyPath == "" {
		return molten.Material{}, fmt.Errorf("the copy was not kept (%s)", m.Copy)
	}
	return m, nil
}
