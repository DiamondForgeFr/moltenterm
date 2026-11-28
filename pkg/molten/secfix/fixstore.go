// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// FixStore keeps the fixes of every project in one file in MoltenTerm's cache folder, never in the repository. Its lock is
// what makes one fix per set of advisories: Begin decides and claims in one step, so concurrent refreshes that see the
// same shared block start one ticket and one agent.
type FixStore struct {
	lock    sync.Mutex
	file    string
	now     func() time.Time
	changed func(dir string)
}

func MakeFixStore(file string) *FixStore {
	return &FixStore{file: file, now: time.Now}
}

// OnChange registers what is told, after each write, which project's fixes changed: the Integration list publishes again.
func (s *FixStore) OnChange(changed func(dir string)) {
	if s == nil {
		return
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	s.changed = changed
}

// UseClock replaces the clock; the tests give one.
func (s *FixStore) UseClock(now func() time.Time) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.now = now
}

func (s *FixStore) nowMs() int64 {
	return s.now().UnixMilli()
}

func (s *FixStore) readLocked() map[string][]Fix {
	all := map[string][]Fix{}
	if data, err := os.ReadFile(s.file); err == nil {
		json.Unmarshal(data, &all)
	}
	return all
}

func (s *FixStore) writeLocked(all map[string][]Fix) error {
	if err := os.MkdirAll(filepath.Dir(s.file), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// prune keeps the fixes in flight and the latest ones that ended.
func prune(fixes []Fix) []Fix {
	if len(fixes) <= maxKeptFixes {
		return fixes
	}
	sort.SliceStable(fixes, func(i, j int) bool {
		if fixes[i].Active() != fixes[j].Active() {
			return fixes[i].Active()
		}
		return fixes[i].UpdatedAt > fixes[j].UpdatedAt
	})
	return fixes[:maxKeptFixes]
}

// tell runs the change callback apart: it reads the store, whose lock the caller holds.
func (s *FixStore) tell(dir string) {
	if s.changed == nil {
		return
	}
	changed := s.changed
	go func() {
		defer func() { panichandler.PanicHandler("molten:secfix:fixchanged", recover()) }()
		changed(dir)
	}()
}

// List is the project's fixes, the oldest first.
func (s *FixStore) List(dir string) []Fix {
	if s == nil {
		return []Fix{}
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	fixes := append([]Fix{}, s.readLocked()[filepath.Clean(dir)]...)
	sort.SliceStable(fixes, func(i, j int) bool { return fixes[i].StartedAt < fixes[j].StartedAt })
	return fixes
}

// Get is the fix of a set, or false.
func (s *FixStore) Get(dir string, fingerprint string) (Fix, bool) {
	for _, fix := range s.List(dir) {
		if fix.Fingerprint == fingerprint {
			return fix, true
		}
	}
	return Fix{}, false
}

// Begin decides what the advisories call for and, when nothing stands for them, claims them with fix in the same step
// (State Waiting until the launcher moves it on). It returns the plan, and the fix that decided it, or the one claimed.
// force: the developer asks for the fix by hand, so a set held back (stopped, failed) starts again; a fix in flight or
// merged just now still covers.
func (s *FixStore) Begin(dir string, fix Fix, force bool) (string, Fix, error) {
	if s == nil {
		return "", Fix{}, errors.New("the fixes cannot be kept here")
	}
	fix.Ids = NormalizeIds(fix.Ids)
	if fix.Fingerprint == "" {
		fix.Fingerprint = Fingerprint(fix.Ids)
	}
	if fix.Fingerprint == "" {
		return "", Fix{}, errors.New("a fix needs the advisories it is for")
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	all := s.readLocked()
	key := filepath.Clean(dir)
	now := s.nowMs()
	plan, decided := PlanOf(all[key], fix.Ids, now)
	if plan == PlanHeld && force {
		plan = PlanLaunch
	}
	if plan != PlanLaunch {
		return plan, decided, nil
	}
	fix.Dir, fix.State, fix.StartedAt, fix.UpdatedAt = key, FixWaiting, now, now
	kept := all[key][:0:0]
	for _, existing := range all[key] {
		// The fix this one replaces (the same set, stopped or failed or merged): the new record stands for it.
		if existing.Fingerprint == fix.Fingerprint {
			continue
		}
		kept = append(kept, existing)
	}
	all[key] = prune(append(kept, fix))
	if err := s.writeLocked(all); err != nil {
		return "", Fix{}, err
	}
	s.tell(key)
	return PlanLaunch, fix, nil
}

// Update changes the fix of a set under the lock; change returns false to leave it as it is. The fix as it is then is
// returned, with whether it was found.
func (s *FixStore) Update(dir string, fingerprint string, change func(*Fix) bool) (Fix, bool, error) {
	if s == nil {
		return Fix{}, false, errors.New("the fixes cannot be kept here")
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	all := s.readLocked()
	key := filepath.Clean(dir)
	for i := range all[key] {
		if all[key][i].Fingerprint != fingerprint {
			continue
		}
		fix := all[key][i]
		if !change(&fix) {
			return fix, true, nil
		}
		fix.UpdatedAt = s.nowMs()
		all[key][i] = fix
		if err := s.writeLocked(all); err != nil {
			return fix, true, err
		}
		s.tell(key)
		return fix, true, nil
	}
	return Fix{}, false, nil
}

// Remove drops the fix of a set: a claim that never became a launch.
func (s *FixStore) Remove(dir string, fingerprint string) error {
	if s == nil {
		return errors.New("the fixes cannot be kept here")
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	all := s.readLocked()
	key := filepath.Clean(dir)
	kept := all[key][:0:0]
	for _, fix := range all[key] {
		if fix.Fingerprint != fingerprint {
			kept = append(kept, fix)
		}
	}
	if len(kept) == len(all[key]) {
		return nil
	}
	if len(kept) == 0 {
		delete(all, key)
	} else {
		all[key] = kept
	}
	if err := s.writeLocked(all); err != nil {
		return err
	}
	s.tell(key)
	return nil
}

// Active are the fixes of the project that are in flight.
func (s *FixStore) Active(dir string) []Fix {
	var active []Fix
	for _, fix := range s.List(dir) {
		if fix.Active() {
			active = append(active, fix)
		}
	}
	return active
}

// Dirs lists the projects that have a fix in flight.
func (s *FixStore) Dirs() []string {
	if s == nil {
		return nil
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	var dirs []string
	for dir, fixes := range s.readLocked() {
		for _, fix := range fixes {
			if fix.Active() {
				dirs = append(dirs, dir)
				break
			}
		}
	}
	sort.Strings(dirs)
	return dirs
}
