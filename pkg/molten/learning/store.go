// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package learning

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity/checkpoint"
)

// The learning store on disk (FR-LRN-001, DS-LRN-001): one file per workflow, <root>/<workflow>.json, written by
// rename so a write cut at any point leaves the previous file. Folders are 0700 and files 0600. Everything a workflow
// learned stays here: nothing is sent anywhere and no workflow reads another one's file.

const (
	dirMode     = 0o700
	fileMode    = 0o600
	fileSuffix  = ".json"
	corruptMark = ".corrupt"
	fileVersion = 1
	tempPrefix  = ".learning-"
)

var keyRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

type fileData struct {
	Version int                   `json:"version"`
	Items   []molten.LearningItem `json:"items"`
}

// Store is the learning files. One lock guards the cached workflows.
type Store struct {
	root string
	lock sync.Mutex
	// Guarded by lock.
	loaded   map[string][]molten.LearningItem
	onChange func(workflow string)

	now func() time.Time
}

func MakeStore(root string) *Store {
	return &Store{root: root, loaded: map[string][]molten.LearningItem{}, now: time.Now}
}

func (s *Store) Root() string {
	return s.root
}

func (s *Store) SetOnChange(fn func(workflow string)) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.onChange = fn
}

func (s *Store) notify(workflow string) {
	s.lock.Lock()
	fn := s.onChange
	s.lock.Unlock()
	if fn != nil {
		fn(workflow)
	}
}

// ValidWorkflow refuses a workflow that does not learn, naming the ones that do.
func ValidWorkflow(workflow string) error {
	for _, known := range molten.LearningWorkflows {
		if workflow == known {
			return nil
		}
	}
	return fmt.Errorf("unknown workflow %q: the workflows that learn are %s", workflow, strings.Join(molten.LearningWorkflows, ", "))
}

func validKey(key string) error {
	if !keyRegex.MatchString(key) {
		return fmt.Errorf("bad key %q: 1 to %d characters among a-z, 0-9, dot, underscore and hyphen, starting with a letter or a digit", key, molten.LearningMaxKey)
	}
	return nil
}

func validText(what string, text string, max int) error {
	if text != strings.TrimSpace(text) {
		return fmt.Errorf("%s must not start or end with a space", what)
	}
	if len([]rune(text)) > max {
		return fmt.Errorf("%s is longer than %d characters", what, max)
	}
	for _, r := range text {
		if unicode.IsControl(r) {
			return fmt.Errorf("%s must be one line without control characters", what)
		}
	}
	if _, n := checkpoint.Redact(text); n > 0 {
		return fmt.Errorf("%s looks like a credential: a learning item never holds a secret", what)
	}
	return nil
}

func validValue(kind string, value string, proposed string) error {
	if molten.LearningHoldsValue(kind) {
		if value == "" {
			return fmt.Errorf("a %s needs a value", kind)
		}
		if err := validText("the value", value, molten.LearningMaxValue); err != nil {
			return err
		}
		return validText("the proposed value", proposed, molten.LearningMaxValue)
	}
	if value != "" || proposed != "" {
		return fmt.Errorf("a %s has no value", kind)
	}
	return nil
}

func validKind(kind string) error {
	if molten.LearningHoldsValue(kind) || kind == molten.LearningKindSkip || kind == molten.LearningKindDone {
		return nil
	}
	return fmt.Errorf("unknown kind %q: answer, preference, correction, skip or done", kind)
}

func (s *Store) path(workflow string) string {
	return filepath.Join(s.root, workflow+fileSuffix)
}

// itemsLocked returns a workflow's items, reading its file the first time. A file that does not parse is set aside
// and the workflow starts empty. The caller holds the lock.
func (s *Store) itemsLocked(workflow string) []molten.LearningItem {
	if items, ok := s.loaded[workflow]; ok {
		return items
	}
	items := s.readFile(workflow)
	s.loaded[workflow] = items
	return items
}

func (s *Store) readFile(workflow string) []molten.LearningItem {
	path := s.path(workflow)
	raw, err := os.ReadFile(path)
	if err != nil {
		return []molten.LearningItem{}
	}
	var data fileData
	if err := json.Unmarshal(raw, &data); err != nil || data.Version != fileVersion {
		_ = os.Rename(path, path+corruptMark)
		return []molten.LearningItem{}
	}
	items := []molten.LearningItem{}
	seen := map[string]bool{}
	for _, item := range data.Items {
		if !sound(item) || seen[item.Id] {
			continue
		}
		seen[item.Id] = true
		items = append(items, item)
	}
	return items
}

// sound tells whether a stored item still follows the rules; an item that does not is dropped on reading.
func sound(item molten.LearningItem) bool {
	if validKey(item.Key) != nil || item.Seen < 1 || item.Id != molten.LearningItemId(item.Kind, item.Key) {
		return false
	}
	if item.Kind == molten.LearningKindDone || validKind(item.Kind) != nil {
		return false
	}
	return validValue(item.Kind, item.Value, item.Proposed) == nil
}

func (s *Store) writeLocked(workflow string, items []molten.LearningItem) error {
	if err := os.MkdirAll(s.root, dirMode); err != nil {
		return err
	}
	if info, err := os.Lstat(s.root); err != nil || !info.IsDir() {
		return fmt.Errorf("%s is not a folder", s.root)
	}
	raw, err := json.MarshalIndent(fileData{Version: fileVersion, Items: items}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.root, tempPrefix+"*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, writeErr := tmp.Write(raw)
	closeErr := tmp.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(name)
		if writeErr != nil {
			return writeErr
		}
		return closeErr
	}
	if err := os.Chmod(name, fileMode); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Rename(name, s.path(workflow)); err != nil {
		_ = os.Remove(name)
		return err
	}
	s.loaded[workflow] = items
	return nil
}

// view stamps the confidence on a copy of the items, the most recently seen first.
func view(items []molten.LearningItem) []molten.LearningItem {
	out := make([]molten.LearningItem, len(items))
	for i, item := range items {
		item.Confidence = molten.LearningConfidenceOf(item.Seen)
		out[i] = item
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Source.At != out[j].Source.At {
			return out[i].Source.At > out[j].Source.At
		}
		return out[i].Id < out[j].Id
	})
	return out
}

func indexOf(items []molten.LearningItem, id string) int {
	for i, item := range items {
		if item.Id == id {
			return i
		}
	}
	return -1
}

// List is a workflow's items.
func (s *Store) List(workflow string) ([]molten.LearningItem, error) {
	if err := ValidWorkflow(workflow); err != nil {
		return nil, err
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	return view(s.itemsLocked(workflow)), nil
}

// ListAll is every workflow that learns, those with nothing included, in the order of molten.LearningWorkflows.
func (s *Store) ListAll() molten.LearningList {
	s.lock.Lock()
	defer s.lock.Unlock()
	list := molten.LearningList{Workflows: []molten.LearningWorkflow{}}
	for _, workflow := range molten.LearningWorkflows {
		list.Workflows = append(list.Workflows, molten.LearningWorkflow{Workflow: workflow, Items: view(s.itemsLocked(workflow))})
	}
	return list
}

// Defaults is what a workflow reads when it starts.
func (s *Store) Defaults(workflow string) (molten.LearningDefaults, error) {
	items, err := s.List(workflow)
	if err != nil {
		return molten.LearningDefaults{}, err
	}
	return molten.LearningDefaultsOf(workflow, items), nil
}

// Record remembers an adjustment. The same value again adds a sighting; another value replaces it and starts again.
// A skip adds a sighting each run; done clears the step's skip. by is who records it: the route stamps it from the
// caller.
func (s *Store) Record(workflow string, req molten.LearningRequest, by string) (molten.LearningRecorded, error) {
	if err := ValidWorkflow(workflow); err != nil {
		return molten.LearningRecorded{}, err
	}
	if err := validKind(req.Kind); err != nil {
		return molten.LearningRecorded{}, err
	}
	if err := validKey(req.Key); err != nil {
		return molten.LearningRecorded{}, err
	}
	if err := validValue(req.Kind, req.Value, req.Proposed); err != nil {
		return molten.LearningRecorded{}, err
	}
	if err := validText("the run label", req.Run, molten.LearningMaxRun); err != nil {
		return molten.LearningRecorded{}, err
	}
	recorded, err := s.record(workflow, req, by)
	if err != nil {
		return molten.LearningRecorded{}, err
	}
	s.notify(workflow)
	return recorded, nil
}

func (s *Store) record(workflow string, req molten.LearningRequest, by string) (molten.LearningRecorded, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	items := append([]molten.LearningItem{}, s.itemsLocked(workflow)...)
	if req.Kind == molten.LearningKindDone {
		at := indexOf(items, molten.LearningItemId(molten.LearningKindSkip, req.Key))
		if at < 0 {
			return molten.LearningRecorded{}, nil
		}
		items = append(items[:at], items[at+1:]...)
		if err := s.writeLocked(workflow, items); err != nil {
			return molten.LearningRecorded{}, err
		}
		return molten.LearningRecorded{Cleared: true}, nil
	}
	now := s.now().UnixMilli()
	id := molten.LearningItemId(req.Kind, req.Key)
	source := molten.LearningSource{Run: req.Run, At: now, By: by}
	at := indexOf(items, id)
	var item molten.LearningItem
	switch {
	case at < 0:
		item = molten.LearningItem{Id: id, Kind: req.Kind, Key: req.Key, Value: req.Value, Proposed: req.Proposed, Seen: 1, First: now, Source: source}
		items = append(items, item)
	case items[at].Value == req.Value:
		item = items[at]
		item.Seen++
		item.Proposed = req.Proposed
		item.Source = source
		items[at] = item
	default:
		item = items[at]
		item.Value = req.Value
		item.Proposed = req.Proposed
		item.Seen = 1
		item.Edited = false
		item.Source = source
		items[at] = item
	}
	items = trimmed(items)
	if err := s.writeLocked(workflow, items); err != nil {
		return molten.LearningRecorded{}, err
	}
	item.Confidence = molten.LearningConfidenceOf(item.Seen)
	return molten.LearningRecorded{Item: &item}, nil
}

// trimmed keeps the most recently seen items when a workflow holds more than the bound.
func trimmed(items []molten.LearningItem) []molten.LearningItem {
	if len(items) <= molten.LearningMaxItems {
		return items
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].Source.At > items[j].Source.At })
	return items[:molten.LearningMaxItems]
}

// Forget removes one item.
func (s *Store) Forget(workflow string, id string) error {
	if err := ValidWorkflow(workflow); err != nil {
		return err
	}
	if err := s.forget(workflow, id); err != nil {
		return err
	}
	s.notify(workflow)
	return nil
}

func (s *Store) forget(workflow string, id string) error {
	s.lock.Lock()
	defer s.lock.Unlock()
	items := append([]molten.LearningItem{}, s.itemsLocked(workflow)...)
	at := indexOf(items, id)
	if at < 0 {
		return fmt.Errorf("nothing learned with id %q in %s", id, workflow)
	}
	items = append(items[:at], items[at+1:]...)
	return s.writeLocked(workflow, items)
}

// Edit changes the value of an item the developer reads in the list; the sightings stay, the item is marked edited.
func (s *Store) Edit(workflow string, id string, value string) (molten.LearningItem, error) {
	if err := ValidWorkflow(workflow); err != nil {
		return molten.LearningItem{}, err
	}
	item, err := s.edit(workflow, id, value)
	if err != nil {
		return molten.LearningItem{}, err
	}
	s.notify(workflow)
	return item, nil
}

func (s *Store) edit(workflow string, id string, value string) (molten.LearningItem, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	items := append([]molten.LearningItem{}, s.itemsLocked(workflow)...)
	at := indexOf(items, id)
	if at < 0 {
		return molten.LearningItem{}, fmt.Errorf("nothing learned with id %q in %s", id, workflow)
	}
	item := items[at]
	if !molten.LearningHoldsValue(item.Kind) {
		return molten.LearningItem{}, fmt.Errorf("a %s has no value to edit: forget it instead", item.Kind)
	}
	if err := validValue(item.Kind, value, ""); err != nil {
		return molten.LearningItem{}, err
	}
	item.Value = value
	item.Edited = true
	item.Source = molten.LearningSource{Run: item.Source.Run, At: s.now().UnixMilli(), By: molten.LearningByUser}
	items[at] = item
	if err := s.writeLocked(workflow, items); err != nil {
		return molten.LearningItem{}, err
	}
	item.Confidence = molten.LearningConfidenceOf(item.Seen)
	return item, nil
}

// Reset forgets everything a workflow learned and returns how many items that was.
func (s *Store) Reset(workflow string) (int, error) {
	if err := ValidWorkflow(workflow); err != nil {
		return 0, err
	}
	n, err := s.reset(workflow)
	if err != nil {
		return 0, err
	}
	s.notify(workflow)
	return n, nil
}

func (s *Store) reset(workflow string) (int, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	n := len(s.itemsLocked(workflow))
	if n == 0 {
		return 0, nil
	}
	if err := os.Remove(s.path(workflow)); err != nil && !os.IsNotExist(err) {
		return 0, err
	}
	s.loaded[workflow] = []molten.LearningItem{}
	return n, nil
}
