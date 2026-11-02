// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package filesearch is `molten files` (FR-FILE-002, DS-FILE-002): an agent shows what it searched for in its tab's
// file panel, and gets the same matches back as text. wavesrv computes the matches (one folder read, or a bounded walk
// for a recursive search), so the command and the panel see the same list; the panel keeps the filter in its block
// meta, labelled with who set it, and the developer can edit or clear it.
package filesearch

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// must match frontend/moltenterm-shell/file-filter/file-filter.ts
const (
	// FilterMetaKey: the pattern of the panel's filter ("" or absent: no filter).
	FilterMetaKey = "molten:filefilter"
	// FilterRecursiveMetaKey: the filter lists the matches of every subfolder as one flat list.
	FilterRecursiveMetaKey = "molten:filefilterrecursive"
	// FilterDirMetaKey: the folder the filter applies to; showing another folder clears the filter.
	FilterDirMetaKey = "molten:filefilterdir"
	// FilterByMetaKey says who set the filter when it was not the user: FilterByAgent or FilterByCommand. Absent when
	// the user typed it. Written by wavesrv only.
	FilterByMetaKey = "molten:filefilterby"
	// FilterByNameMetaKey is the first name of the agent that set the filter (FR-CONT-014).
	FilterByNameMetaKey = "molten:filefilterbyname"
	// FilterPrevMetaKey holds the filter a request outside the project replaced, which Stay puts back.
	FilterPrevMetaKey = "molten:filefilterprev"
	// ShowHiddenMetaKey: the panel shows hidden files (absent: the preview:showhiddenfiles setting).
	ShowHiddenMetaKey = "molten:fileshowhidden"
	// FocusedTsMetaKey: when the panel was last focused, in Unix milliseconds; the most recent one is reused.
	FocusedTsMetaKey = "molten:filefocusedts"
	// LastPanelMetaKey, on a terminal: the file panel its last `molten files` used.
	LastPanelMetaKey = "molten:filespanel"

	FilterByAgent   = "agent"
	FilterByCommand = "command"

	RouteId       = "molten:files"
	ShowCommand   = "moltenfilesshow"
	AnswerCommand = "moltenfilesanswer"
	SearchCommand = "moltenfilessearch"

	// MaxMatches: a recursive search stops there and says the list was cut.
	MaxMatches = 1000
	// MaxPatternLen counts characters, not bytes.
	MaxPatternLen = 200

	MatchTypeDir  = "dir"
	MatchTypeFile = "file"
)

// SkippedDirs are never listed nor walked into by a recursive search.
var SkippedDirs = map[string]bool{".git": true, "node_modules": true}

// ErrBadPattern: the pattern is refused before anything is read; `molten files` exits 2 for it (bad usage).
var ErrBadPattern = errors.New("bad pattern")

// ErrRecursiveNeedsFilter: a recursive search lists the matches of a pattern, it never lists a whole tree.
var ErrRecursiveNeedsFilter = errors.New("--recursive needs --filter <pattern>")

// Match is one entry found below the searched folder. Its JSON field names are the file panel's FileInfo ones, so
// the panel lists matches as entries: Name is the path relative to the folder, Path the absolute one.
type Match struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsDir    bool   `json:"isdir,omitempty"`
	Size     int64  `json:"size,omitempty"`
	ModeStr  string `json:"modestr,omitempty"`
	ModTime  int64  `json:"modtime,omitempty"`
	MimeType string `json:"mimetype,omitempty"`
}

// IsFolder: a folder, or a link to one (the panel lists those with the folders, FR-FILE-003).
func (m Match) IsFolder() bool {
	return m.IsDir || m.MimeType == "directory"
}

type Result struct {
	Matches   []Match `json:"matches"`
	Truncated bool    `json:"truncated,omitempty"`
}

// IsGlob: a pattern holding *, ? or [ is a glob, anything else a substring.
func IsGlob(pattern string) bool {
	return strings.ContainsAny(pattern, "*?[")
}

// ValidatePattern refuses what `molten files` treats as bad usage: a pattern too long, with control characters, or a
// malformed glob.
func ValidatePattern(pattern string) error {
	if !utf8.ValidString(pattern) {
		return fmt.Errorf("%w: the pattern is not valid UTF-8", ErrBadPattern)
	}
	if n := utf8.RuneCountInString(pattern); n > MaxPatternLen {
		return fmt.Errorf("%w: the pattern has %d characters, at most %d are allowed", ErrBadPattern, n, MaxPatternLen)
	}
	for _, r := range pattern {
		if unicode.IsControl(r) {
			return fmt.Errorf("%w: the pattern holds a control character", ErrBadPattern)
		}
	}
	if IsGlob(pattern) {
		if _, err := path.Match(strings.ToLower(pattern), ""); err != nil {
			return fmt.Errorf("%w: %q is not a valid glob (a [ without its ], or a trailing \\)", ErrBadPattern, pattern)
		}
	}
	return nil
}

// MatchName: the empty pattern matches everything; a glob matches the whole name, a substring any part of it; both
// ignore case. A malformed glob matches nothing.
func MatchName(name string, pattern string) bool {
	if pattern == "" {
		return true
	}
	lname := strings.ToLower(name)
	lpattern := strings.ToLower(pattern)
	if !IsGlob(pattern) {
		return strings.Contains(lname, lpattern)
	}
	ok, err := path.Match(lpattern, lname)
	return err == nil && ok
}

func isHidden(name string) bool {
	return strings.HasPrefix(name, ".")
}

func makeMatch(full string, rel string, info fs.FileInfo) Match {
	rtn := Match{
		Name:     filepath.ToSlash(rel),
		Path:     full,
		IsDir:    info.IsDir(),
		Size:     info.Size(),
		ModeStr:  info.Mode().String(),
		ModTime:  info.ModTime().UnixMilli(),
		MimeType: fileutil.DetectMimeType(full, info, false),
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		if target, err := os.Stat(full); err == nil && target.IsDir() {
			rtn.MimeType = "directory"
		}
	}
	if rtn.IsFolder() {
		rtn.Size = -1
	}
	return rtn
}

// Search lists the entries of folder whose name matches pattern: its own entries, or with recursive every entry
// below it, skipping SkippedDirs and, unless showHidden, hidden entries and what they hold. Links are listed, never
// followed. It stops at MaxMatches. Matches come in the panel's default order (SortMatches).
func Search(folder string, pattern string, recursive bool, showHidden bool) (Result, error) {
	if err := ValidatePattern(pattern); err != nil {
		return Result{}, err
	}
	info, err := os.Stat(folder)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Result{}, fmt.Errorf("the folder %s does not exist", folder)
		}
		return Result{}, fmt.Errorf("the folder %s cannot be read: %v", folder, err)
	}
	if !info.IsDir() {
		return Result{}, fmt.Errorf("%s is not a folder", folder)
	}
	var rtn Result
	if recursive {
		rtn, err = walk(folder, pattern, showHidden)
	} else {
		rtn, err = readOne(folder, pattern, showHidden)
	}
	if err != nil {
		return Result{}, err
	}
	SortMatches(rtn.Matches)
	return rtn, nil
}

func readOne(folder string, pattern string, showHidden bool) (Result, error) {
	entries, err := os.ReadDir(folder)
	if err != nil {
		return Result{}, fmt.Errorf("the folder %s cannot be read: %v", folder, err)
	}
	rtn := Result{Matches: []Match{}}
	for _, entry := range entries {
		name := entry.Name()
		if (!showHidden && isHidden(name)) || !MatchName(name, pattern) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		rtn.Matches = append(rtn.Matches, makeMatch(filepath.Join(folder, name), name, info))
	}
	return rtn, nil
}

var errEnough = errors.New("enough matches")

func walk(folder string, pattern string, showHidden bool) (Result, error) {
	rtn := Result{Matches: []Match{}}
	err := filepath.WalkDir(folder, func(full string, d fs.DirEntry, err error) error {
		if full == folder {
			return err
		}
		if err != nil {
			// A subfolder that cannot be read is left out, the rest of the search goes on.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		name := d.Name()
		if d.IsDir() && SkippedDirs[name] {
			return fs.SkipDir
		}
		if !showHidden && isHidden(name) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !MatchName(name, pattern) {
			return nil
		}
		if len(rtn.Matches) >= MaxMatches {
			rtn.Truncated = true
			return errEnough
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(folder, full)
		if err != nil {
			return nil
		}
		rtn.Matches = append(rtn.Matches, makeMatch(full, rel, info))
		return nil
	})
	if err != nil && !errors.Is(err, errEnough) {
		return Result{}, fmt.Errorf("the folder %s cannot be read: %v", folder, err)
	}
	return rtn, nil
}

// SortMatches puts folders first, then sorts by name the way the panel does by default (FR-FILE-003): case-insensitive,
// numbers in their natural order (file2 before file10).
func SortMatches(matches []Match) {
	sort.SliceStable(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.IsFolder() != b.IsFolder() {
			return a.IsFolder()
		}
		return CompareNames(a.Name, b.Name) < 0
	})
}

// CompareNames: case-insensitive, runs of digits compared as numbers; names equal but for case in byte order.
func CompareNames(a string, b string) int {
	if cmp := compareNatural(strings.ToLower(a), strings.ToLower(b)); cmp != 0 {
		return cmp
	}
	return strings.Compare(a, b)
}

func compareNatural(a string, b string) int {
	for a != "" && b != "" {
		ra, _ := utf8.DecodeRuneInString(a)
		rb, _ := utf8.DecodeRuneInString(b)
		if isDigit(ra) && isDigit(rb) {
			da, restA := digitRun(a)
			db, restB := digitRun(b)
			if cmp := compareDigits(da, db); cmp != 0 {
				return cmp
			}
			a, b = restA, restB
			continue
		}
		if ra != rb {
			if ra < rb {
				return -1
			}
			return 1
		}
		a, b = a[utf8.RuneLen(ra):], b[utf8.RuneLen(rb):]
	}
	return len(a) - len(b)
}

func isDigit(r rune) bool {
	return r >= '0' && r <= '9'
}

func digitRun(s string) (string, string) {
	i := 0
	for i < len(s) && isDigit(rune(s[i])) {
		i++
	}
	return s[:i], s[i:]
}

func compareDigits(a string, b string) int {
	ta := strings.TrimLeft(a, "0")
	tb := strings.TrimLeft(b, "0")
	if len(ta) != len(tb) {
		return len(ta) - len(tb)
	}
	return strings.Compare(ta, tb)
}

// FilterMeta is the meta that sets a panel's filter on folder; an empty pattern clears it.
func FilterMeta(folder string, pattern string, recursive bool) waveobj.MetaMapType {
	if pattern == "" {
		return ClearFilterMeta()
	}
	return waveobj.MetaMapType{
		FilterMetaKey:          pattern,
		FilterRecursiveMetaKey: recursive,
		FilterDirMetaKey:       folder,
	}
}

func ClearFilterMeta() waveobj.MetaMapType {
	return waveobj.MetaMapType{
		FilterMetaKey:          nil,
		FilterRecursiveMetaKey: nil,
		FilterDirMetaKey:       nil,
		FilterByMetaKey:        nil,
		FilterByNameMetaKey:    nil,
	}
}

// TouchesFilterMeta tells whether a meta write sets a panel's filter or who set it.
func TouchesFilterMeta(meta waveobj.MetaMapType) bool {
	for _, key := range []string{FilterMetaKey, FilterRecursiveMetaKey, FilterDirMetaKey, FilterByMetaKey, FilterByNameMetaKey} {
		if _, ok := meta[key]; ok {
			return true
		}
	}
	return false
}

// FilterMetaFromAsker returns the meta to store for a write by someone who is not a window (isUi false): a filter it
// sets names it, whatever the write claims (an agent's first name, or the terminal). meta is never modified.
func FilterMetaFromAsker(meta waveobj.MetaMapType, isUi bool, firstName string) waveobj.MetaMapType {
	if isUi || !TouchesFilterMeta(meta) {
		return meta
	}
	rtn := make(waveobj.MetaMapType, len(meta)+2)
	for k, v := range meta {
		rtn[k] = v
	}
	rtn[FilterByMetaKey] = nil
	rtn[FilterByNameMetaKey] = nil
	if pattern, ok := rtn[FilterMetaKey].(string); ok && pattern != "" {
		rtn[FilterByMetaKey] = FilterByCommand
		if firstName != "" {
			rtn[FilterByMetaKey] = FilterByAgent
			rtn[FilterByNameMetaKey] = firstName
		}
	}
	return rtn
}
