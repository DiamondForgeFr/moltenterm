// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

// The folders of the Brainstorms widget (FR-BOSS-010 AC10, AC10a to AC10d, DS-BOSS-010, #2248): the list, the same or a
// near-identical title, rename and forget. A window names a brainstorm by its slug alone, and only a slug of the
// pattern MoltenTerm makes that is a folder right under the brainstorms folder reaches a path: never a title, never a
// path a window or a model wrote.

// slugPattern: what Slug makes, with the "-<n>" Create adds to keep it unique.
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,55}$`)

// ErrUnknownBrainstorm: no brainstorm of the brainstorms folder has that slug.
var ErrUnknownBrainstorm = errors.New("no such brainstorm")

// dirOf is the folder of the brainstorm whose slug this is: a real folder (not a link) right under the brainstorms
// folder, holding a brainstorm.json.
func (s *Store) dirOf(slug string) (string, error) {
	if !slugPattern.MatchString(slug) {
		return "", ErrUnknownBrainstorm
	}
	root := s.root()
	if root == "" {
		return "", errors.New("no brainstorms folder")
	}
	dir := filepath.Join(root, slug)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return "", ErrUnknownBrainstorm
	}
	if file, err := os.Lstat(filepath.Join(dir, InfoFile)); err != nil || !file.Mode().IsRegular() {
		return "", ErrUnknownBrainstorm
	}
	return dir, nil
}

// LoadSlug reads back the brainstorm of that slug.
func (s *Store) LoadSlug(slug string) (Saved, error) {
	dir, err := s.dirOf(slug)
	if err != nil {
		return Saved{}, err
	}
	return s.Load(dir)
}

// checkedId is a brainstorm's id as MoltenTerm writes it, "" for one changed by hand into anything else: it never
// reaches his resume brief or a reference, and a forget then names the folder by its slug and "".
func checkedId(id string) string {
	if !refPattern.MatchString(id) {
		return ""
	}
	return id
}

func summaryOf(dir string, info Info, turns int) Summary {
	return Summary{
		Id: checkedId(info.Id),
		// The folder's own name, never made again from it: Slug cuts at 48 letters, which would drop the "-2" of a second
		// folder whose title starts like the first (review of #2248).
		Slug:       filepath.Base(dir),
		Title:      cutText(CleanText(info.Title), MaxText),
		Dir:        dir,
		Created:    info.Created,
		Updated:    info.Updated,
		State:      checkedState(info.State),
		Turns:      turns,
		PromotedTo: checkedPromotion(info.PromotedTo),
	}
}

// List is every brainstorm of the brainstorms folder, the one changed last first. A folder whose brainstorm.json does
// not read is not one of them.
func (s *Store) List() ([]Summary, error) {
	root := s.root()
	if root == "" {
		return []Summary{}, nil
	}
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return []Summary{}, nil
	}
	if err != nil {
		return nil, err
	}
	rtn := []Summary{}
	for _, entry := range entries {
		if !entry.IsDir() || !slugPattern.MatchString(entry.Name()) {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		data, err := os.ReadFile(filepath.Join(dir, InfoFile))
		if err != nil {
			continue
		}
		var info Info
		if json.Unmarshal(data, &info) != nil || CleanText(info.Title) == "" {
			continue
		}
		rtn = append(rtn, summaryOf(dir, info, 0))
	}
	sort.SliceStable(rtn, func(i, j int) bool {
		if rtn[i].Updated != rtn[j].Updated {
			return rtn[i].Updated > rtn[j].Updated
		}
		return rtn[i].Slug < rtn[j].Slug
	})
	return rtn, nil
}

var numberSuffix = regexp.MustCompile(`-[0-9]+$`)

// editDistance counts the letters to change, add or drop to make a into b.
func editDistance(a string, b string) int {
	prev := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur := make([]int, len(b)+1)
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(b)]
}

// NearTitle: two titles name the same idea, or nearly (AC10a): the same slug, the same once a folder's "-<n>" is left
// out, or a slug of at least 8 letters two letters away (a typo, a plural).
func NearTitle(a string, b string) bool {
	sa := numberSuffix.ReplaceAllString(Slug(a), "")
	sb := numberSuffix.ReplaceAllString(Slug(b), "")
	// A title of letters no slug spells (日本語) has the fallback slug: only the same words name the same idea.
	if Slug(a) == fallbackSlug || Slug(b) == fallbackSlug {
		return strings.EqualFold(CleanText(a), CleanText(b))
	}
	if sa == sb {
		return true
	}
	if len(sa) < 8 || len(sb) < 8 {
		return false
	}
	return editDistance(sa, sb) <= 2
}

// Find is the brainstorm whose title is title, or nearly; the one changed last when several are.
func (s *Store) Find(title string) (Summary, bool, error) {
	if CleanText(title) == "" {
		return Summary{}, false, nil
	}
	list, err := s.List()
	if err != nil {
		return Summary{}, false, err
	}
	for _, entry := range list {
		if NearTitle(entry.Title, title) {
			return entry, true, nil
		}
	}
	return Summary{}, false, nil
}

// Rename gives the brainstorm the developer's title and moves its folder to the title's free slug. The title stays the
// developer's: the centre's text no longer replaces it. A rename that fails once the folder moved moves it back; the
// Saved it returns names the folder where it is, even with an error, so the open brainstorm keeps following it.
func (s *Store) Rename(slug string, title string, now int64) (Saved, error) {
	saved, err := s.LoadSlug(slug)
	if err != nil {
		return Saved{}, err
	}
	clean, err := checkText(title, "title")
	if err != nil {
		return Saved{}, err
	}
	from := saved.Dir
	base := Slug(clean)
	if base != slug && base != numberSuffix.ReplaceAllString(slug, "") {
		dir, newSlug, err := s.moveTo(saved.Dir, base)
		if err != nil {
			return saved, err
		}
		saved.Dir = dir
		saved.Info.Slug = newSlug
	}
	saved.Info.Title = clean
	saved.Info.Named = true
	saved.Info.Updated = now
	err = s.followMove(from, saved.Dir)
	if err == nil {
		err = s.Save(saved)
	}
	if err == nil || saved.Dir == from {
		return saved, err
	}
	return s.moveBack(saved, from, slug, err)
}

// moveBack puts a folder back where it was after a rename that failed, current.json with it. When it cannot, the Saved
// still names where the folder is.
func (s *Store) moveBack(saved Saved, from string, slug string, cause error) (Saved, error) {
	if err := os.Rename(saved.Dir, from); err != nil {
		_ = s.followMove(from, saved.Dir)
		return saved, cause
	}
	_ = s.followMove(saved.Dir, from)
	back, err := s.Load(from)
	if err != nil {
		back = saved
		back.Dir = from
		back.Info.Slug = slug
	}
	return back, cause
}

// moveTo moves a folder to the first free "<base>" or "<base>-<n>" of the brainstorms folder. The new name is taken
// first with an exclusive Mkdir, then the folder is renamed over that empty folder, so two moves never share a name and
// no folder of the developer is ever replaced.
func (s *Store) moveTo(from string, base string) (string, string, error) {
	root := s.root()
	for n := 1; n <= maxSlugTries; n++ {
		slug := base
		if n > 1 {
			slug = fmt.Sprintf("%s-%d", base, n)
		}
		dir := filepath.Join(root, slug)
		err := os.Mkdir(dir, 0o700)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", "", err
		}
		// syscall's rename, not os.Rename: os refuses any existing folder as the target, and the system's call replaces
		// the empty one just made, in one step.
		if err := syscall.Rename(from, dir); err != nil {
			_ = os.Remove(dir)
			return "", "", err
		}
		return dir, slug, nil
	}
	return "", "", fmt.Errorf("no free folder name for %q", base)
}

// followMove keeps current.json on a brainstorm whose folder moved.
func (s *Store) followMove(from string, to string) error {
	if s.currentDir() != from {
		return nil
	}
	return s.Remember(to)
}

func (s *Store) currentDir() string {
	data, err := os.ReadFile(filepath.Join(s.stateDir, currentFile))
	if err != nil {
		return ""
	}
	var cur current
	if json.Unmarshal(data, &cur) != nil {
		return ""
	}
	return cur.Dir
}

// Deleted is what a forget did: the folder went to the trash, or was removed for good where the system has none.
type Deleted struct {
	Summary Summary
	Trashed bool
}

// ErrNeedsRemoveConfirmation: the system has no trash, and the developer's confirmation did not say the folder is
// removed for good.
var ErrNeedsRemoveConfirmation = errors.New("no trash: removing for good needs its own confirmation")

// CanTrash: a forgotten folder goes to the system trash. When false the confirmation says it is removed for good.
func (s *Store) CanTrash() bool {
	return s.trash != nil && (s.canTrash == nil || s.canTrash())
}

// Delete forgets a brainstorm (AC10d), named by its slug and its id, both from the confirmation the developer answered:
// a slug that now names another brainstorm takes nothing. Its folder goes to the system trash; a move that fails keeps
// it where it was and says why, and is never followed by a removal. Where the system has no trash, the folder is removed
// for good only when the confirmation said so (permanent). current.json lets go of it.
func (s *Store) Delete(slug string, id string, permanent bool) (Deleted, error) {
	dir, err := s.dirOf(slug)
	if err != nil {
		return Deleted{}, err
	}
	data, err := os.ReadFile(filepath.Join(dir, InfoFile))
	if err != nil {
		return Deleted{}, err
	}
	var info Info
	_ = json.Unmarshal(data, &info)
	rtn := Deleted{Summary: summaryOf(dir, info, 0)}
	if rtn.Summary.Id != id {
		return Deleted{}, ErrUnknownBrainstorm
	}
	if s.CanTrash() {
		if _, err := s.trash(dir); err != nil {
			return Deleted{}, fmt.Errorf("the folder could not be moved to the trash: %w", err)
		}
		rtn.Trashed = true
	} else {
		if !permanent {
			return Deleted{}, ErrNeedsRemoveConfirmation
		}
		if err := os.RemoveAll(dir); err != nil {
			return Deleted{}, err
		}
	}
	if s.currentDir() == dir {
		if err := os.Remove(filepath.Join(s.stateDir, currentFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return rtn, err
		}
	}
	return rtn, nil
}

// Titles are the brainstorms' titles, the one changed last first, at most max: what Brokk's brief lists, the titles
// alone and never what a folder holds.
func (s *Store) Titles(max int) []string {
	list, err := s.List()
	if err != nil {
		return nil
	}
	rtn := []string{}
	seen := map[string]bool{}
	for _, entry := range list {
		key := strings.ToLower(entry.Title)
		if entry.Title == "" || seen[key] {
			continue
		}
		seen[key] = true
		rtn = append(rtn, entry.Title)
		if len(rtn) == max {
			break
		}
	}
	return rtn
}
