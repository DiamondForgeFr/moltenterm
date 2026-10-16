// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type admissionKey struct {
	project string
	kind    string
}

type runAdmission struct {
	title string
}

// Trust remains attached to the requested path; admission follows the actual project.
func canonicalRunDir(dir string) string {
	dir = filepath.Clean(dir)
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		return real
	}
	return dir
}

func (rec RunRecord) storageProject() string {
	if rec.project != "" {
		return rec.project
	}
	return canonicalRunDir(rec.Dir)
}

// Reserve only initialization, then let the durable record enforce the existing per-kind running rule. No lookup,
// process launch or subscriber runs under the map lock, and unrelated projects/kinds never wait for each other.
func (r *Runs) reserveAdmission(dir, kind, title string) (func(), string) {
	key := admissionKey{project: canonicalRunDir(dir), kind: kind}
	if title == "" {
		title = dir
	}
	r.lock.Lock()
	defer r.lock.Unlock()
	if held := r.admitting[key]; held != nil {
		return nil, held.title
	}
	if r.admitting == nil {
		r.admitting = make(map[admissionKey]*runAdmission)
	}
	owner := &runAdmission{title: title}
	r.admitting[key] = owner
	return func() { r.releaseAdmission(key, owner) }, ""
}

const runProjectFile = "project.json"

// Keep the historical storage keys. Older run records identify alias directories, while this small identity
// also identifies new release sessions that have no preparation run. An old session alone cannot identify an
// unknown alias: its hashed folder contains no project path until that original path is opened again.
func (r *Runs) projectDirs(dir string) []string {
	return r.projectDirsAt(dir, canonicalRunDir(dir))
}

func (r *Runs) projectDirsAt(dir, project string) []string {
	r.lock.Lock()
	cached := r.projectStorage[project]
	r.lock.Unlock()
	if cached != nil {
		return cached
	}
	primary := filepath.Join(r.baseDir, projectKey(dir))
	if identity := r.storedProject(primary); identity != "" && identity != project {
		// A symlink now targets a different project. Never reuse its previous project's folder.
		primary = filepath.Join(r.baseDir, projectKey(project))
	}
	dirs := []string{primary}
	entries, _ := os.ReadDir(r.baseDir)
	for _, entry := range entries {
		candidate := filepath.Join(r.baseDir, entry.Name())
		if !entry.IsDir() || candidate == primary {
			continue
		}
		if r.storedProject(candidate) == project {
			dirs = append(dirs, candidate)
		}
	}
	// Prefer an existing history for new writes, without hiding any other history of the same project.
	if _, err := os.Stat(primary); os.IsNotExist(err) && len(dirs) > 1 {
		dirs[0], dirs[1] = dirs[1], dirs[0]
	}
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.projectStorage == nil {
		r.projectStorage = make(map[string][]string)
	}
	if cached = r.projectStorage[project]; cached != nil {
		return cached
	}
	r.projectStorage[project] = dirs
	return dirs
}

func (r *Runs) storedProject(dir string) string {
	var project string
	if data, err := os.ReadFile(filepath.Join(dir, runProjectFile)); err == nil && json.Unmarshal(data, &project) == nil {
		return project
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		var rec RunRecord
		data, err := os.ReadFile(filepath.Join(dir, entry.Name(), RunFileName))
		if err == nil && json.Unmarshal(data, &rec) == nil && filepath.IsAbs(rec.Dir) {
			return canonicalRunDir(rec.Dir)
		}
	}
	return ""
}

func (r *Runs) identifyProject(dir string) error {
	storage := r.projectDir(dir)
	project := canonicalRunDir(dir)
	if r.storedProjectIdentity(storage) == project {
		return nil
	}
	if err := os.MkdirAll(storage, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(project)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(storage, ".project-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(storage, runProjectFile))
}

func (r *Runs) storedProjectIdentity(dir string) string {
	var project string
	data, err := os.ReadFile(filepath.Join(dir, runProjectFile))
	if err == nil && json.Unmarshal(data, &project) == nil {
		return project
	}
	return ""
}

func (r *Runs) recordDir(dir, id string) string {
	for _, storage := range r.projectDirs(dir) {
		candidate := filepath.Join(storage, id)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return filepath.Join(r.projectDir(dir), id)
}

func (r *Runs) releaseAdmission(key admissionKey, owner *runAdmission) {
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.admitting[key] == owner {
		delete(r.admitting, key)
	}
}
