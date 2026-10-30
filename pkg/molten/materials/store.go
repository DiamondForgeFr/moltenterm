// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The registry on disk (DS-MAT-001): <root>/<project>/ holds project.json, index.json, items/<id>/<version>/ (the copy
// and its linked files), items/<id>/thumb.png and .deleted/<entry>-<ms>/ (30 days). Folders are 0700, files 0600,
// and every change is made by rename: a version is built under .tmp/ and renamed into place, then the index is
// rewritten by rename, so a write cut at any point leaves an index that opens and lists only complete copies.

const (
	dirMode  = 0o700
	fileMode = 0o600

	indexFile    = "index.json"
	projectFile  = "project.json"
	itemsDir     = "items"
	deletedDir   = ".deleted"
	tmpDir       = ".tmp"
	thumbFile    = "thumb.png"
	trashRecord  = "material.json"
	indexVersion = 1
)

var (
	materialIdRegex = regexp.MustCompile(`^[0-9a-f]{16}$`)
	versionDirRegex = regexp.MustCompile(`^v[0-9]{1,4}(?:\.[0-9a-f]{6})?$`)
	trashNameRegex  = regexp.MustCompile(`^([0-9a-f]{16})(?:\.(v[0-9]{1,4}(?:\.[0-9a-f]{6})?))?-([0-9]{1,16})$`)
)

type drawerIndex struct {
	Version   int                       `json:"version"`
	Materials []molten.Material         `json:"materials"`
	WorkFiles []molten.MaterialWorkFile `json:"workfiles,omitempty"`
}

type drawer struct {
	key     string
	folder  string
	index   drawerIndex
	usage   int64
	loaded  bool
	written bool
}

// Store is the registry's files. One lock guards every drawer: copies are built outside it, under .tmp/.
type Store struct {
	root string
	lock sync.Mutex
	// Guarded by lock.
	drawers map[string]*drawer
	scanned bool

	now      func() time.Time
	onChange func(molten.MaterialsChanged)
	// killPoint is a test's way to cut a write where a crash could (it panics there).
	killPoint func(point string)
}

func MakeStore(root string) *Store {
	return &Store{root: root, drawers: map[string]*drawer{}, now: time.Now}
}

func (s *Store) Root() string {
	return s.root
}

func (s *Store) SetOnChange(fn func(molten.MaterialsChanged)) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.onChange = fn
}

func (s *Store) kill(point string) {
	if s.killPoint != nil {
		s.killPoint(point)
	}
}

func (s *Store) changed(key string, ids ...string) {
	s.lock.Lock()
	fn := s.onChange
	s.lock.Unlock()
	if fn != nil {
		fn(molten.MaterialsChanged{Project: key, Ids: ids})
	}
}

func (s *Store) drawerDir(key string) string {
	return filepath.Join(s.root, key)
}

func newId(now time.Time) string {
	var b [3]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%010x%s", now.UnixMilli()&0xffffffffff, hex.EncodeToString(b[:]))
}

func randomSuffix() string {
	var b [3]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func ensureDir(dir string) error {
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a folder", dir)
	}
	if info.Mode().Perm() != dirMode {
		return os.Chmod(dir, dirMode)
	}
	return nil
}

// writeAtomic writes a temporary file next to the target, flushed, then renames it over the target. Its cleanup is
// explicit, not deferred: a kill point cuts it where a crash would.
func (s *Store) writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	fail := func(err error) error {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Chmod(fileMode); err != nil {
		return fail(err)
	}
	s.kill("write:created")
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	s.kill("write:written")
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	s.kill("write:closed")
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// loadLocked reads a drawer's index once.
func (s *Store) loadLocked(key string) (*drawer, error) {
	if !validProjectKey(key) {
		return nil, fmt.Errorf("invalid project key")
	}
	d := s.drawers[key]
	if d != nil && d.loaded {
		return d, nil
	}
	if d == nil {
		d = &drawer{key: key}
		s.drawers[key] = d
	}
	data, err := os.ReadFile(filepath.Join(s.drawerDir(key), indexFile))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		var idx drawerIndex
		if err := json.Unmarshal(data, &idx); err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Join(s.drawerDir(key), indexFile), err)
		}
		d.index = idx
		d.written = true
	}
	var pf molten.MaterialsProject
	if data, err := os.ReadFile(filepath.Join(s.drawerDir(key), projectFile)); err == nil && json.Unmarshal(data, &pf) == nil {
		d.folder = pf.Folder
	}
	d.loaded = true
	d.usage = usageOf(d.index.Materials)
	return d, nil
}

func usageOf(list []molten.Material) int64 {
	var total int64
	for _, m := range list {
		for _, v := range m.Versions {
			total += v.Size
		}
	}
	return total
}

// scanLocked loads every drawer once, for the total usage and the list of projects.
func (s *Store) scanLocked() {
	if s.scanned {
		return
	}
	s.scanned = true
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && validProjectKey(e.Name()) {
			s.loadLocked(e.Name())
		}
	}
}

func (s *Store) totalLocked() int64 {
	s.scanLocked()
	var total int64
	for _, d := range s.drawers {
		total += d.usage
	}
	return total
}

// saveLocked writes a drawer's project.json (once, or when its folder changes) and its index.
func (s *Store) saveLocked(d *drawer, folder string) error {
	dir := s.drawerDir(d.key)
	if err := ensureDir(dir); err != nil {
		return err
	}
	if folder != "" && folder != d.folder || !d.written {
		if folder != "" {
			d.folder = folder
		}
		pf := molten.MaterialsProject{Key: d.key, Folder: d.folder, Name: projectName(d.key, d.folder)}
		data, _ := json.MarshalIndent(pf, "", "  ")
		if err := s.writeAtomic(filepath.Join(dir, projectFile), data); err != nil {
			return err
		}
	}
	d.index.Version = indexVersion
	data, err := json.MarshalIndent(d.index, "", "  ")
	if err != nil {
		return err
	}
	if err := s.writeAtomic(filepath.Join(dir, indexFile), data); err != nil {
		return err
	}
	d.written = true
	d.usage = usageOf(d.index.Materials)
	return nil
}

func projectName(key string, folder string) string {
	if key == molten.MaterialsNoProject || folder == "" {
		return ""
	}
	return filepath.Base(folder)
}

func findLocked(d *drawer, id string) int {
	for i := range d.index.Materials {
		if d.index.Materials[i].Id == id {
			return i
		}
	}
	return -1
}

// locateLocked finds a material by id, in the given drawer or in any.
func (s *Store) locateLocked(key string, id string) (*drawer, int, error) {
	if !materialIdRegex.MatchString(id) {
		return nil, -1, fmt.Errorf("invalid material id")
	}
	if key != "" {
		d, err := s.loadLocked(key)
		if err != nil {
			return nil, -1, err
		}
		if i := findLocked(d, id); i >= 0 {
			return d, i, nil
		}
		return nil, -1, fmt.Errorf("no such material")
	}
	s.scanLocked()
	for _, d := range s.drawers {
		if i := findLocked(d, id); i >= 0 {
			return d, i, nil
		}
	}
	return nil, -1, fmt.Errorf("no such material")
}

// view fills what is read when a material is shown: the copy's path, whether the original is still there.
func (s *Store) view(m molten.Material) molten.Material {
	m.Versions = append([]molten.MaterialVersion(nil), m.Versions...)
	if n := len(m.Versions); n > 0 {
		v := m.Versions[n-1]
		m.CopyPath = filepath.Join(s.drawerDir(m.Project), itemsDir, m.Id, v.Dir, v.Main)
	}
	if m.Original != "" {
		_, err := os.Stat(m.Original)
		m.OriginalGone = err != nil
	}
	return m
}

func sortMaterials(list []molten.Material) {
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Pinned != list[j].Pinned {
			return list[i].Pinned
		}
		if list[i].Updated != list[j].Updated {
			return list[i].Updated > list[j].Updated
		}
		return list[i].Id > list[j].Id
	})
}

// List is a drawer's materials, pinned first, then the most recently updated.
func (s *Store) List(key string) ([]molten.Material, error) {
	s.lock.Lock()
	d, err := s.loadLocked(key)
	var list []molten.Material
	if err == nil {
		list = append(list, d.index.Materials...)
	}
	s.lock.Unlock()
	if err != nil {
		return nil, err
	}
	rtn := make([]molten.Material, 0, len(list))
	for _, m := range list {
		rtn = append(rtn, s.view(m))
	}
	sortMaterials(rtn)
	return rtn, nil
}

func (s *Store) Get(key string, id string) (molten.Material, error) {
	s.lock.Lock()
	d, i, err := s.locateLocked(key, id)
	var m molten.Material
	if err == nil {
		m = d.index.Materials[i]
	}
	s.lock.Unlock()
	if err != nil {
		return molten.Material{}, err
	}
	return s.view(m), nil
}

// Project names a drawer.
func (s *Store) Project(key string) (molten.MaterialsProject, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	d, err := s.loadLocked(key)
	if err != nil {
		return molten.MaterialsProject{}, err
	}
	return molten.MaterialsProject{Key: key, Folder: d.folder, Name: projectName(key, d.folder)}, nil
}

// Projects lists the drawers that hold materials.
func (s *Store) Projects() []molten.MaterialsProject {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.scanLocked()
	var rtn []molten.MaterialsProject
	for key, d := range s.drawers {
		if len(d.index.Materials) == 0 {
			continue
		}
		rtn = append(rtn, molten.MaterialsProject{Key: key, Folder: d.folder, Name: projectName(key, d.folder)})
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].Key < rtn[j].Key })
	return rtn
}

// Usage is what a drawer's copies and all copies take, against the caps.
func (s *Store) Usage(key string, limits Limits) molten.MaterialsUsage {
	s.lock.Lock()
	defer s.lock.Unlock()
	var project int64
	if d, err := s.loadLocked(key); err == nil {
		project = d.usage
	}
	total := s.totalLocked()
	return molten.MaterialsUsage{Project: project, ProjectCap: limits.ProjectCap, Total: total, TotalCap: limits.TotalCap, Full: project >= limits.ProjectCap || total >= limits.TotalCap}
}

func (s *Store) update(key string, id string, fn func(m *molten.Material) bool) (molten.Material, error) {
	s.lock.Lock()
	d, i, err := s.locateLocked(key, id)
	if err != nil {
		s.lock.Unlock()
		return molten.Material{}, err
	}
	m := &d.index.Materials[i]
	if !fn(m) {
		out := *m
		s.lock.Unlock()
		return s.view(out), nil
	}
	m.Updated = s.now().UnixMilli()
	out := *m
	err = s.saveLocked(d, "")
	dkey := d.key
	s.lock.Unlock()
	if err != nil {
		return molten.Material{}, err
	}
	s.changed(dkey, id)
	return s.view(out), nil
}

// Rename gives a material the developer's title; an empty title goes back to the automatic one. Neither the original
// file nor the cloud page changes.
func (s *Store) Rename(key string, id string, title string) (molten.Material, error) {
	title = cleanTitle(title)
	return s.update(key, id, func(m *molten.Material) bool {
		if title == "" {
			if !m.Renamed {
				return false
			}
			m.Title, m.Renamed = m.AutoTitle, false
			return true
		}
		if m.Renamed && m.Title == title {
			return false
		}
		if !m.Renamed {
			m.AutoTitle = m.Title
		}
		m.Title, m.Renamed = title, true
		return true
	})
}

func (s *Store) Pin(key string, id string, pinned bool) (molten.Material, error) {
	return s.update(key, id, func(m *molten.Material) bool {
		if m.Pinned == pinned {
			return false
		}
		m.Pinned = pinned
		return true
	})
}

// DeleteCopy moves a material and its copy to the trash, where Undo (Restore) finds it for 30 days. Order: the record
// is written next to the copy, the index forgets the material, then the folder moves; a cut in between leaves a folder
// the next start moves to the trash.
func (s *Store) DeleteCopy(key string, id string) (string, error) {
	s.lock.Lock()
	d, i, err := s.locateLocked(key, id)
	if err != nil {
		s.lock.Unlock()
		return "", err
	}
	m := d.index.Materials[i]
	dir := s.drawerDir(d.key)
	item := filepath.Join(dir, itemsDir, id)
	trashId := fmt.Sprintf("%s-%d", id, s.now().UnixMilli())
	err = func() error {
		if err := ensureDir(item); err != nil {
			return err
		}
		data, _ := json.MarshalIndent(m, "", "  ")
		if err := s.writeAtomic(filepath.Join(item, trashRecord), data); err != nil {
			return err
		}
		d.index.Materials = append(d.index.Materials[:i:i], d.index.Materials[i+1:]...)
		if err := s.saveLocked(d, ""); err != nil {
			return err
		}
		s.kill("delete:indexed")
		if err := ensureDir(filepath.Join(dir, deletedDir)); err != nil {
			return err
		}
		return os.Rename(item, filepath.Join(dir, deletedDir, trashId))
	}()
	dkey := d.key
	s.lock.Unlock()
	if err != nil {
		return "", err
	}
	s.changed(dkey, id)
	return trashId, nil
}

// Restore brings a deleted material back from the trash (Undo).
func (s *Store) Restore(key string, trashId string) (molten.Material, error) {
	m := trashNameRegex.FindStringSubmatch(trashId)
	if m == nil || m[2] != "" {
		return molten.Material{}, fmt.Errorf("invalid trash id")
	}
	id := m[1]
	s.lock.Lock()
	var d *drawer
	var err error
	if key != "" {
		d, err = s.loadLocked(key)
	} else {
		s.scanLocked()
		for k, cand := range s.drawers {
			if _, statErr := os.Stat(filepath.Join(s.drawerDir(k), deletedDir, trashId)); statErr == nil {
				d = cand
				break
			}
		}
		if d == nil {
			err = fmt.Errorf("no such deleted material")
		}
	}
	if err != nil {
		s.lock.Unlock()
		return molten.Material{}, err
	}
	dir := s.drawerDir(d.key)
	entry := filepath.Join(dir, deletedDir, trashId)
	var rec molten.Material
	err = func() error {
		data, err := os.ReadFile(filepath.Join(entry, trashRecord))
		if err != nil {
			return fmt.Errorf("no such deleted material")
		}
		if err := json.Unmarshal(data, &rec); err != nil || rec.Id != id {
			return fmt.Errorf("the deleted material cannot be read")
		}
		if findLocked(d, id) >= 0 {
			return fmt.Errorf("the material is already there")
		}
		if err := ensureDir(filepath.Join(dir, itemsDir)); err != nil {
			return err
		}
		if err := os.Rename(entry, filepath.Join(dir, itemsDir, id)); err != nil {
			return err
		}
		os.Remove(filepath.Join(dir, itemsDir, id, trashRecord))
		d.index.Materials = append(d.index.Materials, rec)
		return s.saveLocked(d, "")
	}()
	dkey := d.key
	s.lock.Unlock()
	if err != nil {
		return molten.Material{}, err
	}
	s.changed(dkey, id)
	return s.view(rec), nil
}

// WorkFiles lists a drawer's work files whose file still exists (no ghost line once a restart emptied a folder).
func (s *Store) WorkFiles(key string) ([]molten.MaterialWorkFile, error) {
	s.lock.Lock()
	d, err := s.loadLocked(key)
	var list []molten.MaterialWorkFile
	if err == nil {
		list = append(list, d.index.WorkFiles...)
	}
	s.lock.Unlock()
	if err != nil {
		return nil, err
	}
	rtn := make([]molten.MaterialWorkFile, 0, len(list))
	for _, w := range list {
		if info, err := os.Stat(w.Path); err == nil && info.Mode().IsRegular() {
			w.Size = info.Size()
			rtn = append(rtn, w)
		}
	}
	sort.SliceStable(rtn, func(i, j int) bool { return rtn[i].At > rtn[j].At })
	return rtn, nil
}

// Sweep cleans what a cut write left (.tmp/, version folders and items the index does not name) and empties the
// trash of what it kept longer than the trash keeps.
func (s *Store) Sweep(keep time.Duration) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.scanLocked()
	now := s.now()
	for key, d := range s.drawers {
		dir := s.drawerDir(key)
		os.RemoveAll(filepath.Join(dir, tmpDir))
		removePartials(dir)
		known := map[string]map[string]bool{}
		for _, m := range d.index.Materials {
			dirs := map[string]bool{}
			for _, v := range m.Versions {
				dirs[v.Dir] = true
			}
			known[m.Id] = dirs
		}
		items, _ := os.ReadDir(filepath.Join(dir, itemsDir))
		for _, e := range items {
			if !e.IsDir() || !materialIdRegex.MatchString(e.Name()) {
				continue
			}
			item := filepath.Join(dir, itemsDir, e.Name())
			dirs, ok := known[e.Name()]
			if !ok {
				// A delete cut after the index was written: finish it, into the trash.
				if _, err := os.Stat(filepath.Join(item, trashRecord)); err == nil {
					ensureDir(filepath.Join(dir, deletedDir))
					os.Rename(item, filepath.Join(dir, deletedDir, fmt.Sprintf("%s-%d", e.Name(), now.UnixMilli())))
				} else {
					os.RemoveAll(item)
				}
				continue
			}
			removePartials(item)
			versions, _ := os.ReadDir(item)
			for _, v := range versions {
				if v.IsDir() && versionDirRegex.MatchString(v.Name()) && !dirs[v.Name()] {
					os.RemoveAll(filepath.Join(item, v.Name()))
				}
			}
		}
		trash, _ := os.ReadDir(filepath.Join(dir, deletedDir))
		for _, e := range trash {
			m := trashNameRegex.FindStringSubmatch(e.Name())
			if m == nil {
				continue
			}
			at, err := strconv.ParseInt(m[3], 10, 64)
			if err != nil || now.Sub(time.UnixMilli(at)) <= keep {
				continue
			}
			os.RemoveAll(filepath.Join(dir, deletedDir, e.Name()))
		}
	}
}

// removePartials removes the temporary files a cut atomic write left in a folder.
func removePartials(dir string) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !e.IsDir() && len(e.Name()) > 5 && e.Name()[:5] == ".tmp-" {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// trashVersionLocked moves a pruned version to the trash.
func (s *Store) trashVersionLocked(key string, id string, v molten.MaterialVersion) {
	dir := s.drawerDir(key)
	if err := ensureDir(filepath.Join(dir, deletedDir)); err != nil {
		return
	}
	os.Rename(filepath.Join(dir, itemsDir, id, v.Dir), filepath.Join(dir, deletedDir, fmt.Sprintf("%s.%s-%d", id, v.Dir, s.now().UnixMilli())))
}
