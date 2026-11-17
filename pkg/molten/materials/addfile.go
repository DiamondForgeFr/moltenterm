// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package materials

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// AddFile keeps a file MoltenTerm made itself for the developer (the capture of a page the developer annotated, #2327)
// as a material of the drawer of projectDir ("" gives No project): it is copied under MoltenTerm's data folder, which
// is where the agents are pointed to and where the developer finds it in the library, never in the project. The file
// is read from wherever the caller wrote it, which is not MoltenTerm's data folder (that is never copied), and the
// caller removes it afterwards. The same file given again, from another place, is the material already kept: the
// registry recognises a file by where it came from, which a caller writing into a fresh private folder each time never
// repeats. A copy that was not made (too large, the drawer is full) is an error: the caller would point an agent to
// nothing.
func (r *Registry) AddFile(projectDir string, path string, title string) (molten.Material, error) {
	key, folder := ProjectKey(projectDir)
	if m, ok := r.keptBroughtCopy(key, path); ok {
		return m, nil
	}
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

// keptBroughtCopy is the material of the drawer whose current copy holds exactly this file: a version is named by the
// fingerprint of its main file's name and bytes (buildVersion), computed here the same way.
func (r *Registry) keptBroughtCopy(key string, path string) (molten.Material, bool) {
	want, err := fileFingerprint(path)
	if err != nil {
		return molten.Material{}, false
	}
	list, err := r.store.List(key)
	if err != nil {
		return molten.Material{}, false
	}
	for _, m := range list {
		if m.Source != molten.MaterialSourceBrought || m.Copy != molten.MaterialCopyKept || m.CopyPath == "" || len(m.Versions) == 0 {
			continue
		}
		if m.Versions[len(m.Versions)-1].Hash != want {
			continue
		}
		if _, err := os.Stat(m.CopyPath); err == nil {
			return m, true
		}
	}
	return molten.Material{}, false
}

func fileFingerprint(path string) (string, error) {
	in, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer in.Close()
	h := sha256.New()
	io.WriteString(h, filepath.ToSlash(filepath.Base(path))+"\x00")
	if _, err := io.Copy(h, in); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil))[:32], nil
}
