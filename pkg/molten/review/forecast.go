// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/forecast"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The conflict forecast of the Reviews list (FR-REV-023, DS-REV-016, NFR-REV-009/010): for each PR waiting for review,
// which other open PRs its merge would put in conflict. The window asks with the list it shows; the answer is the last
// forecast at once, and a computation that is due runs in the background, one per project, its result coming as a
// ForecastEvent. The simulation itself is pkg/molten/forecast's, in a private store. The suggested merge order (#781)
// and the batch merge (#782) read the same answer, through Get or the event.

// must match frontend/moltenterm-shell/reviews/reviews-forecast-client.ts
const (
	ForecastCommand = "moltenreviewforecast"
	// WPS event with a project's Forecast (scope: the project folder).
	ForecastEvent = "molten:review:forecast"
)

const (
	ForecastStateReady  = "ready"
	ForecastStateFailed = "failed"

	// Whether the base requires branches to be up to date before merging: then every merge makes every other PR
	// rebase and rerun its CI, whatever the order.
	UpToDateRequired    = "required"
	UpToDateNotRequired = "notrequired"
	UpToDateUnknown     = "unknown"

	// Why a forecast could not run (Forecast.Error), worded by the window.
	ForecastErrorNoGit       = "nogit"
	ForecastErrorBase        = "base"
	ForecastErrorFailed      = "failed"
	ForecastErrorTooMany     = "toomany"
	forecastTimeout          = 3 * time.Minute
	forecastProtectionMaxAge = 10 * time.Minute
	forecastRetryAfter       = time.Minute
	// The open PRs one forecast reads (ready ones first); past it the forecast says it did not run.
	MaxForecastPrs = 40
)

type ForecastRequest struct {
	Dir     string        `json:"dir"`
	Repo    string        `json:"repo"`
	Base    string        `json:"base"`
	BaseOid string        `json:"baseoid"`
	Prs     []forecast.Pr `json:"prs"`
	// Force: computed again even when the PRs and the base did not move (the list's refresh).
	Force bool `json:"force,omitempty"`
}

type Forecast struct {
	Dir     string `json:"dir"`
	Repo    string `json:"repo,omitempty"`
	Base    string `json:"base,omitempty"`
	BaseOid string `json:"baseoid,omitempty"`
	// Key names the base and heads the forecast is for; the window compares it with what it shows.
	Key string `json:"key"`
	// State: the last computation's, "" before the first one ended.
	State string `json:"state"`
	// Running: a computation runs; Stale: the answer is for other heads or another base than the last asked.
	Running bool `json:"running,omitempty"`
	Stale   bool `json:"stale,omitempty"`
	// Method: the merge method simulated, the repository's (the Validate plan's default).
	Method      string         `json:"method,omitempty"`
	Approximate bool           `json:"approximate,omitempty"`
	UpToDate    string         `json:"uptodate,omitempty"`
	Rows        []forecast.Row `json:"rows"`
	Stats       forecast.Stats `json:"stats"`
	Error       string         `json:"error,omitempty"`
	Message     string         `json:"message,omitempty"`
	// At: when the computation ended, Ms: how long it took, in milliseconds.
	At int64 `json:"at,omitempty"`
	Ms int64 `json:"ms,omitempty"`
}

// ForecastEnv is what the forecast reads outside its private store; the tests give fakes.
type ForecastEnv struct {
	Git forecast.Git
	// StoreDir holds the projects' private stores.
	StoreDir string
	// Rules: the repository's merge method and whether its base requires up-to-date branches (UpToDate…).
	Rules   func(ctx context.Context, dir string, repo string, base string) (string, string)
	Publish func(Forecast)
	Now     func() time.Time
}

type forecastState struct {
	engine  *forecast.Engine
	answer  Forecast
	running bool
	// asked: the last request; a computation ending on another key runs again for it.
	asked ForecastRequest
	key   string
}

type Forecaster struct {
	env    ForecastEnv
	lock   sync.Mutex
	states map[string]*forecastState
	// done is signalled when a background computation ends; tests wait on it.
	done chan string
}

func MakeForecaster(env ForecastEnv) *Forecaster {
	if env.Now == nil {
		env.Now = time.Now
	}
	return &Forecaster{env: env, states: map[string]*forecastState{}}
}

// ForecastKey names what a forecast is computed for: the base, the method's inputs and every PR's head.
func ForecastKey(req ForecastRequest) string {
	parts := make([]string, 0, len(req.Prs))
	for _, pr := range req.Prs {
		ready := ""
		if pr.Ready {
			ready = "r"
		}
		parts = append(parts, fmt.Sprintf("%d@%s%s", pr.Number, pr.HeadOid, ready))
	}
	sort.Strings(parts)
	return req.Base + "@" + req.BaseOid + "|" + strings.Join(parts, ",")
}

func checkForecastRequest(req ForecastRequest) error {
	if err := checkDir(req.Dir); err != nil {
		return err
	}
	if err := checkRepo(req.Repo); err != nil {
		return err
	}
	if !reviewsession.ValidRef(req.Base) || !isOid(req.BaseOid) {
		return errors.New("base and baseoid must name the PRs' base branch and its commit")
	}
	for _, pr := range req.Prs {
		if pr.Number <= 0 || !reviewsession.ValidRef(pr.Branch) || !isOid(pr.HeadOid) {
			return fmt.Errorf("PR #%d must name its branch and head commit", pr.Number)
		}
	}
	return nil
}

// storeOf is a project's private store: one per checkout, since it borrows that checkout's objects.
func (f *Forecaster) storeOf(dir string) string {
	sum := sha256.Sum256([]byte(dir))
	return filepath.Join(f.env.StoreDir, hex.EncodeToString(sum[:8])+".git")
}

// Get answers the project's last forecast at once and starts a computation when the PRs or the base moved since, or
// when forced. The answer says Running and Stale while it does.
func (f *Forecaster) Get(req ForecastRequest) (Forecast, error) {
	if err := checkForecastRequest(req); err != nil {
		return Forecast{}, err
	}
	req.Dir = filepath.Clean(req.Dir)
	key := ForecastKey(req)
	start, answer := f.prepare(req, key)
	if start {
		go f.runLoop(req.Dir)
	}
	return answer, nil
}

func (f *Forecaster) prepare(req ForecastRequest, key string) (bool, Forecast) {
	f.lock.Lock()
	defer f.lock.Unlock()
	state := f.states[req.Dir]
	if state == nil {
		state = &forecastState{engine: forecast.MakeEngine(f.env.Git, f.storeOf(req.Dir))}
		state.answer = Forecast{Dir: req.Dir, Rows: []forecast.Row{}}
		f.states[req.Dir] = state
	}
	// A failed forecast (origin unreachable, a git error) is tried again on a later ask, at most once a minute.
	retry := state.answer.State == ForecastStateFailed && f.env.Now().UnixMilli()-state.answer.At >= forecastRetryAfter.Milliseconds()
	due := req.Force || retry || state.answer.Key != key || state.answer.State == ""
	if due {
		state.asked, state.key = req, key
	}
	start := due && !state.running
	if start {
		state.running = true
	}
	return start, f.answerLocked(state)
}

func (f *Forecaster) answerLocked(state *forecastState) Forecast {
	answer := state.answer
	answer.Running = state.running
	answer.Stale = state.key != "" && answer.Key != state.key
	return answer
}

// runLoop computes until the last request is answered: a request made while one runs is computed after it.
func (f *Forecaster) runLoop(dir string) {
	defer func() {
		if rec := recover(); rec != nil {
			panichandler.PanicHandler("molten:review:forecast", rec)
			f.end(dir, nil)
		}
	}()
	for {
		req, key, engine := f.take(dir)
		answer := f.compute(engine, req, key)
		if again := f.end(dir, &answer); !again {
			return
		}
	}
}

func (f *Forecaster) take(dir string) (ForecastRequest, string, *forecast.Engine) {
	f.lock.Lock()
	defer f.lock.Unlock()
	state := f.states[dir]
	return state.asked, state.key, state.engine
}

// end keeps a computation's answer and publishes it; true when another request came meanwhile.
func (f *Forecaster) end(dir string, answer *Forecast) bool {
	again, published := f.endLocked(dir, answer)
	if f.env.Publish != nil {
		f.env.Publish(published)
	}
	if !again && f.done != nil {
		f.done <- dir
	}
	return again
}

func (f *Forecaster) endLocked(dir string, answer *Forecast) (bool, Forecast) {
	f.lock.Lock()
	defer f.lock.Unlock()
	state := f.states[dir]
	if answer != nil {
		state.answer = *answer
	}
	again := answer != nil && state.answer.Key != state.key
	state.running = again
	return again, f.answerLocked(state)
}

// compute runs one forecast: the merge method and the up-to-date rule from GitHub (cached), then the simulation.
func (f *Forecaster) compute(engine *forecast.Engine, req ForecastRequest, key string) Forecast {
	started := f.env.Now()
	answer := Forecast{Dir: req.Dir, Repo: req.Repo, Base: req.Base, BaseOid: req.BaseOid, Key: key, Rows: []forecast.Row{}}
	finish := func(state string) Forecast {
		answer.State = state
		answer.At = f.env.Now().UnixMilli()
		answer.Ms = f.env.Now().Sub(started).Milliseconds()
		return answer
	}
	if len(req.Prs) > MaxForecastPrs {
		answer.Error = ForecastErrorTooMany
		return finish(ForecastStateFailed)
	}
	ctx, cancel := context.WithTimeout(context.Background(), forecastTimeout)
	defer cancel()
	method, upToDate := forecast.MethodMerge, UpToDateUnknown
	if f.env.Rules != nil {
		method, upToDate = f.env.Rules(ctx, req.Dir, req.Repo, req.Base)
	}
	answer.Method, answer.UpToDate = method, upToDate
	result, err := engine.Compute(ctx, forecast.Input{Dir: req.Dir, Base: req.Base, BaseOid: req.BaseOid, Method: method, Prs: req.Prs})
	if err != nil {
		answer.Error, answer.Message = forecastErrorOf(err), maskTokens(err.Error())
		log.Printf("%s forecast of %s: %v\n", logPrefix, req.Dir, err)
		return finish(ForecastStateFailed)
	}
	answer.Rows, answer.Stats, answer.Approximate = result.Rows, result.Stats, result.Approximate
	return finish(ForecastStateReady)
}

func forecastErrorOf(err error) string {
	switch {
	case errors.Is(err, forecast.ErrBaseMissing):
		return ForecastErrorBase
	case strings.Contains(err.Error(), "not a git repository"):
		return ForecastErrorNoGit
	}
	return ForecastErrorFailed
}

// liveForecastGit runs git for the forecast with the login shell's PATH (mission.ExecRunner's).
func liveForecastGit(ctx context.Context, input []byte, env []string, args ...string) ([]byte, error) {
	if len(env) > 0 {
		ctx = mission.WithRunEnv(ctx, env...)
	}
	return mission.ExecRunnerInput(ctx, "", input, "git", args...)
}

type protectionRead struct {
	value string
	at    time.Time
}

// forecastRules is the forecast's view of a repository: Validate's default merge method, and whether the base
// requires up-to-date branches, from its rulesets (strict required status checks) or its classic protection.
type forecastRules struct {
	merger *Merger
	now    func() time.Time

	lock       sync.Mutex
	protection map[string]protectionRead
}

func (r *forecastRules) cached(key string) (string, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	read, ok := r.protection[key]
	if !ok || r.now().Sub(read.at) > forecastProtectionMaxAge {
		return "", false
	}
	return read.value, true
}

func (r *forecastRules) keep(key string, value string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.protection[key] = protectionRead{value: value, at: r.now()}
}

func (r *forecastRules) Rules(ctx context.Context, dir string, repo string, base string) (string, string) {
	method := r.merger.planMethods(ctx, dir, repo, base).method
	rules, rulesOk := r.merger.readBranchRulesOk(ctx, dir, repo, base)
	if rules.strict {
		return method, UpToDateRequired
	}
	classic := r.classic(ctx, dir, repo, base)
	switch {
	case classic == UpToDateRequired:
		return method, UpToDateRequired
	case classic == UpToDateNotRequired && rulesOk:
		return method, UpToDateNotRequired
	}
	return method, UpToDateUnknown
}

// classic reads the base's classic branch protection. Its required checks need admin rights to read: a protected
// branch whose checks cannot be read leaves the rule unknown.
func (r *forecastRules) classic(ctx context.Context, dir string, repo string, base string) string {
	key := repo + "\x00" + base
	if value, ok := r.cached(key); ok {
		return value
	}
	value := r.readClassic(ctx, dir, repo, base)
	r.keep(key, value)
	return value
}

func (r *forecastRules) readClassic(ctx context.Context, dir string, repo string, base string) string {
	branch := "repos/" + repo + "/branches/" + url.PathEscape(base)
	out, err := r.merger.runGhApi(ctx, dir, branch+"/protection/required_status_checks")
	if err == nil {
		var checks struct {
			Strict bool `json:"strict"`
		}
		if json.Unmarshal(out, &checks) != nil {
			return UpToDateUnknown
		}
		if checks.Strict {
			return UpToDateRequired
		}
		return UpToDateNotRequired
	}
	if !strings.Contains(err.Error(), "404") {
		return UpToDateUnknown
	}
	out, err = r.merger.runGhApi(ctx, dir, branch)
	if err != nil {
		return UpToDateUnknown
	}
	var info struct {
		Protected bool `json:"protected"`
	}
	if json.Unmarshal(out, &info) != nil || info.Protected {
		return UpToDateUnknown
	}
	return UpToDateNotRequired
}

func makeForecastRules(merger *Merger) *forecastRules {
	return &forecastRules{merger: merger, now: time.Now, protection: map[string]protectionRead{}}
}
