// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewlang"
)

// Post review (FR-REV-010 AC3 to AC6, DS-REV-008): after the developer's click, wavesrv posts one GitHub review (event
// COMMENT) through the developer's gh, on the head the anchors were made on, with one line comment per anchored
// comment. Comments that are file-level, outdated, made on another head or outside the diff's hunks are posted right
// after it as file comments quoting their lines, in the same round. Idempotency: the round is kept before any call,
// the review's body carries a hidden marker of the round and each comment one of its id; a retry lists what GitHub has
// and posts only what is missing, so it never creates a second review. GitHub refusing the lines (HTTP 422) posts the
// review without them and re-posts each as a file comment, reported. The originals never leave MoltenTerm.

const (
	PublishPublishing = "publishing"
	PublishPublished  = "published"
	// Partial: the review is on GitHub but some comments are not; a retry posts them.
	PublishPartial = "partial"
	PublishFailed  = "failed"

	// Why a comment was not published as a line comment, or failed.
	NoteFileLevel  = "filelevel"
	NoteOutdated   = "outdated"
	NoteOtherHead  = "otherhead"
	NoteOutsideRun = "outsidediff"
	NoteRefused    = "refused"
	NoteLate       = "late"
	NoteNotInPr    = "notinpr"
	NoteFailed     = "failed"

	PublishedInBody = "review"

	reviewMarkerPrefix  = "<!-- molten-review:"
	commentMarkerPrefix = "<!-- molten-comment:"
	markerSuffix        = " -->"

	ghPublishTimeout = 60 * time.Second
	reviewEvent      = "COMMENT"
)

// PublishRequest is the developer's click on Post review (or Post as written: AsWritten publishes the originals of the
// texts not translated). HeadOid and BaseOid are the head and merge base the Review tab shows.
type PublishRequest struct {
	PrKey
	Dir       string `json:"dir"`
	HeadOid   string `json:"headoid"`
	BaseOid   string `json:"baseoid,omitempty"`
	AsWritten bool   `json:"aswritten,omitempty"`
}

// PublishNote reports what happened to one comment that did not go as a line comment of the review.
type PublishNote struct {
	CommentId string `json:"commentid"`
	Note      string `json:"note"`
	Message   string `json:"message,omitempty"`
}

// PublishRecord is the last Post review's progress and outcome, kept in the review store.
type PublishRecord struct {
	RoundId   string        `json:"roundid"`
	State     string        `json:"state"`
	Lang      string        `json:"lang"`
	AsWritten bool          `json:"aswritten,omitempty"`
	HeadOid   string        `json:"headoid"`
	ReviewId  int64         `json:"reviewid,omitempty"`
	Url       string        `json:"url,omitempty"`
	Message   string        `json:"message,omitempty"`
	Notes     []PublishNote `json:"notes,omitempty"`
	StartedAt int64         `json:"startedat"`
	EndedAt   int64         `json:"endedat,omitempty"`
}

type ghReview struct {
	Id      int64  `json:"id"`
	Body    string `json:"body"`
	HtmlUrl string `json:"html_url"`
}

type ghComment struct {
	Id       int64  `json:"id"`
	Body     string `json:"body"`
	ReviewId int64  `json:"pull_request_review_id"`
}

type ghLineComment struct {
	Path      string `json:"path"`
	Body      string `json:"body"`
	Line      int    `json:"line"`
	Side      string `json:"side"`
	StartLine int    `json:"start_line,omitempty"`
	StartSide string `json:"start_side,omitempty"`
}

type ghReviewInput struct {
	CommitId string          `json:"commit_id"`
	Body     string          `json:"body"`
	Event    string          `json:"event"`
	Comments []ghLineComment `json:"comments"`
}

type ghFileCommentInput struct {
	CommitId    string `json:"commit_id"`
	Path        string `json:"path"`
	Body        string `json:"body"`
	SubjectType string `json:"subject_type"`
}

// planned is one comment of the publication: as a line comment of the review, a file comment, or a section of the
// review's body (its file is not in the PR any more).
type planned struct {
	id      string
	anchor  mcpreview.Anchor
	text    string
	as      string
	note    string
	message string
	ghId    int64
	done    bool
}

func reviewMarker(round string) string {
	return reviewMarkerPrefix + round + markerSuffix
}

func commentMarker(id string) string {
	return commentMarkerPrefix + id + markerSuffix
}

// publishText is the text GitHub gets: the original when it is in the publication language, else its translation,
// else (Post as written) the original; ok false when it still needs a translation.
func publishText(original CommentText, translation *CommentText, lang string, asWritten bool) (string, bool) {
	if reviewlang.Same(original.Lang, lang) {
		return original.Text, true
	}
	if translation != nil && strings.TrimSpace(translation.Text) != "" && reviewlang.Same(translation.Lang, lang) {
		return translation.Text, true
	}
	if asWritten {
		return original.Text, true
	}
	return "", false
}

// linesRef names a comment's lines GitHub's way (R for the head side, L for the base) with the commit.
func linesRef(a mcpreview.Anchor) string {
	prefix := "R"
	if a.Side == mcpreview.SideLeft {
		prefix = "L"
	}
	ref := prefix + strconv.Itoa(a.Line)
	if a.StartLine > 0 && a.StartLine != a.Line {
		ref = prefix + strconv.Itoa(a.StartLine) + "-" + prefix + strconv.Itoa(a.Line)
	}
	return fmt.Sprintf("`%s` @ `%s`", ref, shortHead(a.HeadOid))
}

func fenceFor(text string) string {
	fence := "```"
	for strings.Contains(text, fence) {
		fence += "`"
	}
	return fence
}

// quoted is a comment's lines as a file comment shows them: their place, then the excerpt in a code block.
func quoted(a mcpreview.Anchor) string {
	var b strings.Builder
	b.WriteString(linesRef(a))
	if strings.TrimSpace(a.Excerpt) != "" {
		fence := fenceFor(a.Excerpt)
		b.WriteString("\n" + fence + "\n" + strings.TrimSuffix(a.Excerpt, "\n") + "\n" + fence)
	}
	return b.String()
}

func lineBody(p *planned) string {
	return p.text + "\n\n" + commentMarker(p.id)
}

func fileBody(p *planned) string {
	return quoted(p.anchor) + "\n\n" + p.text + "\n\n" + commentMarker(p.id)
}

func inBodySection(p *planned) string {
	return "**`" + p.anchor.Path + "`** " + quoted(p.anchor) + "\n\n" + p.text + "\n\n" + commentMarker(p.id)
}

// planComments decides how each comment goes to GitHub: a line comment only when it is a line comment, not outdated,
// made on the review's head and inside one hunk of its side (hunks nil: not checked); otherwise a file comment, or a
// section of the review's body when its file is not in the PR (inPr nil: not checked).
func planComments(comments []*Comment, head string, lang string, asWritten bool, hunks func(path string) []Hunk, inPr func(path string) bool) ([]*planned, int) {
	var rtn []*planned
	missing := 0
	for _, c := range comments {
		text, ok := publishText(c.Original, c.Translation, lang, asWritten)
		if !ok {
			missing++
			continue
		}
		p := &planned{id: c.Id, anchor: c.Anchor, text: strings.TrimSpace(text), as: SubjectLine}
		switch {
		case c.PublishNote == NoteRefused:
			p.as, p.note = SubjectFile, NoteRefused
		case c.Outdated:
			p.as, p.note = SubjectFile, NoteOutdated
		case c.Subject != SubjectLine:
			p.as, p.note = SubjectFile, NoteFileLevel
		case c.Anchor.HeadOid != head:
			p.as, p.note = SubjectFile, NoteOtherHead
		case hunks != nil && !InHunk(hunks(c.Anchor.Path), c.Anchor.Side, startOf(c.Anchor), c.Anchor.Line):
			p.as, p.note = SubjectFile, NoteOutsideRun
		}
		if p.as == SubjectFile && inPr != nil && !inPr(c.Anchor.Path) {
			p.as, p.note = PublishedInBody, NoteNotInPr
		}
		rtn = append(rtn, p)
	}
	return rtn, missing
}

func startOf(a mcpreview.Anchor) int {
	if a.StartLine > 0 {
		return a.StartLine
	}
	return a.Line
}

func lineComment(p *planned) ghLineComment {
	gc := ghLineComment{Path: p.anchor.Path, Body: lineBody(p), Line: p.anchor.Line, Side: p.anchor.Side}
	if p.anchor.StartLine > 0 && p.anchor.StartLine != p.anchor.Line {
		gc.StartLine, gc.StartSide = p.anchor.StartLine, p.anchor.Side
	}
	return gc
}

// reviewBody: the summary, the sections of the comments whose file left the PR, then the round's marker.
func reviewBody(summary string, plans []*planned, round string) string {
	var parts []string
	if s := strings.TrimSpace(summary); s != "" {
		parts = append(parts, s)
	}
	for _, p := range plans {
		if p.as == PublishedInBody {
			parts = append(parts, inBodySection(p))
		}
	}
	parts = append(parts, reviewMarker(round))
	return strings.Join(parts, "\n\n---\n\n")
}

// decodeList reads gh api's answer: one JSON array, or several (--paginate writes one per page).
func decodeList[T any](out []byte) ([]T, error) {
	dec := json.NewDecoder(bytes.NewReader(out))
	var rtn []T
	for {
		var raw json.RawMessage
		err := dec.Decode(&raw)
		if errors.Is(err, io.EOF) {
			return rtn, nil
		}
		if err != nil {
			return rtn, err
		}
		raw = bytes.TrimSpace(raw)
		if len(raw) > 0 && raw[0] == '[' {
			var page []T
			if err := json.Unmarshal(raw, &page); err != nil {
				return rtn, err
			}
			rtn = append(rtn, page...)
			continue
		}
		var one T
		if err := json.Unmarshal(raw, &one); err != nil {
			return rtn, err
		}
		rtn = append(rtn, one)
	}
}

func decodeJson(out []byte, v any) error {
	return json.Unmarshal(bytes.TrimSpace(out), v)
}

// ghCall runs the developer's gh with a time limit; its error never carries a token.
func (s *Service) ghCall(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if s.gh == nil {
		return nil, fmt.Errorf("gh is not available")
	}
	ctx, cancel := context.WithTimeout(ctx, ghPublishTimeout)
	defer cancel()
	out, err := s.gh(ctx, dir, args...)
	if err != nil {
		return out, fmt.Errorf("%s", maskTokens(err.Error()))
	}
	return out, nil
}

// ghPost sends a JSON body to the REST API (gh api --input, from a temporary file outside the project).
func (s *Service) ghPost(ctx context.Context, dir string, path string, body any) ([]byte, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	f, err := os.CreateTemp("", "molten-review-*.json")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	return s.ghCall(ctx, dir, "api", "-X", "POST", path, "--input", f.Name())
}

// isUnprocessable: GitHub refused the content (HTTP 422), for a review most often a line outside the diff.
func isUnprocessable(out []byte, err error) bool {
	if err == nil {
		return false
	}
	text := err.Error() + " " + string(out)
	return strings.Contains(text, "HTTP 422") || strings.Contains(text, "Unprocessable Entity") || strings.Contains(text, "Validation Failed")
}

func markerIn(body string, marker string) bool {
	return strings.Contains(body, marker)
}

// changedPaths: the files the PR changes between the merge base and the head, nil when git cannot say.
func (s *Service) changedPaths(ctx context.Context, dir string, base string, head string) func(path string) bool {
	if base == "" || s.git == nil {
		return nil
	}
	out, err := s.git(ctx, dir, "diff", "--name-only", "-z", "--no-renames", base, head)
	if err != nil {
		return nil
	}
	paths := map[string]bool{}
	for _, p := range strings.Split(string(out), "\x00") {
		if p != "" {
			paths[p] = true
		}
	}
	return func(path string) bool { return paths[path] }
}

func (s *Service) hunksOfHead(ctx context.Context, dir string, base string, head string) func(path string) []Hunk {
	if base == "" || s.git == nil {
		return nil
	}
	cache := map[string][]Hunk{}
	return func(path string) []Hunk {
		if h, ok := cache[path]; ok {
			return h
		}
		out, err := s.git(ctx, dir, "diff", "--no-color", "--no-ext-diff", "-U"+strconv.Itoa(hunkContext), base, head, "--", path)
		var h []Hunk
		if err == nil {
			h = ParseHunks(out)
		}
		cache[path] = h
		return h
	}
}

func (s *Service) startPublishing(k PrKey) bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.publishing == nil {
		s.publishing = map[PrKey]bool{}
	}
	if s.publishing[k] {
		return false
	}
	s.publishing[k] = true
	return true
}

func (s *Service) endPublishing(k PrKey) {
	s.lock.Lock()
	defer s.lock.Unlock()
	delete(s.publishing, k)
}

// beginRound keeps the round before any GitHub call: the round of an unfinished publication is taken again, so its
// marker finds what an earlier attempt posted.
func (s *Store) beginRound(k PrKey, head string, lang string, asWritten bool, ids []string) (State, PublishRecord, error) {
	var record PublishRecord
	state, _, err := s.update(k, func(state *State) bool {
		now := s.now().UnixMilli()
		var round *Round
		if p := state.Publish; p != nil && p.State != PublishPublished {
			for i := range state.Rounds {
				if state.Rounds[i].Id == p.RoundId && state.Rounds[i].PublishedAt == 0 {
					round = &state.Rounds[i]
				}
			}
		}
		if round == nil {
			state.Rounds = append(state.Rounds, Round{Id: uuid.NewString(), StartedAt: now, HeadOid: head})
			round = &state.Rounds[len(state.Rounds)-1]
		}
		if round.GithubReviewId == 0 {
			round.HeadOid = head
		}
		round.Lang = lang
		record = PublishRecord{RoundId: round.Id, State: PublishPublishing, Lang: lang, AsWritten: asWritten, HeadOid: round.HeadOid, StartedAt: now}
		if round.GithubReviewId != 0 {
			record.ReviewId, record.Url = round.GithubReviewId, round.GithubUrl
		}
		state.Publish = &record
		for _, id := range ids {
			if c := findComment(state, id); c != nil {
				c.Round = round.Id
			}
		}
		return true
	})
	return state, record, err
}

// noteReview keeps the review as soon as GitHub has it, and the comments it refused on their lines.
func (s *Store) noteReview(k PrKey, roundId string, reviewId int64, url string, refused []string) (State, bool, error) {
	return s.update(k, func(state *State) bool {
		for i := range state.Rounds {
			if state.Rounds[i].Id == roundId {
				state.Rounds[i].GithubReviewId, state.Rounds[i].GithubUrl = reviewId, url
			}
		}
		if state.Publish != nil && state.Publish.RoundId == roundId {
			state.Publish.ReviewId, state.Publish.Url = reviewId, url
		}
		for _, id := range refused {
			if c := findComment(state, id); c != nil {
				c.PublishNote = NoteRefused
			}
		}
		return true
	})
}

// finishRound records the outcome: each published comment with its GitHub id, the round and its text; the round
// published when nothing is left.
func (s *Store) finishRound(k PrKey, record PublishRecord, plans []*planned, summary *Summary) (State, bool, error) {
	return s.update(k, func(state *State) bool {
		now := s.now().UnixMilli()
		left := false
		for _, p := range plans {
			c := findComment(state, p.id)
			if c == nil {
				continue
			}
			if !p.done {
				left = true
				continue
			}
			c.State = CommentStatePublished
			c.Round = record.RoundId
			c.GithubCommentId = p.ghId
			c.PublishedAs = p.as
			c.PublishNote = p.note
			c.UpdatedAt = now
			addEvent(c, now, EventPublished, MessageByDeveloper, p.text)
		}
		record.EndedAt = now
		switch {
		case record.State == PublishFailed:
		case left:
			record.State = PublishPartial
		default:
			record.State = PublishPublished
		}
		for i := range state.Rounds {
			r := &state.Rounds[i]
			if r.Id != record.RoundId {
				continue
			}
			r.GithubReviewId, r.GithubUrl = record.ReviewId, record.Url
			if record.State == PublishPublished {
				r.PublishedAt = now
			}
		}
		if record.State == PublishPublished && summary != nil {
			state.Summary = nil
		}
		state.Publish = &record
		return true
	})
}

// PublishInfo answers the Publish sheet: the publication language and where it came from.
func (s *Service) PublishInfo(ctx context.Context, req PublishInfoRequest) (reviewlang.Resolution, error) {
	return s.PublicationLanguage(ctx, req)
}

// Publish posts the staged comments as one GitHub review (the developer's click; a window's only, NFR-REV-003).
func (s *Service) Publish(ctx context.Context, req PublishRequest) (State, error) {
	if err := req.check(); err != nil {
		return State{}, err
	}
	if err := checkDir(req.Dir); err != nil {
		return State{}, err
	}
	if !isOid(req.HeadOid) {
		return State{}, fmt.Errorf("headoid must be the head the comments were made on")
	}
	if req.BaseOid != "" && !isOid(req.BaseOid) {
		return State{}, fmt.Errorf("baseoid must be a commit id")
	}
	if !s.startPublishing(req.PrKey) {
		return State{}, fmt.Errorf("this review is being published")
	}
	defer s.endPublishing(req.PrKey)
	res, err := s.PublicationLanguage(ctx, PublishInfoRequest{PrKey: req.PrKey, Dir: req.Dir})
	if err != nil {
		return State{}, err
	}
	state, err := s.store.Get(req.PrKey)
	if err != nil {
		return State{}, err
	}
	comments := publishable(&state)
	summaryText := ""
	missing := 0
	if state.Summary != nil {
		text, ok := publishText(state.Summary.Original, state.Summary.Translation, res.Lang, req.AsWritten)
		if !ok {
			missing++
		}
		summaryText = text
	}
	if len(comments) == 0 && strings.TrimSpace(summaryText) == "" && missing == 0 {
		return state, fmt.Errorf("there is nothing to publish: stage comments first")
	}
	plans, missingComments := planComments(comments, req.HeadOid, res.Lang, req.AsWritten,
		s.hunksOfHead(ctx, req.Dir, req.BaseOid, req.HeadOid), s.changedPaths(ctx, req.Dir, req.BaseOid, req.HeadOid))
	missing += missingComments
	if missing > 0 {
		return state, fmt.Errorf("%d texts are not in %s yet: wait for the translations, write them, or post as written", missing, res.Name)
	}
	ids := make([]string, 0, len(plans))
	for _, p := range plans {
		ids = append(ids, p.id)
	}
	state, record, err := s.store.beginRound(req.PrKey, req.HeadOid, res.Lang, req.AsWritten, ids)
	if err != nil {
		return state, err
	}
	s.changed(state, true, nil)
	record = s.post(ctx, req, record, plans, summaryText)
	final, err := s.changed(s.store.finishRound(req.PrKey, record, plans, state.Summary))
	return final, err
}

// post makes the GitHub calls of one attempt and returns its record; plans are marked done with their GitHub ids.
func (s *Service) post(ctx context.Context, req PublishRequest, record PublishRecord, plans []*planned, summary string) PublishRecord {
	fail := func(err error) PublishRecord {
		record.State = PublishFailed
		record.Message = maskTokens(err.Error())
		record.Notes = notesOf(plans)
		return record
	}
	base := fmt.Sprintf("repos/%s/pulls/%d", req.Repo, req.Number)
	marker := reviewMarker(record.RoundId)
	if record.ReviewId == 0 {
		out, err := s.ghCall(ctx, req.Dir, "api", base+"/reviews", "--paginate")
		if err != nil {
			return fail(fmt.Errorf("the PR's reviews could not be read: %w", err))
		}
		reviews, err := decodeList[ghReview](out)
		if err != nil {
			return fail(fmt.Errorf("the PR's reviews could not be read: %w", err))
		}
		for _, r := range reviews {
			if markerIn(r.Body, marker) {
				record.ReviewId, record.Url = r.Id, r.HtmlUrl
			}
		}
	}
	var lines []*planned
	for _, p := range plans {
		if p.as == SubjectLine {
			lines = append(lines, p)
		}
	}
	if record.ReviewId == 0 {
		input := ghReviewInput{CommitId: record.HeadOid, Event: reviewEvent, Comments: []ghLineComment{}}
		for _, p := range lines {
			input.Comments = append(input.Comments, lineComment(p))
		}
		input.Body = reviewBody(summary, plans, record.RoundId)
		out, err := s.ghPost(ctx, req.Dir, base+"/reviews", input)
		var refused []string
		if err != nil && isUnprocessable(out, err) && len(lines) > 0 {
			// GitHub says which comment it refused only in words: the review goes without line comments, and each one
			// is re-posted as a file comment, reported.
			for _, p := range lines {
				p.as, p.note = SubjectFile, NoteRefused
				refused = append(refused, p.id)
			}
			lines = nil
			input.Comments = []ghLineComment{}
			out, err = s.ghPost(ctx, req.Dir, base+"/reviews", input)
		}
		if err != nil {
			return fail(fmt.Errorf("GitHub did not take the review: %w", err))
		}
		var created ghReview
		if err := decodeJson(out, &created); err != nil || created.Id == 0 {
			return fail(fmt.Errorf("GitHub's answer to the review could not be read"))
		}
		record.ReviewId, record.Url = created.Id, created.HtmlUrl
		s.changed(s.store.noteReview(req.PrKey, record.RoundId, record.ReviewId, record.Url, refused))
	}
	for _, p := range plans {
		if p.as == PublishedInBody {
			p.done, p.ghId = true, record.ReviewId
		}
	}
	if len(lines) > 0 {
		out, err := s.ghCall(ctx, req.Dir, "api", fmt.Sprintf("%s/reviews/%d/comments", base, record.ReviewId), "--paginate")
		if err != nil {
			return fail(fmt.Errorf("the review's comments could not be read: %w", err))
		}
		posted, err := decodeList[ghComment](out)
		if err != nil {
			return fail(fmt.Errorf("the review's comments could not be read: %w", err))
		}
		for _, p := range lines {
			for _, gc := range posted {
				if markerIn(gc.Body, commentMarker(p.id)) {
					p.done, p.ghId = true, gc.Id
				}
			}
			if !p.done {
				// Staged after the review an earlier attempt posted: it follows as a file comment.
				p.as, p.note = SubjectFile, NoteLate
			}
		}
	}
	var files []*planned
	for _, p := range plans {
		if p.as == SubjectFile && !p.done {
			files = append(files, p)
		}
	}
	if len(files) > 0 {
		out, err := s.ghCall(ctx, req.Dir, "api", base+"/comments", "--paginate")
		if err != nil {
			return fail(fmt.Errorf("the PR's comments could not be read: %w", err))
		}
		existing, err := decodeList[ghComment](out)
		if err != nil {
			return fail(fmt.Errorf("the PR's comments could not be read: %w", err))
		}
		for _, p := range files {
			for _, gc := range existing {
				if markerIn(gc.Body, commentMarker(p.id)) {
					p.done, p.ghId = true, gc.Id
				}
			}
			if p.done {
				continue
			}
			out, err := s.ghPost(ctx, req.Dir, base+"/comments", ghFileCommentInput{
				CommitId: record.HeadOid, Path: p.anchor.Path, Body: fileBody(p), SubjectType: "file",
			})
			var created ghComment
			if err == nil {
				err = decodeJson(out, &created)
			}
			if err != nil || created.Id == 0 {
				if err == nil {
					err = fmt.Errorf("GitHub's answer could not be read")
				}
				if p.note == "" {
					p.note = NoteFailed
				}
				p.message = maskTokens(err.Error())
				continue
			}
			p.done, p.ghId = true, created.Id
		}
	}
	record.Notes = notesOf(plans)
	for _, p := range plans {
		if !p.done {
			record.Message = "Some comments could not be posted: Post review again posts only those."
		}
	}
	return record
}

func notesOf(plans []*planned) []PublishNote {
	var rtn []PublishNote
	for _, p := range plans {
		// A file-level comment that went as one needs no report.
		if (p.note == "" || p.note == NoteFileLevel) && p.message == "" {
			continue
		}
		rtn = append(rtn, PublishNote{CommentId: p.id, Note: p.note, Message: p.message})
	}
	return rtn
}
