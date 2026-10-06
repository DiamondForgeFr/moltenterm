// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Codex's sources (FR-SHELL-029, DS-SHELL-033), best first:
//   - codex-transcript: the latest `rate_limits` Codex writes into its session rollout with each token_count event,
//     which the companion already follows. Undocumented, but local: no network, no credential, no file of its own.
//   - codex-appserver: Codex's documented app-server protocol (`account/rateLimits/read`), run through the user's own
//     `codex` so that Codex uses its own sign-in, only when the transcript has nothing or on Refresh.
//
// MoltenTerm never reads ~/.codex/auth.json or any Codex credential: the app-server is Codex's own process.

const (
	CodexTranscriptSourceId = "codex-transcript"
	CodexAppServerSourceId  = "codex-appserver"

	codexMainLimit  = "codex"
	maxCodexBuckets = 8

	// Refresh cost (NFR-SHELL-013): a process source runs by itself at most this often, on Refresh at most once a
	// minute, and backs off doubling up to an hour after failures.
	codexAutoInterval   = 5 * time.Minute
	codexManualInterval = time.Minute
	codexMaxBackoff     = 60 * time.Minute
)

// CodexLimitsRecord is one `rate_limits` object of a token_count event, as Codex wrote it, and the record's time.
type CodexLimitsRecord struct {
	LimitId    string
	RateLimits map[string]any
	At         int64
}

// CodexTranscriptLimits is what a Codex session's rollout gave of the plan limits: the latest record of each metered
// bucket, and whether a token_count came without any (an API key sign-in has no plan limits).
type CodexTranscriptLimits struct {
	Records  []CodexLimitsRecord
	NoLimits bool
	// Loading: the companion has not read the whole session yet, so no record does not mean there is none.
	Loading bool
}

// Add keeps a token_count's `rate_limits` (any JSON value: an unknown shape is kept and reported as such when read).
func (l *CodexTranscriptLimits) Add(rateLimits any, at int64) {
	if rateLimits == nil {
		l.NoLimits = true
		return
	}
	rec, _ := rateLimits.(map[string]any)
	limitId := looseText(rec, "limit_id", "limitId")
	for i := range l.Records {
		if l.Records[i].LimitId == limitId {
			l.Records[i] = CodexLimitsRecord{LimitId: limitId, RateLimits: rec, At: at}
			return
		}
	}
	if len(l.Records) >= maxCodexBuckets {
		oldest := 0
		for i := range l.Records {
			if l.Records[i].At < l.Records[oldest].At {
				oldest = i
			}
		}
		l.Records = append(l.Records[:oldest], l.Records[oldest+1:]...)
	}
	l.Records = append(l.Records, CodexLimitsRecord{LimitId: limitId, RateLimits: rec, At: at})
}

// Copy returns limits that share nothing writable with l: the records' maps are never changed once decoded.
func (l CodexTranscriptLimits) Copy() CodexTranscriptLimits {
	l.Records = append([]CodexLimitsRecord(nil), l.Records...)
	return l
}

// Fields are read loosely, in Codex's snake_case (rollouts) or camelCase (app-server): an unknown shape is skipped.

func looseValue(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

func looseText(m map[string]any, keys ...string) string {
	switch v := looseValue(m, keys...).(type) {
	case string:
		return v
	case float64:
		return fmt.Sprintf("%g", v)
	}
	return ""
}

func looseNumber(m map[string]any, keys ...string) (float64, bool) {
	v, ok := looseValue(m, keys...).(float64)
	if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

func looseFlag(m map[string]any, keys ...string) bool {
	v, _ := looseValue(m, keys...).(bool)
	return v
}

func looseObject(m map[string]any, keys ...string) map[string]any {
	v, _ := looseValue(m, keys...).(map[string]any)
	return v
}

// CodexWindowLabel names a window from its length, as Codex's /status does.
func CodexWindowLabel(mins int64) string {
	switch {
	case mins == fiveHourMins:
		return "5-hour"
	case mins == sevenDayMins:
		return "This week"
	case mins%(24*60) == 0:
		return fmt.Sprintf("%d-day", mins/(24*60))
	case mins%60 == 0:
		return fmt.Sprintf("%d-hour", mins/60)
	}
	return fmt.Sprintf("%d-min", mins)
}

func codexWindowId(mainBucket bool, limitId string, mins int64) string {
	if !mainBucket {
		return fmt.Sprintf("%s%s/%d", WindowModelPrefix, limitId, mins)
	}
	switch mins {
	case fiveHourMins:
		return WindowSession
	case sevenDayMins:
		return WindowWeek
	}
	return fmt.Sprintf("%s%d", WindowLengthPrefix, mins)
}

type codexBucket struct {
	limitId string
	raw     map[string]any
	at      int64
}

func isMainBucket(limitId string) bool {
	return limitId == "" || limitId == codexMainLimit
}

// sortCodexBuckets puts the main `codex` bucket first, the others by id, so a merge keeps the main windows.
func sortCodexBuckets(buckets []codexBucket) {
	sort.SliceStable(buckets, func(i, j int) bool {
		mi, mj := isMainBucket(buckets[i].limitId), isMainBucket(buckets[j].limitId)
		if mi != mj {
			return mi
		}
		return buckets[i].limitId < buckets[j].limitId
	})
}

// codexSnapshot reads rate limit buckets, from a rollout or the app-server. Nothing in them gives "noplan"; something
// MoltenTerm cannot read gives "format".
func codexSnapshot(source string, buckets []codexBucket, readAt int64) (UsageSnapshot, error) {
	sortCodexBuckets(buckets)
	snap := UsageSnapshot{Agent: "codex", Source: source, ReadAt: readAt}
	seen := map[string]bool{}
	present := false
	for _, b := range buckets {
		if b.raw == nil {
			present = true
			continue
		}
		main := isMainBucket(b.limitId)
		name := looseText(b.raw, "limit_name", "limitName")
		if name == "" {
			name = b.limitId
		}
		for _, slot := range []string{"primary", "secondary"} {
			if b.raw[slot] == nil {
				continue
			}
			present = true
			w, ok := codexWindow(looseObject(b.raw, slot), main, b.limitId, name, b.at)
			if !ok || seen[w.Id] {
				continue
			}
			seen[w.Id] = true
			snap.Windows = append(snap.Windows, w)
		}
		if c := looseObject(b.raw, "credits"); c != nil {
			present = true
			has, unlimited := looseFlag(c, "has_credits", "hasCredits"), looseFlag(c, "unlimited")
			if snap.Credits == nil && (has || unlimited) {
				snap.Credits = &UsageCredits{Enabled: true, Unlimited: unlimited, Balance: looseText(c, "balance")}
			}
		}
		if snap.Plan == "" {
			snap.Plan = looseText(b.raw, "plan_type", "planType")
		}
	}
	if len(snap.Windows) > 0 || snap.Credits != nil {
		return snap, nil
	}
	if !present {
		return UsageSnapshot{}, Unavailable(ReasonNoPlan)
	}
	return UsageSnapshot{}, Unavailable(ReasonFormat)
}

// codexWindow reads {used_percent, window_minutes, resets_at} (seconds). The oldest rollouts gave resets_in_seconds,
// from the record's time. A window without a length cannot be labelled: it is skipped.
func codexWindow(w map[string]any, main bool, limitId string, name string, at int64) (UsageWindow, bool) {
	if w == nil {
		return UsageWindow{}, false
	}
	used, ok := looseNumber(w, "used_percent", "usedPercent")
	if !ok {
		return UsageWindow{}, false
	}
	mins, ok := looseNumber(w, "window_minutes", "windowDurationMins")
	if !ok || mins <= 0 || mins != math.Trunc(mins) {
		return UsageWindow{}, false
	}
	rtn := UsageWindow{
		Id:          codexWindowId(main, limitId, int64(mins)),
		Label:       CodexWindowLabel(int64(mins)),
		UsedPercent: used,
		WindowMins:  int64(mins),
	}
	if !main {
		rtn.Label = name + " " + rtn.Label
	}
	if resets, ok := looseNumber(w, "resets_at", "resetsAt"); ok && resets > 0 {
		rtn.ResetsAt = int64(resets) * 1000
	} else if in, ok := looseNumber(w, "resets_in_seconds", "resetsInSeconds"); ok && in > 0 && at > 0 {
		rtn.ResetsAt = at + int64(in*1000)
	}
	return rtn, true
}

// live tells whether a snapshot still holds something: a window before its reset, or credits.
func live(snap *UsageSnapshot, nowMs int64) bool {
	if snap == nil {
		return false
	}
	if snap.Credits != nil {
		return true
	}
	for _, w := range snap.Windows {
		if w.ResetsAt == 0 || w.ResetsAt > nowMs {
			return true
		}
	}
	return false
}

type noProcessKey struct{}

// WithoutProcess marks a read that must not start a process: the companion publishing what the session just gave
// never waits for the app-server.
func WithoutProcess(ctx context.Context) context.Context {
	return context.WithValue(ctx, noProcessKey{}, true)
}

func processAllowed(ctx context.Context) bool {
	no, _ := ctx.Value(noProcessKey{}).(bool)
	return !no
}

// CodexAppServerRun reads the limits once through `codex app-server`: the `account/rateLimits/read` result.
type CodexAppServerRun func(ctx context.Context) (map[string]any, error)

// CodexUsage is the state both Codex sources share: the companion's lookup of a block's session, and the app-server's
// last read, kept in memory only while Codex's gauges show (NFR-SHELL-011).
type CodexUsage struct {
	lock       sync.Mutex
	transcript func(blockId string) (CodexTranscriptLimits, bool)
	run        CodexAppServerRun
	now        func() time.Time
	// One app-server at a time; a read waiting for it takes its result.
	sem chan struct{}

	snapshot   *UsageSnapshot
	reason     string
	completed  int64
	manualAt   time.Time
	nextAuto   time.Time
	failures   int
	generation int64
}

func MakeCodexUsage(run CodexAppServerRun) *CodexUsage {
	return &CodexUsage{run: run, now: time.Now, sem: make(chan struct{}, 1)}
}

// DefaultCodexUsage is the built-in Codex adapter's state; the companion gives it the session lookup at start.
var DefaultCodexUsage = MakeCodexUsage(RunCodexAppServer)

// SetRun replaces how the app-server is run (tests: a fake, never the user's own codex).
func (cu *CodexUsage) SetRun(run CodexAppServerRun) {
	cu.lock.Lock()
	defer cu.lock.Unlock()
	cu.run = run
}

// SetTranscript gives the lookup of the Codex session the companion follows for a block.
func (cu *CodexUsage) SetTranscript(lookup func(blockId string) (CodexTranscriptLimits, bool)) {
	cu.lock.Lock()
	defer cu.lock.Unlock()
	cu.transcript = lookup
}

func (cu *CodexUsage) transcriptOf(blockId string) (CodexTranscriptLimits, bool) {
	cu.lock.Lock()
	lookup := cu.transcript
	cu.lock.Unlock()
	if lookup == nil {
		return CodexTranscriptLimits{}, false
	}
	return lookup(blockId)
}

func (cu *CodexUsage) readTranscript(blockId string) (UsageSnapshot, error) {
	lim, ok := cu.transcriptOf(blockId)
	return cu.transcriptSnapshot(lim, ok)
}

func (cu *CodexUsage) transcriptSnapshot(lim CodexTranscriptLimits, ok bool) (UsageSnapshot, error) {
	if !ok || len(lim.Records) == 0 {
		if ok && lim.NoLimits {
			return UsageSnapshot{}, Unavailable(ReasonNoPlan)
		}
		return UsageSnapshot{}, Unavailable(ReasonWaiting)
	}
	buckets := make([]codexBucket, 0, len(lim.Records))
	readAt := int64(0)
	for _, r := range lim.Records {
		buckets = append(buckets, codexBucket{limitId: r.LimitId, raw: r.RateLimits, at: r.At})
		readAt = max(readAt, r.At)
	}
	if readAt == 0 {
		readAt = cu.now().UnixMilli()
	}
	return codexSnapshot(CodexTranscriptSourceId, buckets, readAt)
}

func (cu *CodexUsage) lastReason() string {
	cu.lock.Lock()
	defer cu.lock.Unlock()
	if cu.reason == "" {
		return ReasonFailed
	}
	return cu.reason
}

func (cu *CodexUsage) cached() *UsageSnapshot {
	cu.lock.Lock()
	defer cu.lock.Unlock()
	return cu.snapshot
}

// Clear drops the app-server's last read; the throttles stay, so hiding and showing again costs no extra process.
func (cu *CodexUsage) Clear() {
	cu.lock.Lock()
	defer cu.lock.Unlock()
	cu.snapshot, cu.reason = nil, ""
	cu.generation++
}

// Reset forgets the values and the throttles too (tests).
func (cu *CodexUsage) Reset() {
	cu.lock.Lock()
	defer cu.lock.Unlock()
	cu.snapshot, cu.reason = nil, ""
	cu.manualAt, cu.nextAuto, cu.failures = time.Time{}, time.Time{}, 0
	cu.generation++
}

// decide tells whether this read runs the app-server, else what it answers. skipAuto: the session has values (or is
// still being read), or the read may not start a process.
func (cu *CodexUsage) decide(refresh bool, skipAuto bool, now time.Time) (*UsageSnapshot, string, bool) {
	cu.lock.Lock()
	defer cu.lock.Unlock()
	cached := cu.snapshot
	if !live(cached, now.UnixMilli()) {
		cached = nil
	}
	reason := cu.reason
	if reason == "" {
		reason = ReasonWaiting
	}
	if refresh {
		if now.Sub(cu.manualAt) < codexManualInterval {
			return cached, reason, false
		}
		cu.manualAt = now
		return nil, "", true
	}
	if skipAuto || cached != nil || now.Before(cu.nextAuto) {
		return cached, reason, false
	}
	return nil, "", true
}

func (cu *CodexUsage) runState() (int64, int64) {
	cu.lock.Lock()
	defer cu.lock.Unlock()
	return cu.completed, cu.generation
}

func (cu *CodexUsage) record(snap *UsageSnapshot, err error, generation int64, now time.Time) {
	cu.lock.Lock()
	defer cu.lock.Unlock()
	cu.completed++
	if err != nil {
		cu.failures++
		backoff := codexAutoInterval << min(cu.failures-1, 4)
		cu.nextAuto = now.Add(min(backoff, codexMaxBackoff))
		if cu.generation == generation {
			cu.reason = ReasonOf(err)
		}
		return
	}
	cu.failures = 0
	cu.nextAuto = now.Add(codexAutoInterval)
	if cu.generation == generation {
		cu.snapshot, cu.reason = snap, ""
	}
}

// readAppServer runs one app-server read, or takes the result of the one another read was waiting for.
func (cu *CodexUsage) readAppServer(ctx context.Context) (UsageSnapshot, error) {
	cu.lock.Lock()
	run := cu.run
	cu.lock.Unlock()
	if run == nil {
		return UsageSnapshot{}, Unavailable(ReasonFailed)
	}
	before, _ := cu.runState()
	select {
	case cu.sem <- struct{}{}:
	case <-ctx.Done():
		return UsageSnapshot{}, Unavailable(ReasonFailed)
	}
	defer func() { <-cu.sem }()
	completed, generation := cu.runState()
	if completed != before {
		if snap := cu.cached(); snap != nil {
			return *snap, nil
		}
		return UsageSnapshot{}, Unavailable(cu.lastReason())
	}
	now := cu.now()
	result, err := run(ctx)
	var snap UsageSnapshot
	if err == nil {
		snap, err = codexAppServerSnapshot(result, now.UnixMilli())
	}
	if err != nil {
		cu.record(nil, err, generation, now)
		return UsageSnapshot{}, err
	}
	cu.record(&snap, nil, generation, now)
	return snap, nil
}

// refresh runs a manual app-server read, at most once a minute. The app-server source then answers its result.
func (cu *CodexUsage) refresh(ctx context.Context) {
	if _, _, run := cu.decide(true, false, cu.now()); run {
		cu.readAppServer(ctx)
	}
}

// codexAppServerSnapshot reads `account/rateLimits/read`'s result: rateLimitsByLimitId, else the single rateLimits.
func codexAppServerSnapshot(result map[string]any, readAt int64) (UsageSnapshot, error) {
	if result == nil {
		return UsageSnapshot{}, Unavailable(ReasonFormat)
	}
	var buckets []codexBucket
	if byId := looseObject(result, "rateLimitsByLimitId"); len(byId) > 0 {
		for id, raw := range byId {
			bucket, _ := raw.(map[string]any)
			if limitId := looseText(bucket, "limitId"); limitId != "" {
				id = limitId
			}
			buckets = append(buckets, codexBucket{limitId: id, raw: bucket, at: readAt})
		}
	} else if single, ok := result["rateLimits"]; ok {
		bucket, _ := single.(map[string]any)
		buckets = append(buckets, codexBucket{limitId: looseText(bucket, "limitId"), raw: bucket, at: readAt})
	}
	if len(buckets) == 0 {
		return UsageSnapshot{}, Unavailable(ReasonFormat)
	}
	if len(buckets) > maxCodexBuckets {
		sortCodexBuckets(buckets)
		buckets = buckets[:maxCodexBuckets]
	}
	return codexSnapshot(CodexAppServerSourceId, buckets, readAt)
}

type codexTranscriptSource struct {
	cu *CodexUsage
}

// MakeCodexTranscriptSource reads the rate limits of the Codex session the block's companion follows.
func MakeCodexTranscriptSource(cu *CodexUsage) GaugesSource {
	return &codexTranscriptSource{cu: cu}
}

func (s *codexTranscriptSource) Id() string       { return CodexTranscriptSourceId }
func (s *codexTranscriptSource) Name() string     { return "Codex session log" }
func (s *codexTranscriptSource) Documented() bool { return false }

func (s *codexTranscriptSource) Enabled(settings *wconfig.SettingsType) bool {
	return GaugesOn(settings, "codex")
}

// Read gives way to an app-server read newer than the session's last record (a Refresh), until Codex writes a newer
// one: the windows merge best source first, so the older values would otherwise hide the refreshed ones.
func (s *codexTranscriptSource) Read(ctx context.Context, blockId string) (UsageSnapshot, error) {
	if IsRefresh(ctx) && processAllowed(ctx) {
		// Refresh reads the app-server before this source answers, so the newer values can win.
		s.cu.refresh(ctx)
	}
	snap, err := s.cu.readTranscript(blockId)
	if err != nil {
		return snap, err
	}
	nowMs := s.cu.now().UnixMilli()
	if !live(&snap, nowMs) {
		return UsageSnapshot{}, Unavailable(ReasonExpired)
	}
	if app := s.cu.cached(); live(app, nowMs) && app.ReadAt > snap.ReadAt {
		return UsageSnapshot{}, Unavailable(ReasonWaiting)
	}
	return snap, nil
}

type codexAppServerSource struct {
	cu *CodexUsage
}

// MakeCodexAppServerSource reads the limits through Codex's app-server when the session has none, or on Refresh.
func MakeCodexAppServerSource(cu *CodexUsage) GaugesSource {
	return &codexAppServerSource{cu: cu}
}

func (s *codexAppServerSource) Id() string       { return CodexAppServerSourceId }
func (s *codexAppServerSource) Name() string     { return "Codex app-server" }
func (s *codexAppServerSource) Documented() bool { return true }

func (s *codexAppServerSource) Enabled(settings *wconfig.SettingsType) bool {
	return GaugesOn(settings, "codex")
}

// Read runs the app-server on Refresh, or when the session, read through, holds no live window; a read that may not
// start a process answers what the last run gave, unless the session's values are newer.
func (s *codexAppServerSource) Read(ctx context.Context, blockId string) (UsageSnapshot, error) {
	now := s.cu.now()
	lim, ok := s.cu.transcriptOf(blockId)
	transcript, err := s.cu.transcriptSnapshot(lim, ok)
	transcriptLive := err == nil && live(&transcript, now.UnixMilli())
	cached, reason, run := s.cu.decide(IsRefresh(ctx), lim.Loading || transcriptLive || !processAllowed(ctx), now)
	if !run {
		if cached != nil && transcriptLive && transcript.ReadAt >= cached.ReadAt {
			// Older than the session's values: none of it holds any longer, credits included.
			return UsageSnapshot{}, Unavailable(ReasonWaiting)
		}
		if cached != nil {
			return *cached, nil
		}
		return UsageSnapshot{}, Unavailable(reason)
	}
	return s.cu.readAppServer(ctx)
}

func (s *codexAppServerSource) Clear() {
	s.cu.Clear()
}
