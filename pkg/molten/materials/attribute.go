// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package materials

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// Which project a recovered material belongs to (#1816, FR-MAT-008 AC7). Until then the search of past sessions filed
// every session found under a project's folder in that project's drawer, so a parent folder that is not a repository
// (~/Projects) held the materials of every repository under it. This puts them back in their project once, from the
// folder their session started in; a material whose project cannot be told goes to No project, never to the project it
// was found under. A material captured live keeps the workspace's project, which is the project it was produced in.

// attributedMarker, in the registry's folder, says the pass ran to its end.
const attributedMarker = ".attributed"

// A scratch folder of Claude Code is named after the folder its session started in:
// /private/tmp/claude-501/<slug>/<session>/scratchpad/….
var scratchSlugRegex = regexp.MustCompile(`(?:^|/)claude-[0-9]+/(-[^/]+)/`)

// Drawers lists every drawer on disk, even an empty one.
func (s *Store) Drawers() []molten.MaterialsProject {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.scanLocked()
	var rtn []molten.MaterialsProject
	for key, d := range s.drawers {
		rtn = append(rtn, molten.MaterialsProject{Key: key, Folder: d.folder, Name: projectName(key, d.folder)})
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].Key < rtn[j].Key })
	return rtn
}

// recoveredIn lists a drawer's materials that no live pane captured: the ones a past-session search filed.
func (s *Store) recoveredIn(key string) []molten.Material {
	s.lock.Lock()
	defer s.lock.Unlock()
	d, err := s.loadLocked(key)
	if err != nil {
		return nil
	}
	var rtn []molten.Material
	for _, m := range d.index.Materials {
		if m.WorkspaceId == "" && m.BlockId == "" && m.Agent == "" {
			rtn = append(rtn, m)
		}
	}
	return rtn
}

// moveMaterial files a material in another drawer. The target's index names it first, then its folder moves, then the
// source's index forgets it: a cut in between leaves the material in both indexes, which the next pass finishes. A
// material the target already holds under the same page or address is a duplicate: the one with a kept copy stays, the
// other goes to the trash.
func (s *Store) moveMaterial(from string, id string, to string, toFolder string) (bool, error) {
	changed, moved, err := s.moveLocked(from, id, to, toFolder)
	for _, key := range changed {
		s.changed(key, id)
	}
	return moved, err
}

func (s *Store) moveLocked(from string, id string, to string, toFolder string) ([]string, bool, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	src, err := s.loadLocked(from)
	if err != nil {
		return nil, false, err
	}
	i := findLocked(src, id)
	if i < 0 {
		return nil, false, nil
	}
	dst, err := s.loadLocked(to)
	if err != nil {
		return nil, false, err
	}
	m := src.index.Materials[i]
	if j := matchLocked(dst, m.ArtifactId, m.Link, m.Original); j >= 0 && dst.index.Materials[j].Id != id {
		dup := dst.index.Materials[j]
		if !hasCopy(m) || hasCopy(dup) {
			_, err := s.trashLocked(src, i)
			return []string{from}, err == nil, err
		}
		if _, err := s.trashLocked(dst, j); err != nil {
			return nil, false, err
		}
	}
	if findLocked(dst, id) < 0 {
		m.Project = to
		dst.index.Materials = append(dst.index.Materials, m)
		if err := s.saveLocked(dst, toFolder); err != nil {
			return nil, false, err
		}
	}
	srcItem := filepath.Join(s.drawerDir(from), itemsDir, id)
	dstItem := filepath.Join(s.drawerDir(to), itemsDir, id)
	if _, err := os.Stat(srcItem); err == nil {
		if _, err := os.Stat(dstItem); errors.Is(err, fs.ErrNotExist) {
			if err := ensureDir(filepath.Join(s.drawerDir(to), itemsDir)); err != nil {
				return nil, false, err
			}
			if err := os.Rename(srcItem, dstItem); err != nil {
				return nil, false, err
			}
		}
	}
	if i = findLocked(src, id); i >= 0 {
		src.index.Materials = append(src.index.Materials[:i:i], src.index.Materials[i+1:]...)
		if err := s.saveLocked(src, ""); err != nil {
			return nil, false, err
		}
	}
	return []string{from, to}, true, nil
}

func hasCopy(m molten.Material) bool {
	return m.Copy == molten.MaterialCopyKept && len(m.Versions) > 0
}

// AttributeRecovered runs the pass once, at start: it does nothing when it already ran to its end, or while a search
// of past sessions runs (the next start tries again).
func (r *Registry) AttributeRecovered() {
	marker := filepath.Join(r.store.Root(), attributedMarker)
	if _, err := os.Stat(marker); err == nil {
		return
	}
	if !recoverLock.TryLock() {
		return
	}
	defer recoverLock.Unlock()
	moved, complete := r.attribute(pastAgents())
	if moved > 0 {
		log.Printf("molten: %d recovered materials put back in their project\n", moved)
	}
	if !complete {
		return
	}
	if err := ensureDir(r.store.Root()); err == nil {
		r.store.writeAtomic(marker, []byte("1\n"))
	}
}

// attribute puts every recovered material of every drawer in the project of its session; it tells how many it moved
// and whether it ran to its end.
func (r *Registry) attribute(adapters []companion.Adapter) (int, bool) {
	drawers := r.store.Drawers()
	known := map[string]bool{}
	for _, d := range drawers {
		known[d.Key] = true
	}
	a := &attributor{adapters: adapters, drawers: drawers, folders: map[string]string{}}
	moved, complete := 0, true
	for _, d := range drawers {
		if d.Key == molten.MaterialsNoProject {
			continue
		}
		for _, m := range r.store.recoveredIn(d.Key) {
			to, folder := molten.MaterialsNoProject, ""
			if p, ok := a.project(m); ok && (known[p.key] || p.repo) {
				to, folder = p.key, p.root
			}
			if to == d.Key {
				continue
			}
			ok, err := r.store.moveMaterial(d.Key, m.Id, to, folder)
			if err != nil {
				log.Printf("molten: material %s not put back in its project: %v\n", m.Id, err)
				complete = false
				continue
			}
			if ok {
				moved++
			}
		}
	}
	return moved, complete
}

type attributor struct {
	adapters []companion.Adapter
	drawers  []molten.MaterialsProject
	// folders: the folder each session id started in, "" for a session whose transcript is gone.
	folders map[string]string
}

// project is the project of a material's session: by the transcript's first folder, else by the scratch folder the
// agent gave the file it published.
func (a *attributor) project(m molten.Material) (placedSession, bool) {
	if p, ok := placeSession(a.sessionFolder(m.SessionId)); ok {
		return p, true
	}
	if mm := scratchSlugRegex.FindStringSubmatch(filepath.ToSlash(m.Original)); mm != nil {
		return a.drawerOfSlug(mm[1])
	}
	return placedSession{}, false
}

func (a *attributor) sessionFolder(id string) string {
	if id == "" {
		return ""
	}
	if folder, ok := a.folders[id]; ok {
		return folder
	}
	folder := ""
	for _, adapter := range a.adapters {
		if path, ok := companion.FindPastSession(adapter, id); ok {
			if folder = companion.PastSessionFolder(adapter, path); folder != "" {
				break
			}
		}
	}
	a.folders[id] = folder
	return folder
}

// drawerOfSlug is the known drawer whose folder a Claude Code folder name continues: the folder's own slug, or for a
// repository one that starts with it (a subfolder, a worktree). The longest wins.
func (a *attributor) drawerOfSlug(slug string) (placedSession, bool) {
	best, bestLen := placedSession{}, 0
	for _, d := range a.drawers {
		if d.Folder == "" || d.Key == molten.MaterialsNoProject {
			continue
		}
		own := companion.ClaudeSlug(filepath.Clean(d.Folder))
		_, err := os.Stat(filepath.Join(d.Folder, ".git"))
		repo := err == nil
		if (slug == own || repo && strings.HasPrefix(slug, own+"-")) && len(own) > bestLen {
			best, bestLen = placedSession{key: d.Key, root: d.Folder, repo: repo}, len(own)
		}
	}
	return best, bestLen > 0
}
