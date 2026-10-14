// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// The explanation contract (FR-REV-007, DS-REV-006) is the review guide's; MoltenTerm checks what it can before a card
// is kept: a quick answer names one principle at most, every answer lists its sources, and the other uses it cites
// are lines that exist in the worktree, so each one opens the file at its line.

const (
	questionNote = "Answer in the depth above, following the review guide's explanation contract (Explanations), " +
		"in developerlanguage, then post it with review_post_explanation."
	// A related file larger than this is not read to count its lines; its existence is enough.
	maxRelatedScan = 4 << 20
	maxRelated     = 20
)

// relatedPattern: path:line or path:start-end; the path has no spaces, no scheme and no drive letter.
var relatedPattern = regexp.MustCompile(`^([^\s:]+):([0-9]+)(?:-([0-9]+))?$`)

// askedDepth is the depth of the question the session's selection holds, quick without one: an answer posted without
// a depth takes it, and so does a follow-up the developer types in the terminal.
func (m *Manager) askedDepth(s *session) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	if s.selection == nil || s.selection.Comment != nil {
		return mcpreview.DepthQuick
	}
	return normalDepth(s.selection.Depth)
}

// checkExplanation checks an explanation's depth against its principles and that it lists its sources.
func checkExplanation(depth string, principles []string, sources []string) error {
	if depth == mcpreview.DepthQuick && len(nonEmpty(principles)) > 1 {
		return fmt.Errorf("%s", mcpreview.ErrQuickPrinciples)
	}
	if len(nonEmpty(sources)) == 0 {
		return fmt.Errorf("%s", mcpreview.ErrSourcesNeeded)
	}
	return nil
}

func nonEmpty(list []string) []string {
	var rtn []string
	for _, s := range list {
		if s = strings.TrimSpace(s); s != "" {
			rtn = append(rtn, s)
		}
	}
	return rtn
}

type relatedRef struct {
	path  string
	start int
	end   int
}

// parseRelated reads one related entry; a leading "./" is dropped.
func parseRelated(entry string) (relatedRef, bool) {
	m := relatedPattern.FindStringSubmatch(strings.TrimPrefix(strings.TrimSpace(entry), "./"))
	if m == nil {
		return relatedRef{}, false
	}
	path := filepath.ToSlash(filepath.Clean(m[1]))
	if filepath.IsAbs(m[1]) || path == "." || path == ".." || strings.HasPrefix(path, "../") {
		return relatedRef{}, false
	}
	start, err := strconv.Atoi(m[2])
	if err != nil || start <= 0 {
		return relatedRef{}, false
	}
	end := start
	if m[3] != "" {
		end, err = strconv.Atoi(m[3])
		if err != nil || end < start {
			return relatedRef{}, false
		}
	}
	return relatedRef{path: path, start: start, end: end}, true
}

// checkRelated normalises the other uses an explanation cites and checks each against the worktree: the file exists
// there and has the line. With no worktree (it was removed), only the form is checked.
func checkRelated(worktree string, related []string) ([]string, error) {
	var rtn []string
	for _, entry := range nonEmpty(related) {
		ref, ok := parseRelated(entry)
		if !ok {
			return nil, fmt.Errorf(mcpreview.ErrRelatedFormat, entry)
		}
		if worktree != "" && !hasLine(filepath.Join(worktree, filepath.FromSlash(ref.path)), ref.end) {
			return nil, fmt.Errorf(mcpreview.ErrRelatedMissing, entry)
		}
		norm := ref.path + ":" + strconv.Itoa(ref.start)
		if ref.end != ref.start {
			norm += "-" + strconv.Itoa(ref.end)
		}
		rtn = append(rtn, norm)
	}
	if len(rtn) > maxRelated {
		rtn = rtn[:maxRelated]
	}
	return rtn, nil
}

// hasLine says whether the file exists, is a regular file, and has at least line lines (not counted past
// maxRelatedScan).
func hasLine(path string, line int) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if info.Size() > maxRelatedScan {
		return true
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	count := bytes.Count(data, []byte{'\n'})
	if len(data) > 0 && data[len(data)-1] != '\n' {
		count++
	}
	return count >= line
}
