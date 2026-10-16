// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Review comments (FR-REV-003, DS-REV-003, DS-REV-007): a comment is anchored where GitHub's review comment API puts
// it (path, side, start_line, line) on the head it was written on, so publication needs no conversion. A selection
// inside one hunk of its side takes a line comment; elsewhere the comment is file-level and quotes the lines. When the
// PR's head moves, each anchor is searched by its excerpt near its old line: found, it moves; not found, it is
// outdated and keeps its excerpt. The drafting, the translation and the publication fill the other states (FR-REV-009,
// FR-REV-010).

const (
	SubjectLine = "line"
	SubjectFile = "file"

	CommentStateDraft      = "draft"
	CommentStateStaged     = "staged"
	CommentStateTranslated = "translated"
	CommentStatePublished  = "published"
	CommentStateDropped    = "dropped"
	// Proposed: a comment the review session's agent proposed (FR-REV-009 AC3), not the developer's until accepted.
	CommentStateProposed = "proposed"

	CommentKindComment = "comment"
	CommentKindChange  = "change"

	AuthorDeveloper = "developer"
	AuthorAgent     = "agent"
	// AuthorAcceptedProposal: an agent's proposal the developer accepted (DS-REV-007).
	AuthorAcceptedProposal = "agent-proposal-accepted"

	maxCommentBytes = 64 << 10
	maxComments     = 500
	hunkContext     = mcpreview.HunkContext
)

type Hunk = mcpreview.Hunk

// ParseHunks reads the hunk headers of a unified diff.
func ParseHunks(out []byte) []Hunk {
	return mcpreview.ParseHunks(out)
}

// hunksOf: an added or deleted file is one hunk of all its lines; otherwise git's diff of the two blobs.
func hunksOf(ctx context.Context, git func(ctx context.Context, args ...string) ([]byte, error), oldBlob string, newBlob string, oldLines int, newLines int) []Hunk {
	switch {
	case oldBlob == newBlob:
		return nil
	case oldBlob == "":
		if newLines == 0 {
			return nil
		}
		return []Hunk{{NewStart: 1, NewLines: newLines}}
	case newBlob == "":
		if oldLines == 0 {
			return nil
		}
		return []Hunk{{OldStart: 1, OldLines: oldLines}}
	}
	out, err := git(ctx, "diff", "--no-color", "--no-ext-diff", "-U"+strconv.Itoa(hunkContext), oldBlob, newBlob)
	if err != nil {
		return nil
	}
	return ParseHunks(out)
}

func (d *Differ) hunks(ctx context.Context, req FileRequest, oldLines int, newLines int) []Hunk {
	git := func(ctx context.Context, args ...string) ([]byte, error) { return d.git(ctx, req.Dir, args...) }
	return hunksOf(ctx, git, req.OldBlob, req.NewBlob, oldLines, newLines)
}

// InHunk tells whether lines start to end of a side lie in one hunk: GitHub refuses a line comment elsewhere, and a
// multi-line comment across two hunks.
func InHunk(hunks []Hunk, side string, start int, end int) bool {
	return mcpreview.InHunk(hunks, side, start, end)
}

type CommentText struct {
	Lang string `json:"lang,omitempty"`
	Text string `json:"text"`
	// EditedByUser: a translation the developer wrote or changed; the agent's later translations never replace it.
	EditedByUser bool `json:"editedbyuser,omitempty"`
}

// Comment is one review comment (DS-REV-007). Subject: SubjectLine (a GitHub line comment) or SubjectFile (a
// file-level comment quoting Anchor.Excerpt). Outdated is a flag next to the state: a staged comment whose lines went
// away stays staged and is published as a file-level comment quoting its excerpt (DS-REV-008). Original is the
// developer's text in their language; Translation is its version in the publication language (FR-REV-010). History
// keeps the original text and every later state (FR-REV-009 AC5); Discussion is the exchange with the review session
// about the comment (AC2).
type Comment struct {
	Id              string           `json:"id"`
	Round           string           `json:"round,omitempty"`
	Anchor          mcpreview.Anchor `json:"anchor"`
	Subject         string           `json:"subject"`
	Kind            string           `json:"kind"`
	State           string           `json:"state"`
	Original        CommentText      `json:"original"`
	Translation     *CommentText     `json:"translation,omitempty"`
	GithubCommentId int64            `json:"githubcommentid,omitempty"`
	// PublishedAs: how GitHub got it (SubjectLine or SubjectFile, FR-REV-010); PublishNote: why a line comment went
	// file-level (Note…).
	PublishedAs string           `json:"publishedas,omitempty"`
	PublishNote string           `json:"publishnote,omitempty"`
	Author      string           `json:"author"`
	Outdated    bool             `json:"outdated,omitempty"`
	CreatedAt   int64            `json:"createdat"`
	UpdatedAt   int64            `json:"updatedat,omitempty"`
	History     []CommentEvent   `json:"history,omitempty"`
	Discussion  []CommentMessage `json:"discussion,omitempty"`
}

// CommentRequest saves a comment: a new one (no Id) with its anchor, or the text (and kind) of an existing one.
type CommentRequest struct {
	PrKey
	Id      string            `json:"id,omitempty"`
	Anchor  *mcpreview.Anchor `json:"anchor,omitempty"`
	Subject string            `json:"subject,omitempty"`
	Kind    string            `json:"kind,omitempty"`
	Text    string            `json:"text"`
	Lang    string            `json:"lang,omitempty"`
}

// RelocateRequest re-anchors the comments made on other heads to the head the tab shows (FR-REV-003 AC5).
type RelocateRequest struct {
	PrKey
	Dir     string `json:"dir"`
	HeadOid string `json:"headoid"`
	// BaseOid: the merge base the tab's diff starts from (the base side's lines).
	BaseOid string `json:"baseoid"`
}

func checkAnchor(a *mcpreview.Anchor) error {
	if a == nil || a.Path == "" || a.Line <= 0 || (a.Side != mcpreview.SideRight && a.Side != mcpreview.SideLeft) {
		return fmt.Errorf("the anchor must name a file, a side (RIGHT or LEFT) and its lines")
	}
	if a.StartLine < 0 || a.StartLine > a.Line {
		return fmt.Errorf("the anchor's first line is after its last")
	}
	if !isOid(a.HeadOid) {
		return fmt.Errorf("the anchor must name the head it was made on")
	}
	if len(a.Excerpt) > maxCommentBytes {
		return uimsg.Errorf(uimsg.Make("review.selectiontoolarge"), "the selection is too large to comment (64 KB at most)")
	}
	return nil
}

func isEditable(c *Comment) bool {
	return c.State != CommentStatePublished && c.State != CommentStateDropped
}

func findComment(state *State, id string) *Comment {
	for i := range state.Comments {
		if state.Comments[i].Id == id {
			return &state.Comments[i]
		}
	}
	return nil
}

// SaveComment adds a draft comment, or changes the text (and kind) of one not yet published.
func (s *Store) SaveComment(req CommentRequest) (State, bool, error) {
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return State{}, false, uimsg.Errorf(uimsg.Make("review.commentempty"), "the comment is empty")
	}
	if len(text) > maxCommentBytes {
		return State{}, false, uimsg.Errorf(uimsg.Make("review.commenttoolong"), "the comment is too long (64 KB at most)")
	}
	kind := req.Kind
	if kind != "" && kind != CommentKindComment && kind != CommentKindChange {
		return State{}, false, fmt.Errorf("kind must be comment or change")
	}
	if req.Id == "" {
		if err := checkAnchor(req.Anchor); err != nil {
			return State{}, false, err
		}
		if req.Subject != SubjectLine && req.Subject != SubjectFile {
			return State{}, false, fmt.Errorf("subject must be line or file")
		}
	}
	var saveErr error
	state, changed, err := s.update(req.PrKey, func(state *State) bool {
		now := s.now().UnixMilli()
		if req.Id != "" {
			c := findComment(state, req.Id)
			if c == nil {
				saveErr = noCommentError(req.Id)
				return false
			}
			if !isEditable(c) {
				saveErr = lockedError(c)
				return false
			}
			if c.Original.Text == text && (kind == "" || kind == c.Kind) {
				return false
			}
			textChanged := c.Original.Text != text
			c.Original.Text = text
			if kind != "" {
				c.Kind = kind
			}
			if textChanged {
				// A translation of the old text no longer says the same thing.
				c.Translation = nil
				if c.State == CommentStateTranslated {
					c.State = CommentStateStaged
				}
				addEvent(c, now, EventEdited, AuthorDeveloper, text)
			} else {
				addEvent(c, now, EventKind, AuthorDeveloper, "")
			}
			c.UpdatedAt = now
			return true
		}
		if len(state.Comments) >= maxComments {
			saveErr = uimsg.Errorf(uimsg.Make("review.toomanycomments", "max", strconv.Itoa(maxComments)), "this review has too many comments (%d)", maxComments)
			return false
		}
		if kind == "" {
			kind = CommentKindComment
		}
		c := Comment{
			Id: uuid.NewString(), Anchor: *req.Anchor, Subject: req.Subject, Kind: kind, State: CommentStateDraft,
			Original: CommentText{Lang: req.Lang, Text: text}, Author: AuthorDeveloper, CreatedAt: now,
		}
		addEvent(&c, now, EventCreated, AuthorDeveloper, text)
		state.Comments = append(state.Comments, c)
		return true
	})
	if saveErr != nil {
		return state, false, saveErr
	}
	return state, changed, err
}

func splitLines(text string) []string {
	text = strings.TrimSuffix(text, "\n")
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t\r")
	}
	return lines
}

// FindExcerpt finds the excerpt's lines in the text, the match nearest the old first line winning; ok false when the
// excerpt is not there any more.
func FindExcerpt(text string, excerpt string, oldStart int) (int, int, bool) {
	if strings.TrimSpace(excerpt) == "" {
		return 0, 0, false
	}
	want := splitLines(excerpt)
	lines := splitLines(text)
	best := -1
	for i := 0; i+len(want) <= len(lines); i++ {
		match := true
		for k := range want {
			if lines[i+k] != want[k] {
				match = false
				break
			}
		}
		if !match {
			continue
		}
		if best < 0 || abs(i+1-oldStart) < abs(best+1-oldStart) {
			best = i
		}
	}
	if best < 0 {
		return 0, 0, false
	}
	return best + 1, best + len(want), true
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

type relocation struct {
	id      string
	from    mcpreview.Anchor
	to      mcpreview.Anchor
	subject string
	found   bool
}

// Relocate moves the anchors of the comments made on other heads to the head shown, or marks them outdated (AC5).
// git runs outside the store's lock; a comment changed meanwhile keeps its change.
func (s *Service) Relocate(ctx context.Context, req RelocateRequest) (State, bool, error) {
	if err := checkDir(req.Dir); err != nil {
		return State{}, false, err
	}
	if !isOid(req.HeadOid) || !isOid(req.BaseOid) {
		return State{}, false, fmt.Errorf("headoid and baseoid must be commit ids")
	}
	state, err := s.store.Get(req.PrKey)
	if err != nil {
		return state, false, err
	}
	texts := map[string]*string{}
	sideText := func(commit string, path string) *string {
		key := commit + ":" + path
		if t, ok := texts[key]; ok {
			return t
		}
		out, err := s.git(ctx, req.Dir, "cat-file", "blob", commit+":"+path)
		var t *string
		if err == nil {
			str := string(out)
			t = &str
		}
		texts[key] = t
		return t
	}
	hunkCache := map[string][]Hunk{}
	hunksFor := func(path string) []Hunk {
		if h, ok := hunkCache[path]; ok {
			return h
		}
		out, err := s.git(ctx, req.Dir, "diff", "--no-color", "--no-ext-diff", "-U"+strconv.Itoa(hunkContext), req.BaseOid, req.HeadOid, "--", path)
		var h []Hunk
		if err == nil {
			h = ParseHunks(out)
		}
		hunkCache[path] = h
		return h
	}
	var moves []relocation
	for _, c := range state.Comments {
		if !isEditable(&c) || c.Anchor.HeadOid == req.HeadOid {
			continue
		}
		commit := req.HeadOid
		if c.Anchor.Side == mcpreview.SideLeft {
			commit = req.BaseOid
		}
		r := relocation{id: c.Id, from: c.Anchor, to: c.Anchor, subject: c.Subject}
		if text := sideText(commit, c.Anchor.Path); text != nil {
			oldStart := c.Anchor.StartLine
			if oldStart <= 0 {
				oldStart = c.Anchor.Line
			}
			if start, end, ok := FindExcerpt(*text, c.Anchor.Excerpt, oldStart); ok {
				r.found = true
				r.to.Line = end
				r.to.StartLine = 0
				if start != end {
					r.to.StartLine = start
				}
				r.to.HeadOid = req.HeadOid
				if r.subject == SubjectLine && !InHunk(hunksFor(c.Anchor.Path), c.Anchor.Side, start, end) {
					r.subject = SubjectFile
				}
			}
		}
		moves = append(moves, r)
	}
	if len(moves) == 0 {
		return state, false, nil
	}
	return s.store.update(req.PrKey, func(state *State) bool {
		changed := false
		for _, r := range moves {
			c := findComment(state, r.id)
			if c == nil || c.Anchor != r.from || !isEditable(c) {
				continue
			}
			switch {
			case r.found:
				c.Anchor, c.Subject, c.Outdated = r.to, r.subject, false
			case !c.Outdated:
				c.Outdated = true
			default:
				continue
			}
			changed = true
		}
		return changed
	})
}
