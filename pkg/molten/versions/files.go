// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package versions

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	FileFormatJson  = "json"
	FileFormatRegex = "regex"
	// A version label in a text file (README, docs, a nav config): a regular expression where {version} stands for
	// the version (#1046).
	FileFormatText = "text"

	TextVersionPlaceholder = "{version}"
)

// The version a text label holds: X.Y.Z with an optional pre-release that never ends on a dot or a dash, so the end of
// a sentence ("is 1.2.3.") stays out of it.
const textVersionRegex = `([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)`

// A file that carries the project's version (versions.files): JSON values at key paths, the one capture group of a
// pattern (e.g. Cargo's `[package]` version), or a text label around {version}. The first file holds the project's
// current version.
type VersionFile struct {
	Path   string `json:"path"`
	Format string `json:"format"`
	// json: each key path names a string value; the empty key is a key too (package-lock's packages[""]).
	Keys [][]string `json:"keys,omitempty"`
	// regex: exactly one capture group, matched exactly once in the file. text: a regular expression holding {version}
	// once and no capture group of its own, matched exactly once.
	Pattern string `json:"pattern,omitempty"`
}

// TextPattern turns a text entry's pattern into the regular expression it stands for.
func TextPattern(pattern string) (string, error) {
	if strings.Count(pattern, TextVersionPlaceholder) != 1 {
		return "", fmt.Errorf("pattern must hold %s exactly once", TextVersionPlaceholder)
	}
	before, after, _ := strings.Cut(pattern, TextVersionPlaceholder)
	re, err := regexp.Compile(before + after)
	if err != nil {
		return "", fmt.Errorf("pattern: %v", err)
	}
	if re.NumSubexp() != 0 {
		return "", fmt.Errorf("pattern must have no capture group of its own (it has %d): use (?:...)", re.NumSubexp())
	}
	return before + textVersionRegex + after, nil
}

// TextLabelPattern makes a text entry's pattern of a line around the version it holds: the line's own text, quoted,
// with the version replaced by {version}.
func TextLabelPattern(before string, after string) string {
	return regexp.QuoteMeta(before) + TextVersionPlaceholder + regexp.QuoteMeta(after)
}

type span struct {
	start int
	end   int
}

// jsonStringSpan finds the bytes of the string value at a key path, quotes excluded, so that rewriting it keeps the
// rest of the file as it was.
func jsonStringSpan(data []byte, path []string) (span, error) {
	type frame struct {
		object    bool
		expectKey bool
		key       string
		index     int
	}
	var stack []*frame
	current := func() []string {
		keys := make([]string, 0, len(stack))
		for _, f := range stack {
			if f.object {
				keys = append(keys, f.key)
			} else {
				keys = append(keys, strconv.Itoa(f.index))
			}
		}
		return keys
	}
	valueDone := func() {
		if len(stack) == 0 {
			return
		}
		top := stack[len(stack)-1]
		if top.object {
			top.expectKey = true
		} else {
			top.index++
		}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	for {
		before := int(dec.InputOffset())
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return span{}, err
		}
		if delim, ok := tok.(json.Delim); ok {
			switch delim {
			case '{':
				stack = append(stack, &frame{object: true, expectKey: true})
			case '[':
				stack = append(stack, &frame{})
			default:
				stack = stack[:len(stack)-1]
				valueDone()
			}
			continue
		}
		if len(stack) > 0 && stack[len(stack)-1].object && stack[len(stack)-1].expectKey {
			stack[len(stack)-1].key = tok.(string)
			stack[len(stack)-1].expectKey = false
			continue
		}
		if equalPath(current(), path) {
			if _, ok := tok.(string); !ok {
				return span{}, fmt.Errorf("%s is not a string", formatKeyPath(path))
			}
			end := int(dec.InputOffset())
			start := before + bytes.IndexByte(data[before:end], '"')
			return span{start: start + 1, end: end - 1}, nil
		}
		valueDone()
	}
	return span{}, fmt.Errorf("%s is missing", formatKeyPath(path))
}

func equalPath(a []string, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func formatKeyPath(path []string) string {
	data, _ := json.Marshal(path)
	return string(data)
}

func regexSpan(data []byte, pattern string) (span, error) {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return span{}, fmt.Errorf("pattern: %v", err)
	}
	if re.NumSubexp() != 1 {
		return span{}, fmt.Errorf("pattern must have exactly one capture group (it has %d)", re.NumSubexp())
	}
	matches := re.FindAllSubmatchIndex(data, -1)
	if len(matches) != 1 {
		return span{}, fmt.Errorf("pattern must match exactly once (it matches %d times)", len(matches))
	}
	return span{start: matches[0][2], end: matches[0][3]}, nil
}

// spans finds every place of the file that holds the version.
func (f VersionFile) spans(data []byte) ([]span, error) {
	switch f.Format {
	case FileFormatJson:
		if len(f.Keys) == 0 {
			return nil, errors.New("keys is empty")
		}
		var rtn []span
		for _, key := range f.Keys {
			if len(key) == 0 {
				return nil, errors.New("a key path is empty")
			}
			s, err := jsonStringSpan(data, key)
			if err != nil {
				return nil, err
			}
			rtn = append(rtn, s)
		}
		return rtn, nil
	case FileFormatRegex:
		s, err := regexSpan(data, f.Pattern)
		if err != nil {
			return nil, err
		}
		return []span{s}, nil
	case FileFormatText:
		pattern, err := TextPattern(f.Pattern)
		if err != nil {
			return nil, err
		}
		s, err := regexSpan(data, pattern)
		if err != nil {
			return nil, err
		}
		return []span{s}, nil
	}
	return nil, fmt.Errorf("format must be %q, %q or %q (got %q)", FileFormatJson, FileFormatRegex, FileFormatText, f.Format)
}

func (f VersionFile) full(dir string) string {
	return filepath.Join(dir, filepath.FromSlash(f.Path))
}

// ReadFileVersions returns the version at each place of the file, in order.
func ReadFileVersions(dir string, f VersionFile) ([]string, error) {
	data, err := os.ReadFile(f.full(dir))
	if err != nil {
		return nil, err
	}
	spans, err := f.spans(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", f.Path, err)
	}
	rtn := make([]string, 0, len(spans))
	for _, s := range spans {
		rtn = append(rtn, string(data[s.start:s.end]))
	}
	return rtn, nil
}

// ReadVersion returns the project's current version: the first place of the first file.
func ReadVersion(dir string, files []VersionFile) (string, error) {
	if len(files) == 0 {
		return "", errors.New("versions.files is empty")
	}
	values, err := ReadFileVersions(dir, files[0])
	if err != nil {
		return "", err
	}
	return values[0], nil
}

// WriteVersion writes the version at every place of every file, then reads it back from disk: a rewrite that reported
// success and changed nothing must stop the release (Notulia #714).
func WriteVersion(dir string, files []VersionFile, version string) error {
	if strings.ContainsAny(version, "\"\\\n") || version == "" {
		return fmt.Errorf("not a version: %q", version)
	}
	// Every file is rewritten in memory first: a file that cannot be read leaves the others untouched. Entries naming
	// the same file (two labels of one README) find their places in the same original text and are written together.
	var paths []string
	spansOf := map[string][]span{}
	original := map[string][]byte{}
	for _, f := range files {
		full := f.full(dir)
		data, known := original[full]
		if !known {
			read, err := os.ReadFile(full)
			if err != nil {
				return err
			}
			data = read
			original[full] = data
			paths = append(paths, full)
		}
		spans, err := f.spans(data)
		if err != nil {
			return fmt.Errorf("%s: %w", f.Path, err)
		}
		spansOf[full] = append(spansOf[full], spans...)
	}
	rewritten := map[string][]byte{}
	for _, full := range paths {
		data := append([]byte(nil), original[full]...)
		spans := spansOf[full]
		sort.Slice(spans, func(a, b int) bool { return spans[a].start < spans[b].start })
		for j := 1; j < len(spans); j++ {
			if spans[j].start < spans[j-1].end {
				return fmt.Errorf("%s: two entries point at the same text", full)
			}
		}
		// From the end, so the earlier offsets stay right.
		for j := len(spans) - 1; j >= 0; j-- {
			s := spans[j]
			data = append(data[:s.start:s.start], append([]byte(version), data[s.end:]...)...)
		}
		rewritten[full] = data
	}
	for _, full := range paths {
		info, err := os.Stat(full)
		if err != nil {
			return err
		}
		if err := os.WriteFile(full, rewritten[full], info.Mode().Perm()); err != nil {
			return err
		}
	}
	for _, f := range files {
		values, err := ReadFileVersions(dir, f)
		if err != nil {
			return err
		}
		for _, value := range values {
			if value != version {
				return fmt.Errorf("%s still says %s after writing %s", f.Path, value, version)
			}
		}
	}
	return nil
}

// CheckFile tells why a declared version file cannot be read, or nil.
func CheckFile(dir string, f VersionFile) error {
	_, err := ReadFileVersions(dir, f)
	return err
}
