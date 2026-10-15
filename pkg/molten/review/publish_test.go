// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// fakeGithub stands for the developer's gh on one PR: it keeps the reviews and comments posted and logs every call.
// Nothing reaches GitHub.
type fakeGithub struct {
	lock     sync.Mutex
	calls    []string
	reviews  []map[string]any
	comments []map[string]any
	nextId   int64
	// loseReview: the next review is created but its answer is lost (a network failure after the post).
	loseReview bool
	// refuseLines: GitHub refuses any review carrying line comments (HTTP 422).
	refuseLines bool
	// failFileComments: this many file comments fail before they work again.
	failFileComments int
	listErr          error
	prs              []map[string]string
}

func (g *fakeGithub) run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	g.lock.Lock()
	defer g.lock.Unlock()
	g.calls = append(g.calls, strings.Join(args, " "))
	if args[0] == "pr" && args[1] == "list" {
		data, _ := json.Marshal(g.prs)
		return data, nil
	}
	if args[0] != "api" {
		return nil, fmt.Errorf("unexpected gh %v", args)
	}
	if args[1] != "-X" {
		if g.listErr != nil {
			return nil, g.listErr
		}
		path := args[1]
		switch {
		case strings.HasSuffix(path, "/reviews"):
			return pages(g.reviews), nil
		case strings.Contains(path, "/reviews/") && strings.HasSuffix(path, "/comments"):
			var mine []map[string]any
			for _, c := range g.comments {
				if fmt.Sprint(c["pull_request_review_id"]) == strings.Split(path, "/")[6] {
					mine = append(mine, c)
				}
			}
			return pages(mine), nil
		case strings.HasSuffix(path, "/comments"):
			return pages(g.comments), nil
		}
		return nil, fmt.Errorf("unexpected read %s", path)
	}
	path := args[3]
	data, err := os.ReadFile(args[5])
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, err
	}
	g.nextId++
	id := g.nextId
	if strings.HasSuffix(path, "/reviews") {
		lines, _ := body["comments"].([]any)
		if g.refuseLines && len(lines) > 0 {
			return []byte(`{"message":"Unprocessable Entity","errors":["Line could not be resolved"],"status":"422"}`), errors.New("gh: Unprocessable Entity (HTTP 422)")
		}
		review := map[string]any{"id": id, "body": body["body"], "html_url": fmt.Sprintf("https://github.com/%s/pull/7#pullrequestreview-%d", testRepo, id), "commit_id": body["commit_id"]}
		g.reviews = append(g.reviews, review)
		for _, l := range lines {
			lc := l.(map[string]any)
			g.nextId++
			lc["id"] = g.nextId
			lc["pull_request_review_id"] = id
			g.comments = append(g.comments, lc)
		}
		if g.loseReview {
			g.loseReview = false
			return nil, errors.New("gh: connection reset")
		}
		out, _ := json.Marshal(review)
		return out, nil
	}
	if g.failFileComments > 0 {
		g.failFileComments--
		return nil, errors.New("gh: Server Error (HTTP 502)")
	}
	body["id"] = id
	body["pull_request_review_id"] = id + 1000
	g.comments = append(g.comments, body)
	out, _ := json.Marshal(body)
	return out, nil
}

// pages answers as gh api --paginate does: one array per page.
func pages(items []map[string]any) []byte {
	if len(items) == 0 {
		return []byte("[]")
	}
	var b strings.Builder
	for i := 0; i < len(items); i += 2 {
		end := min(i+2, len(items))
		data, _ := json.Marshal(items[i:end])
		b.Write(data)
	}
	return []byte(b.String())
}

func (g *fakeGithub) posts(suffix string) int {
	g.lock.Lock()
	defer g.lock.Unlock()
	n := 0
	for _, c := range g.calls {
		if strings.HasPrefix(c, "api -X POST") && strings.Contains(c, suffix+" ") {
			n++
		}
	}
	return n
}

type publishFixture struct {
	t       *testing.T
	service *Service
	gh      *fakeGithub
	dir     string
	k       PrKey
	asked   []mcpreview.TranslateRequest
}

func makePublishFixture(t *testing.T) *publishFixture {
	f := &publishFixture{t: t, gh: &fakeGithub{}, dir: t.TempDir(), k: PrKey{Repo: testRepo, Number: 7}}
	f.service = MakeService(t.TempDir(), nil, nil)
	f.service.gh = f.gh.run
	f.service.translate = func(ctx context.Context, req mcpreview.TranslateRequest) (mcpreview.AskResult, error) {
		f.asked = append(f.asked, req)
		return mcpreview.AskResult{Sent: true, Submitted: true}, nil
	}
	os.WriteFile(f.dir+"/.saasfoundry.json", []byte(`{"language":{"tickets":"en"}}`), 0644)
	return f
}

// comment adds a staged comment in French.
func (f *publishFixture) comment(subject string, line int, text string) string {
	f.t.Helper()
	state, _, err := f.service.store.SaveComment(CommentRequest{PrKey: f.k, Anchor: anchorOn(oidA, mcpreview.SideRight, line-1, line, "a\nb"), Subject: subject, Text: text, Lang: "fr-FR", Kind: CommentKindChange})
	if err != nil {
		f.t.Fatal(err)
	}
	id := state.Comments[len(state.Comments)-1].Id
	if _, _, err := f.service.store.SetCommentState(CommentStateRequest{PrKey: f.k, Id: id, Action: ActionStage}); err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *publishFixture) translate(id string, text string) {
	f.t.Helper()
	if _, _, err := f.service.store.SetTranslation(f.k, id, text, "en", false); err != nil {
		f.t.Fatal(err)
	}
}

func (f *publishFixture) publish(asWritten bool) (State, error) {
	return f.service.Publish(context.Background(), PublishRequest{PrKey: f.k, Dir: f.dir, HeadOid: oidA, AsWritten: asWritten})
}

func commentById(state State, id string) Comment {
	for _, c := range state.Comments {
		if c.Id == id {
			return c
		}
	}
	return Comment{}
}

// TC-REV-008, AC3, AC6: French comments, one English review with the line comment on its lines, the file-level and the
// outdated ones as file comments; ids, round and both texts are kept.
func TestPublishOneReview(t *testing.T) {
	f := makePublishFixture(t)
	line := f.comment(SubjectLine, 12, "Renomme `doThing` en `apply`.")
	file := f.comment(SubjectFile, 30, "Ce fichier mérite un test.")
	outdated := f.comment(SubjectLine, 40, "Cette boucle est inutile.")
	f.service.store.update(f.k, func(st *State) bool {
		findComment(st, outdated).Outdated = true
		return true
	})
	f.service.store.SetSummary(SummaryRequest{PrKey: f.k, Text: "Bon travail.", Lang: "fr"})
	f.translate(line, "Rename `doThing` to `apply`.")
	f.translate(file, "This file deserves a test.")
	if _, err := f.publish(false); err == nil || !strings.Contains(err.Error(), "2 texts are not in English") {
		t.Fatalf("untranslated texts were published: %v", err)
	}
	if len(f.gh.calls) != 0 {
		t.Fatalf("GitHub was called before every text was translated: %v", f.gh.calls)
	}
	f.translate(outdated, "This loop is useless.")
	f.translate(mcpreview.SummaryId, "Good work.")
	state, err := f.publish(false)
	if err != nil {
		t.Fatal(err)
	}
	if f.gh.posts("/reviews") != 1 || f.gh.posts("/comments") != 2 || len(f.gh.reviews) != 1 {
		t.Fatalf("one review and two file comments expected: %v", f.gh.calls)
	}
	review := f.gh.reviews[0]
	if review["commit_id"] != oidA || !strings.HasPrefix(review["body"].(string), "Good work.") || !strings.Contains(review["body"].(string), reviewMarker(state.Publish.RoundId)) {
		t.Errorf("review %+v", review)
	}
	var lineComment, fileComments []map[string]any
	for _, c := range f.gh.comments {
		if c["subject_type"] == "file" {
			fileComments = append(fileComments, c)
		} else {
			lineComment = append(lineComment, c)
		}
	}
	if len(lineComment) != 1 || lineComment[0]["line"] != float64(12) || lineComment[0]["start_line"] != float64(11) || lineComment[0]["side"] != "RIGHT" || !strings.HasPrefix(lineComment[0]["body"].(string), "Rename `doThing` to `apply`.") {
		t.Errorf("line comment %+v", lineComment)
	}
	for _, c := range fileComments {
		body := c["body"].(string)
		if c["commit_id"] != oidA || !strings.Contains(body, "```\na\nb\n```") || strings.Contains(body, "Ce ") {
			t.Errorf("file comment %+v", c)
		}
	}
	if state.Publish.State != PublishPublished || state.Publish.Url == "" || state.Publish.ReviewId == 0 {
		t.Errorf("record %+v", state.Publish)
	}
	round := state.Rounds[len(state.Rounds)-1]
	if round.PublishedAt == 0 || round.GithubReviewId != state.Publish.ReviewId || round.HeadOid != oidA || round.Lang != "en" {
		t.Errorf("round %+v", round)
	}
	for _, id := range []string{line, file, outdated} {
		c := commentById(state, id)
		if c.State != CommentStatePublished || c.GithubCommentId == 0 || c.Round != round.Id || c.Original.Lang != "fr-FR" || c.Translation == nil {
			t.Errorf("published comment %+v", c)
		}
		last := c.History[len(c.History)-1]
		if last.Event != EventPublished || last.Text != c.Translation.Text || c.History[0].Text != c.Original.Text {
			t.Errorf("history %+v", c.History)
		}
	}
	if c := commentById(state, line); c.PublishedAs != SubjectLine {
		t.Errorf("line comment published as %s", c.PublishedAs)
	}
	if c := commentById(state, outdated); c.PublishedAs != SubjectFile || c.PublishNote != NoteOutdated {
		t.Errorf("outdated %+v", c)
	}
	if state.Summary != nil {
		t.Error("the summary is kept for the next round")
	}
	if n, _ := f.service.store.Unpublished(f.k); n != 0 {
		t.Errorf("unpublished %d", n)
	}
	if _, err := f.publish(false); err == nil {
		t.Error("a second click published again")
	}
}

// AC5: the review was created but its answer was lost; the retry finds its marker and never posts a second review.
func TestPublishRetryNeverPostsASecondReview(t *testing.T) {
	f := makePublishFixture(t)
	line := f.comment(SubjectLine, 5, "Pourquoi ?")
	file := f.comment(SubjectFile, 9, "Ajoute un test.")
	f.translate(line, "Why?")
	f.translate(file, "Add a test.")
	f.gh.loseReview = true
	state, err := f.publish(false)
	if err != nil {
		t.Fatal(err)
	}
	if state.Publish.State != PublishFailed || commentById(state, line).State == CommentStatePublished {
		t.Fatalf("first attempt %+v", state.Publish)
	}
	round := state.Publish.RoundId
	state, err = f.publish(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.gh.reviews) != 1 || f.gh.posts("/reviews") != 1 {
		t.Fatalf("a second review was posted: %v", f.gh.calls)
	}
	if state.Publish.State != PublishPublished || state.Publish.RoundId != round || len(state.Rounds) != 1 {
		t.Errorf("retry %+v rounds %+v", state.Publish, state.Rounds)
	}
	if c := commentById(state, line); c.State != CommentStatePublished || c.GithubCommentId == 0 || c.PublishedAs != SubjectLine {
		t.Errorf("line comment after the retry %+v", c)
	}
	if c := commentById(state, file); c.State != CommentStatePublished || f.gh.posts("/comments") != 1 {
		t.Errorf("file comment after the retry %+v %v", c, f.gh.calls)
	}
}

// AC5: a file comment that failed is the only thing a retry posts.
func TestPublishPartialThenRetry(t *testing.T) {
	f := makePublishFixture(t)
	a := f.comment(SubjectFile, 3, "Un")
	b := f.comment(SubjectFile, 6, "Deux")
	f.translate(a, "One")
	f.translate(b, "Two")
	f.gh.failFileComments = 1
	state, err := f.publish(false)
	if err != nil {
		t.Fatal(err)
	}
	if state.Publish.State != PublishPartial || len(state.Publish.Notes) != 1 || state.Publish.Notes[0].Message == "" {
		t.Fatalf("partial %+v", state.Publish)
	}
	if state.Rounds[0].PublishedAt != 0 || state.Rounds[0].GithubReviewId == 0 {
		t.Errorf("partial round %+v", state.Rounds[0])
	}
	state, err = f.publish(false)
	if err != nil {
		t.Fatal(err)
	}
	if state.Publish.State != PublishPublished || f.gh.posts("/reviews") != 1 || f.gh.posts("/comments") != 3 {
		t.Errorf("retry %+v %v", state.Publish, f.gh.calls)
	}
	if commentById(state, a).State != CommentStatePublished || commentById(state, b).State != CommentStatePublished {
		t.Errorf("comments %+v", state.Comments)
	}
	for _, c := range f.gh.comments {
		if strings.Count(c["body"].(string), commentMarkerPrefix) != 1 {
			t.Errorf("comment %+v", c)
		}
	}
}

// AC5: GitHub refusing the lines; the review goes without them and each is re-posted as a file comment, reported.
func TestPublishRefusedLinesGoFileLevel(t *testing.T) {
	f := makePublishFixture(t)
	line := f.comment(SubjectLine, 5, "Ligne")
	f.translate(line, "Line")
	f.gh.refuseLines = true
	state, err := f.publish(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.gh.reviews) != 1 || f.gh.posts("/reviews") != 2 {
		t.Fatalf("calls %v", f.gh.calls)
	}
	c := commentById(state, line)
	if c.State != CommentStatePublished || c.PublishedAs != SubjectFile || c.PublishNote != NoteRefused {
		t.Errorf("refused line %+v", c)
	}
	if len(state.Publish.Notes) != 1 || state.Publish.Notes[0].Note != NoteRefused || state.Publish.State != PublishPublished {
		t.Errorf("report %+v", state.Publish)
	}
}

// AC4: Post as written publishes the originals; a comment already in the publication language is never translated.
func TestPublishAsWrittenAndTranslateRequest(t *testing.T) {
	f := makePublishFixture(t)
	fr := f.comment(SubjectLine, 5, "Pourquoi ce choix ?")
	state, _, _ := f.service.store.SaveComment(CommentRequest{PrKey: f.k, Anchor: anchorOn(oidA, mcpreview.SideLeft, 0, 2, "x"), Subject: SubjectLine, Text: "Looks good", Lang: "en-US"})
	en := state.Comments[len(state.Comments)-1].Id
	f.service.store.SetCommentState(CommentStateRequest{PrKey: f.k, Id: en, Action: ActionStage})
	f.service.store.SetSummary(SummaryRequest{PrKey: f.k, Text: "Merci", Lang: "fr"})
	result, err := f.service.Translate(context.Background(), TranslateRequest{PrKey: f.k, Dir: f.dir})
	if err != nil {
		t.Fatal(err)
	}
	if result.Count != 2 || len(f.asked) != 1 || f.asked[0].Lang != "en" || f.asked[0].Items[0].Id != fr || f.asked[0].Items[1].Id != mcpreview.SummaryId {
		t.Fatalf("asked %+v", f.asked)
	}
	if !strings.Contains(f.asked[0].Items[0].Where, "lines 4-5") {
		t.Errorf("where %q", f.asked[0].Items[0].Where)
	}
	// The developer's edit wins over a later translation of the agent's.
	f.service.store.SetTranslation(f.k, fr, "Why this choice?", "en", true)
	f.translate(fr, "Why that?")
	state, _ = f.service.store.Get(f.k)
	if c := commentById(state, fr); c.Translation.Text != "Why this choice?" || !c.Translation.EditedByUser || c.State != CommentStateTranslated {
		t.Errorf("edited translation %+v", c)
	}
	f.service.Translate(context.Background(), TranslateRequest{PrKey: f.k, Dir: f.dir, All: true})
	if len(f.asked[1].Items) != 1 || f.asked[1].Items[0].Id != mcpreview.SummaryId {
		t.Errorf("all again asked %+v", f.asked[1].Items)
	}
	state, err = f.publish(true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(f.gh.reviews[0]["body"].(string), "Merci") {
		t.Errorf("as written body %v", f.gh.reviews[0]["body"])
	}
	for _, c := range f.gh.comments {
		body := c["body"].(string)
		if !strings.HasPrefix(body, "Why this choice?") && !strings.HasPrefix(body, "Looks good") {
			t.Errorf("comment body %q", body)
		}
		if strings.HasPrefix(body, "Looks good") && (c["side"] != "LEFT" || c["start_line"] != nil) {
			t.Errorf("base side comment %+v", c)
		}
	}
	if !state.Publish.AsWritten {
		t.Errorf("record %+v", state.Publish)
	}
}

func TestPlanComments(t *testing.T) {
	other := strings.Repeat("c", 40)
	mk := func(subject string, head string, path string) *Comment {
		return &Comment{Id: path, Subject: subject, Anchor: mcpreview.Anchor{Path: path, Side: mcpreview.SideRight, Line: 10, HeadOid: head}, Original: CommentText{Lang: "en", Text: "x"}}
	}
	comments := []*Comment{mk(SubjectLine, oidA, "in.go"), mk(SubjectLine, oidA, "out.go"), mk(SubjectLine, other, "moved.go"), mk(SubjectFile, oidA, "gone.go")}
	hunks := func(path string) []Hunk {
		if path == "in.go" {
			return []Hunk{{NewStart: 5, NewLines: 10}}
		}
		return []Hunk{{NewStart: 50, NewLines: 3}}
	}
	inPr := func(path string) bool { return path != "gone.go" }
	plans, missing := planComments(comments, oidA, "en", false, hunks, inPr)
	if missing != 0 || len(plans) != 4 {
		t.Fatalf("plans %d missing %d", len(plans), missing)
	}
	want := [][2]string{{SubjectLine, ""}, {SubjectFile, NoteOutsideRun}, {SubjectFile, NoteOtherHead}, {PublishedInBody, NoteNotInPr}}
	for i, p := range plans {
		if p.as != want[i][0] || p.note != want[i][1] {
			t.Errorf("%s: %s %s", p.id, p.as, p.note)
		}
	}
	body := reviewBody("Summary", plans, "r1")
	if !strings.HasPrefix(body, "Summary") || !strings.Contains(body, "`gone.go`") || !strings.HasSuffix(body, reviewMarker("r1")) {
		t.Errorf("body %q", body)
	}
	if got := fenceFor("a ``` b"); got != "````" {
		t.Errorf("fence %q", got)
	}
}

func TestDecodeList(t *testing.T) {
	got, err := decodeList[ghReview]([]byte(`[{"id":1}][{"id":2},{"id":3}]` + "\n"))
	if err != nil || len(got) != 3 || got[2].Id != 3 {
		t.Errorf("%v %+v", err, got)
	}
}

// The publication language: the project's, else the setting, else detected from the PRs and README, else English.
func TestPublicationLanguage(t *testing.T) {
	f := makePublishFixture(t)
	ctx := context.Background()
	res, _ := f.service.PublicationLanguage(ctx, PublishInfoRequest{PrKey: f.k, Dir: f.dir})
	if res.Lang != "en" || res.Source != "project" {
		t.Errorf("project %+v", res)
	}
	dir := t.TempDir()
	f.service.publishSetting = func() string { return "Français" }
	res, _ = f.service.PublicationLanguage(ctx, PublishInfoRequest{PrKey: f.k, Dir: dir})
	if res.Lang != "fr" || res.Source != "setting" || res.Name != "French" {
		t.Errorf("setting %+v", res)
	}
	f.service.publishSetting = func() string { return "" }
	f.gh.prs = []map[string]string{{"title": "Ajoute la page des réglages", "body": "Cette PR ajoute la page des réglages et les tests qui sont dans le dossier des tests pour que la page soit testée."}}
	res, _ = f.service.PublicationLanguage(ctx, PublishInfoRequest{PrKey: f.k, Dir: dir})
	if res.Lang != "fr" || res.Source != "detected" {
		t.Errorf("detected %+v", res)
	}
	if !strings.Contains(strings.Join(f.gh.calls, "\n"), "pr list --repo "+testRepo) {
		t.Errorf("calls %v", f.gh.calls)
	}
	calls := len(f.gh.calls)
	f.service.PublicationLanguage(ctx, PublishInfoRequest{PrKey: f.k, Dir: dir})
	if len(f.gh.calls) != calls {
		t.Error("the PRs were read again within the cache's time")
	}
	f.gh.prs = nil
	empty := t.TempDir()
	res, _ = f.service.PublicationLanguage(ctx, PublishInfoRequest{PrKey: f.k, Dir: empty})
	if res.Lang != "en" || res.Source != "default" {
		t.Errorf("default %+v", res)
	}
}

// NFR-REV-003: the publication's commands answer a MoltenTerm window only.
func TestPublishCommandsAreWindowOnly(t *testing.T) {
	f := makePublishFixture(t)
	f.comment(SubjectFile, 3, "Un")
	link := &routeLink{service: f.service}
	terminal := wshutil.RoutePrefix_Proc + "x"
	data := map[string]any{"repo": testRepo, "number": 7, "dir": f.dir, "headoid": oidA, "aswritten": true, "id": "x", "text": "y"}
	for _, command := range []string{PublishCommand, TranslateCommand, TranslationCommand, SummaryCommand, PublishInfoCommand} {
		if _, err := callAs(link, terminal, command, data); err == nil {
			t.Errorf("%s answered a terminal", command)
		}
	}
	if len(f.gh.calls) != 0 || len(f.asked) != 0 {
		t.Errorf("a terminal reached GitHub or the session: %v %v", f.gh.calls, f.asked)
	}
	window := wshutil.RoutePrefix_Tab + "x"
	if _, err := callAs(link, window, PublishCommand, data); err != nil {
		t.Fatal(err)
	}
	if len(f.gh.reviews) != 1 {
		t.Errorf("the window's click did not publish: %v", f.gh.calls)
	}
}

// The agent's translation is kept from the session's post; one for a comment no longer staged is not.
func TestSessionTranslationKept(t *testing.T) {
	f := makePublishFixture(t)
	id := f.comment(SubjectLine, 4, "Bien")
	f.service.SessionPosted(mcpreview.Update{Repo: testRepo, Number: 7, Post: &mcpreview.Post{Kind: mcpreview.PostTranslation, CommentId: id, Text: "Good", Lang: "en"}})
	state, _ := f.service.store.Get(f.k)
	c := commentById(state, id)
	if c.State != CommentStateTranslated || c.Translation == nil || c.Translation.Text != "Good" || c.Translation.EditedByUser {
		t.Fatalf("translation %+v", c)
	}
	if last := c.History[len(c.History)-1]; last.Event != EventTranslated || last.By != MessageByAgent {
		t.Errorf("history %+v", last)
	}
	f.service.store.SetCommentState(CommentStateRequest{PrKey: f.k, Id: id, Action: ActionUnstage})
	f.service.SessionPosted(mcpreview.Update{Repo: testRepo, Number: 7, Post: &mcpreview.Post{Kind: mcpreview.PostTranslation, CommentId: id, Text: "Fine", Lang: "en"}})
	state, _ = f.service.store.Get(f.k)
	if c := commentById(state, id); c.Translation.Text != "Good" || c.State != CommentStateDraft {
		t.Errorf("a draft took a translation %+v", c)
	}
}
