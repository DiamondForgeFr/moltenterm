// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package milestones is the project's open milestones as the companion's Tasks block shows them (FR-SHELL-018, #2392,
// #2416): for each, its name, progress and due date, and its remaining tickets, each with one sentence in the interface
// language. The block has one tab per open milestone, in the order of order.go. The forge is read through the user's gh,
// only when a companion that shows asks, at most once a minute per project, and the read is shared by every companion of
// the project. The sentences are written by the project's coding agent in its quick, read-only form, under a strict cap
// (sentences.go).
package milestones

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"slices"
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
	// folder is not a repository on a forge it knows. StateOk: Milestones holds every open milestone, in tab order.
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
	Number   int    `json:"number"`
	Title    string `json:"title"`
	Url      string `json:"url,omitempty"`
	Sentence string `json:"sentence,omitempty"`
	// excerpt is the first lines of its body, cleaned, for its sentence only: it never leaves wavesrv for a window.
	excerpt string
	// hash is what its sentence is written from, its cleaned title and excerpt (contentHash): with the language, it
	// keys the sentence.
	hash string
}

type Milestone struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Url    string `json:"url,omitempty"`
	// Open and Closed count its issues, pull requests left out.
	Open   int   `json:"open"`
	Closed int   `json:"closed"`
	Due    int64 `json:"due,omitempty"`
	// Remaining is the number of its open tickets.
	Remaining int      `json:"remaining"`
	Tickets   []Ticket `json:"tickets"`
	// Loaded: its tickets were read. A milestone with no open issue has none to read; one past the first tabs is read
	// when a window selects it (GetRequest.Milestone).
	Loaded bool `json:"loaded"`
}

type View struct {
	Dir   string `json:"dir"`
	State string `json:"state"`
	// Milestones: every open milestone, in the order of the tabs (order.go).
	Milestones []Milestone `json:"milestones,omitempty"`
	// Summaries: the developer turned the sentences on and confirmed it (companion:ticketsummaries). Phrasable: the
	// project's agent can write them. The companion offers them once when the second holds and the first does not.
	Summaries bool `json:"summaries,omitempty"`
	Phrasable bool `json:"phrasable,omitempty"`
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
	// Milestone: the number of the tab the companion shows. When it is past the tabs whose tickets are read with every
	// read, its tickets are read at once.
	Milestone int `json:"milestone,omitempty"`
	// Shown: the companion is on screen. A hidden one gets what was read last and starts nothing: no read of the forge,
	// no batch of sentences.
	Shown bool `json:"shown,omitempty"`
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
	// Agent is the project's coding agent when it has a text-only form; "" when none can write the sentences.
	Agent func(dir string) string
	// SummariesOn: the developer turned the sentences on (companion:ticketsummaries) and confirmed it. Nothing is
	// written while it is off.
	SummariesOn func() bool
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
	repo       string
	state      string
	milestones []Milestone
	// selected: the milestones past the first tabs that a window showed, whose tickets every read gets as well; the
	// least recently shown one first.
	selected []int
	readAt   time.Time
	askedAt  time.Time
	failed   bool
	reading  bool
	rev      int64
}

// selectTab notes the tab a window shows. It tells whether that milestone's tickets are still to read.
func (p *project) selectTab(number int) bool {
	if number <= 0 {
		return false
	}
	index := -1
	for i := range p.milestones {
		if p.milestones[i].Number == number {
			index = i
			break
		}
	}
	if index < 0 || p.milestones[index].Open <= 0 {
		return false
	}
	if index >= ticketMilestones {
		p.selected = append(slices.DeleteFunc(p.selected, func(n int) bool { return n == number }), number)
		if len(p.selected) > maxSelected {
			p.selected = p.selected[len(p.selected)-maxSelected:]
		}
	}
	return !p.milestones[index].Loaded
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

// Get answers a project's view at once, from what was read last. For a companion on screen, it starts a read of the
// forge when the last one is old enough (or the tab it shows has no tickets read yet), and a batch of sentences when the
// developer turned them on, shown tickets have none in lang and the cap allows one; each tells the windows by a Signal
// when it is done. A hidden companion starts nothing.
func (s *Service) Get(req GetRequest) View {
	dir, ok := s.cleanDir(req.Dir)
	if !ok {
		return View{Dir: req.Dir, State: StateNoForge}
	}
	// Turned off, the companion shows the titles: neither a sentence written earlier nor a new one.
	summaries := s.env.SummariesOn != nil && s.env.SummariesOn()
	lang := ""
	if summaries {
		lang = cleanLang(req.Lang)
	}
	view, read, ask := s.look(dir, lang, req)
	if read != nil {
		s.background.Add(1)
		go s.read(dir, read)
	}
	agent := ""
	if len(view.Milestones) > 0 && s.env.Agent != nil && s.env.RunPrint != nil {
		agent = s.env.Agent(dir)
	}
	view.Phrasable = agent != ""
	view.Summaries = summaries
	if !req.Shown || !summaries || agent == "" || len(ask.tickets) == 0 {
		return view
	}
	ask, file := s.claimBatch(ask)
	if len(ask.tickets) == 0 {
		return view
	}
	// The count is kept before the run starts: a crash or a quit during it still spends its place in the cap.
	if s.env.Save != nil {
		s.env.Save(file)
	}
	view.Phrasing = true
	s.background.Add(1)
	go s.runBatch(agent, ask)
	return view
}

// readJob is a read of the forge a Get starts: selected are the milestones past the first tabs whose tickets it reads.
type readJob struct {
	selected []int
}

func (s *Service) look(dir string, lang string, req GetRequest) (View, *readJob, batch) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.loadLocked()
	now := s.now()
	p := s.projectLocked(dir, now)
	// A tab whose tickets are not read yet is read at once, but not again before the next ordinary read after a failure.
	unread := req.Shown && p.selectTab(req.Milestone)
	var job *readJob
	if req.Shown && !p.reading && (p.stale(now) || (unread && !p.failed)) && s.reads < maxReads {
		p.reading = true
		s.reads++
		job = &readJob{selected: slices.Clone(p.selected)}
	}
	view := View{Dir: dir, State: p.state, ReadAt: unixMs(p.readAt), Phrasing: s.text.phrasingFor(p.repo)}
	if len(p.milestones) == 0 {
		return view, job, batch{}
	}
	view.Milestones = make([]Milestone, len(p.milestones))
	var all []Ticket
	for i, m := range p.milestones {
		m.Tickets = make([]Ticket, len(p.milestones[i].Tickets))
		for j, t := range p.milestones[i].Tickets {
			all = append(all, t)
			t.Sentence = s.text.sentenceOf(p.repo, t, lang)
			t.excerpt = ""
			m.Tickets[j] = t
		}
		view.Milestones[i] = m
	}
	return view, job, s.text.missingLocked(p.repo, lang, shownTickets(all, req.Want), now)
}

// shownTickets are the tickets a companion asked for among those of the milestones, in its order.
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
	state      string
	repo       string
	milestones []Milestone
	err        error
}

func (s *Service) read(dir string, job *readJob) {
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
	res = readForge(ctx, s.env.Gh, dir, job.selected)
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
	// A tab a window selected while this read ran has its tickets to read: the windows ask again, which reads them.
	late := res.err == nil && p.unreadSelectedAmong(res.milestones)
	if p.state == res.state && p.repo == res.repo && reflect.DeepEqual(p.milestones, res.milestones) && !late {
		return Signal{}, false
	}
	p.state, p.repo, p.milestones = res.state, res.repo, res.milestones
	p.rev++
	return Signal{Dir: dir, Rev: p.rev}, true
}

// unreadSelectedAmong: a milestone a window selected is in the list without its tickets.
func (p *project) unreadSelectedAmong(list []Milestone) bool {
	for _, m := range list {
		if m.Open > 0 && !m.Loaded && slices.Contains(p.selected, m.Number) {
			return true
		}
	}
	return false
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
