// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package milestones is the project's active milestone as the companion's Tasks block shows it (FR-SHELL-018, #2392):
// its name, progress and due date, and its remaining tickets, each with one sentence in the interface language. The
// forge is read through the user's gh, only when a companion that shows asks, at most once a minute per project, and
// the read is shared by every companion of the project. The sentences are written by the project's coding agent in
// its quick, read-only form, under a strict cap (sentences.go).
package milestones

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

const (
	// must match frontend/moltenterm-shell/companion/companion-milestone-model.ts
	RouteId    = "molten:milestones"
	Event      = "molten:milestones"
	GetCommand = "moltenmilestonesget"

	// StateLoading: not read yet; StateNone: no open milestone; StateNoForge: gh is missing or signed out, or the
	// folder is not a repository on a forge it knows.
	StateLoading = "loading"
	StateOk      = "ok"
	StateNone    = "none"
	StateNoForge = "noforge"

	// MaxShown is how many tickets a companion shows, and has phrased, at most.
	MaxShown = 8

	// A project's forge is read again after freshFor, after failedFor when the read failed or found no forge.
	freshFor    = time.Minute
	failedFor   = 5 * time.Minute
	readTimeout = 30 * time.Second
	// At most this many reads run at once, whatever the number of projects; a project left out reads at its next ask.
	maxReads = 2
	// The projects kept; the least recently asked one goes first.
	maxProjects = 32
)

type Ticket struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Url    string `json:"url,omitempty"`
	// Updated is the ticket's last update (Unix ms): with its number and the language, it keys its sentence.
	Updated  int64  `json:"updated,omitempty"`
	Sentence string `json:"sentence,omitempty"`
	// excerpt is the first lines of its body, cleaned, for its sentence only: it never leaves wavesrv for a window.
	excerpt string
}

type Milestone struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Url    string `json:"url,omitempty"`
	// Open and Closed are the forge's counts, which hold its pull requests too, as its own progress bar does.
	Open   int   `json:"open"`
	Closed int   `json:"closed"`
	Due    int64 `json:"due,omitempty"`
	// Remaining is the number of its open tickets, pull requests left out.
	Remaining int      `json:"remaining"`
	Tickets   []Ticket `json:"tickets"`
}

type View struct {
	Dir       string     `json:"dir"`
	State     string     `json:"state"`
	Milestone *Milestone `json:"milestone,omitempty"`
	// Phrasing: a batch of sentences is being written for this project's tickets.
	Phrasing bool  `json:"phrasing,omitempty"`
	ReadAt   int64 `json:"readat,omitempty"`
}

type GetRequest struct {
	Dir string `json:"dir"`
	// Lang is the interface language the sentences are written in; none are written without it.
	Lang string `json:"lang,omitempty"`
	// Want: the tickets the companion shows, whose sentences it needs, MaxShown at most. Without it none is written: a
	// companion asks first, then again with the rows it shows, so no batch is spent on a ticket it does not show.
	Want []int `json:"want,omitempty"`
}

// Signal tells the windows that a project's view changed: they ask for it again, in their language.
type Signal struct {
	Dir string `json:"dir"`
	Rev int64  `json:"rev"`
}

// Env is what the service reads and runs; the tests give fakes.
type Env struct {
	Now func() time.Time
	// Gh runs the user's gh in dir and returns its standard output; an error carries what it printed on stderr.
	Gh func(ctx context.Context, dir string, args ...string) ([]byte, error)
	// ValidDir: an existing local folder.
	ValidDir func(dir string) bool
	// Agent is the project's coding agent when it has a quick, read-only form; "" when none can write the sentences.
	Agent func(dir string) string
	// RunPrint runs that agent's text-only form on the prompt, in no project's folder.
	RunPrint func(ctx context.Context, agent string, prompt string) ([]byte, error)
	// RecordUse adds a batch's running time to the agent's use.
	RecordUse func(agent string, ended time.Time, d time.Duration)
	Publish   func(sig Signal)
	// Load and Save keep the sentences and the day's count of batches across restarts; nil keeps them in memory.
	Load func() StoreFile
	Save func(file StoreFile)
}

type project struct {
	dir string
	// repo is the forge repository's web address: the sentences are kept per repository, not per folder.
	repo      string
	state     string
	milestone *Milestone
	readAt    time.Time
	askedAt   time.Time
	failed    bool
	reading   bool
	rev       int64
}

func (p *project) stale(now time.Time) bool {
	if p.readAt.IsZero() {
		return true
	}
	wait := freshFor
	if p.failed {
		wait = failedFor
	}
	return now.Sub(p.readAt) >= wait
}

type Service struct {
	env      Env
	lock     sync.Mutex
	projects map[string]*project
	reads    int
	text     sentenceState
	// background counts the reads and batches that run, so a test waits for them before its folders go.
	background sync.WaitGroup
}

func MakeService(env Env) *Service {
	return &Service{env: env, projects: map[string]*project{}}
}

func (s *Service) now() time.Time {
	if s.env.Now != nil {
		return s.env.Now()
	}
	return time.Now()
}

func unixMs(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func (s *Service) cleanDir(dir string) (string, bool) {
	dir = strings.TrimSpace(dir)
	if dir == "" || strings.ContainsRune(dir, 0) || !filepath.IsAbs(dir) {
		return "", false
	}
	dir = filepath.Clean(dir)
	if s.env.ValidDir != nil && !s.env.ValidDir(dir) {
		return "", false
	}
	return dir, true
}

// Get answers a project's view at once, from what was read last. It starts a read of the forge when the last one is
// old enough, and a batch of sentences when shown tickets have none in lang and the cap allows one; each tells the
// windows by a Signal when it is done.
func (s *Service) Get(req GetRequest) View {
	dir, ok := s.cleanDir(req.Dir)
	if !ok {
		return View{Dir: req.Dir, State: StateNoForge}
	}
	lang := cleanLang(req.Lang)
	view, read, ask := s.look(dir, lang, req.Want)
	if read {
		s.background.Add(1)
		go s.read(dir)
	}
	if len(ask.tickets) == 0 || s.env.Agent == nil || s.env.RunPrint == nil {
		return view
	}
	agent := s.env.Agent(dir)
	if agent == "" {
		return view
	}
	if ask = s.claimBatch(ask); len(ask.tickets) > 0 {
		view.Phrasing = true
		s.background.Add(1)
		go s.runBatch(agent, ask)
	}
	return view
}

func (s *Service) look(dir string, lang string, want []int) (View, bool, batch) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.loadLocked()
	now := s.now()
	p := s.projectLocked(dir, now)
	read := false
	if !p.reading && p.stale(now) && s.reads < maxReads {
		p.reading = true
		s.reads++
		read = true
	}
	view := View{Dir: dir, State: p.state, ReadAt: unixMs(p.readAt), Phrasing: s.text.phrasingFor(p.repo)}
	if p.milestone == nil {
		return view, read, batch{}
	}
	m := *p.milestone
	m.Tickets = make([]Ticket, len(p.milestone.Tickets))
	for i, t := range p.milestone.Tickets {
		t.Sentence = s.text.sentenceOf(p.repo, t, lang)
		t.excerpt = ""
		m.Tickets[i] = t
	}
	view.Milestone = &m
	return view, read, s.text.missingLocked(p.repo, lang, shownTickets(p.milestone.Tickets, want), now)
}

// shownTickets are the tickets of the milestone a companion asked for, in its order.
func shownTickets(tickets []Ticket, want []int) []Ticket {
	byNumber := make(map[int]Ticket, len(tickets))
	for _, t := range tickets {
		byNumber[t.Number] = t
	}
	var rtn []Ticket
	seen := map[int]bool{}
	for _, n := range want {
		t, ok := byNumber[n]
		if !ok || seen[n] {
			continue
		}
		seen[n] = true
		rtn = append(rtn, t)
		if len(rtn) == MaxShown {
			break
		}
	}
	return rtn
}

func (s *Service) projectLocked(dir string, now time.Time) *project {
	p := s.projects[dir]
	if p == nil {
		s.evictLocked()
		p = &project{dir: dir, state: StateLoading}
		s.projects[dir] = p
	}
	p.askedAt = now
	return p
}

func (s *Service) evictLocked() {
	if len(s.projects) < maxProjects {
		return
	}
	var oldest *project
	for _, p := range s.projects {
		if p.reading {
			continue
		}
		if oldest == nil || p.askedAt.Before(oldest.askedAt) {
			oldest = p
		}
	}
	if oldest != nil {
		delete(s.projects, oldest.dir)
	}
}

// readResult is one read of the forge. A failure without a state keeps the last good read.
type readResult struct {
	state     string
	repo      string
	milestone *Milestone
	err       error
}

func (s *Service) read(dir string) {
	res := readResult{err: errors.New("the read stopped")}
	defer s.background.Done()
	defer func() {
		panichandler.PanicHandler("molten:milestones:read", recover())
		if sig, changed := s.applyRead(dir, res); changed && s.env.Publish != nil {
			s.env.Publish(sig)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	res = readForge(ctx, s.env.Gh, dir)
}

func (s *Service) applyRead(dir string, res readResult) (Signal, bool) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.reads--
	p := s.projects[dir]
	if p == nil {
		return Signal{}, false
	}
	p.reading = false
	p.readAt = s.now()
	if res.err != nil && res.state == "" {
		p.failed = true
		if p.state != StateLoading {
			return Signal{}, false
		}
		// A first read that failed shows the agent's own tasks alone rather than waiting.
		res = readResult{state: StateNoForge}
	}
	p.failed = res.err != nil || res.state == StateNoForge
	if p.state == res.state && p.repo == res.repo && reflect.DeepEqual(p.milestone, res.milestone) {
		return Signal{}, false
	}
	p.state, p.repo, p.milestone = res.state, res.repo, res.milestone
	p.rev++
	return Signal{Dir: dir, Rev: p.rev}, true
}

// signalsLocked tells every project of a repository that its view changed.
func (s *Service) signalsLocked(repo string) []Signal {
	var rtn []Signal
	for _, p := range s.projects {
		if repo == "" || p.repo != repo {
			continue
		}
		p.rev++
		rtn = append(rtn, Signal{Dir: p.dir, Rev: p.rev})
	}
	return rtn
}

// waitIdle waits for the reads and batches that run: for the tests, before their folders go.
func (s *Service) waitIdle() {
	s.background.Wait()
}
