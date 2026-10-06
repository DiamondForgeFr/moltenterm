// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func decodeJSON(t *testing.T, text string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		t.Fatalf("bad fixture %s: %v", text, err)
	}
	return v
}

func transcriptOf(t *testing.T, at int64, records ...string) CodexTranscriptLimits {
	var lim CodexTranscriptLimits
	for _, r := range records {
		if r == "null" {
			lim.Add(nil, at)
			continue
		}
		lim.Add(decodeJSON(t, r), at)
	}
	return lim
}

func TestCodexWindowLabels(t *testing.T) {
	cases := map[int64]string{300: "5-hour", 10080: "This week", 60: "1-hour", 1440: "1-day", 4320: "3-day", 90: "90-min"}
	for mins, want := range cases {
		if got := CodexWindowLabel(mins); got != want {
			t.Errorf("%d: %q, want %q", mins, got, want)
		}
	}
}

func TestCodexTranscriptSnapshot(t *testing.T) {
	now := time.Now()
	at := now.Add(-3 * time.Minute).UnixMilli()
	resets := now.Add(2 * time.Hour).Unix()
	weekResets := now.Add(4 * 24 * time.Hour).Unix()
	cu := MakeCodexUsage(nil)
	current := `{"limit_id":"codex","primary":{"used_percent":42.5,"window_minutes":300,"resets_at":` + strconv.FormatInt(resets, 10) +
		`},"secondary":{"used_percent":12,"window_minutes":10080,"resets_at":` + strconv.FormatInt(weekResets, 10) +
		`},"credits":{"has_credits":true,"unlimited":false,"balance":"17.5"},"plan_type":"plus","new_field":{"x":1}}`
	snap, err := cu.transcriptSnapshot(transcriptOf(t, at, current), true)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Source != CodexTranscriptSourceId || snap.ReadAt != at || snap.Plan != "plus" || len(snap.Windows) != 2 {
		t.Fatalf("snapshot: %+v", snap)
	}
	if w := snap.Windows[0]; w.Id != WindowSession || w.Label != "5-hour" || w.UsedPercent != 42.5 || w.ResetsAt != resets*1000 || w.WindowMins != 300 {
		t.Errorf("primary: %+v", w)
	}
	if w := snap.Windows[1]; w.Id != WindowWeek || w.Label != "This week" || w.ResetsAt != weekResets*1000 {
		t.Errorf("secondary: %+v", w)
	}
	if c := snap.Credits; c == nil || !c.Enabled || c.Balance != "17.5" || c.Unlimited {
		t.Errorf("credits: %+v", c)
	}

	legacy := `{"primary":{"used_percent":5,"window_minutes":300,"resets_in_seconds":600},"secondary":null}`
	snap, err = cu.transcriptSnapshot(transcriptOf(t, at, legacy), true)
	if err != nil || len(snap.Windows) != 1 || snap.Windows[0].ResetsAt != at+600*1000 || snap.Credits != nil {
		t.Errorf("oldest rollouts (resets_in_seconds, no credits): %+v %v", snap, err)
	}

	noCredits := `{"primary":{"used_percent":5,"window_minutes":60},"credits":{"has_credits":false,"unlimited":false,"balance":null}}`
	snap, err = cu.transcriptSnapshot(transcriptOf(t, at, noCredits), true)
	if err != nil || snap.Credits != nil || snap.Windows[0].Id != WindowLengthPrefix+"60" || snap.Windows[0].Label != "1-hour" {
		t.Errorf("a plan without credits has no credits line: %+v %v", snap, err)
	}

	other := `{"limit_id":"codex_spark","limit_name":"Spark","primary":{"used_percent":80,"window_minutes":300}}`
	snap, err = cu.transcriptSnapshot(transcriptOf(t, at, other, current), true)
	if err != nil || len(snap.Windows) != 3 {
		t.Fatalf("two buckets: %+v %v", snap, err)
	}
	if snap.Windows[0].Id != WindowSession || snap.Windows[2].Id != "model:codex_spark/300" || snap.Windows[2].Label != "Spark 5-hour" {
		t.Errorf("the main bucket first, another one by its name: %+v", snap.Windows)
	}

	reasons := map[string]CodexTranscriptLimits{
		ReasonWaiting: {},
		ReasonNoPlan:  transcriptOf(t, at, "null"),
		ReasonFormat:  transcriptOf(t, at, `{"primary":{"percent":"high"}}`),
	}
	for want, lim := range reasons {
		if _, err := cu.transcriptSnapshot(lim, true); ReasonOf(err) != want {
			t.Errorf("%s: %v", want, err)
		}
	}
	if _, err := cu.transcriptSnapshot(transcriptOf(t, at, `"a string"`), true); ReasonOf(err) != ReasonFormat {
		t.Errorf("not an object: %v", err)
	}
	if _, err := cu.transcriptSnapshot(transcriptOf(t, at, `{"primary":null,"secondary":null,"credits":null}`), true); ReasonOf(err) != ReasonNoPlan {
		t.Errorf("all empty: %v", err)
	}
	if _, err := cu.transcriptSnapshot(transcriptOf(t, at, `{"primary":{"used_percent":3}}`), true); ReasonOf(err) != ReasonFormat {
		t.Errorf("a window without its length cannot be labelled: %v", err)
	}
	lim := transcriptOf(t, at, "null", current)
	if _, err := cu.transcriptSnapshot(lim, true); err != nil {
		t.Errorf("an earlier token_count without limits does not hide later ones: %v", err)
	}
}

func TestCodexTranscriptLimitsBounded(t *testing.T) {
	var lim CodexTranscriptLimits
	for i := 0; i < 3*maxCodexBuckets; i++ {
		lim.Add(map[string]any{"limit_id": "b" + strconv.Itoa(i)}, int64(i))
	}
	lim.Add(map[string]any{"limit_id": "b23", "x": 1}, 100)
	if len(lim.Records) != maxCodexBuckets {
		t.Fatalf("buckets kept: %d", len(lim.Records))
	}
	for _, r := range lim.Records {
		if r.LimitId == "b23" && r.At != 100 {
			t.Errorf("a bucket's newer record replaces its older one: %+v", r)
		}
	}
}

func TestCodexAppServerSnapshot(t *testing.T) {
	readAt := time.Now().UnixMilli()
	byId := decodeJSON(t, `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":15,"resetsAt":4102444800}},
		"rateLimitsByLimitId":{"codex_other":{"limitId":"codex_other","limitName":"codex_other","primary":{"usedPercent":42,"windowDurationMins":60,"resetsAt":4102444800}},
		"codex":{"limitId":"codex","limitName":null,"primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":4102444800},"secondary":{"usedPercent":61,"windowDurationMins":10080,"resetsAt":null},
		"credits":{"hasCredits":false,"unlimited":true,"balance":null},"planType":"pro"}},"rateLimitResetCredits":null}`).(map[string]any)
	snap, err := codexAppServerSnapshot(byId, readAt)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Source != CodexAppServerSourceId || snap.Plan != "pro" || len(snap.Windows) != 3 || snap.ReadAt != readAt {
		t.Fatalf("rateLimitsByLimitId first: %+v", snap)
	}
	if snap.Windows[0].Id != WindowSession || snap.Windows[1].Id != WindowWeek || snap.Windows[1].ResetsAt != 0 || snap.Windows[2].Label != "codex_other 1-hour" {
		t.Errorf("windows: %+v", snap.Windows)
	}
	if c := snap.Credits; c == nil || !c.Unlimited || !c.Enabled {
		t.Errorf("unlimited credits: %+v", c)
	}
	single := decodeJSON(t, `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":4102444800},"secondary":null},"rateLimitsByLimitId":null}`).(map[string]any)
	if snap, err := codexAppServerSnapshot(single, readAt); err != nil || len(snap.Windows) != 1 || snap.Windows[0].UsedPercent != 25 {
		t.Errorf("rateLimits alone: %+v %v", snap, err)
	}
	empty := decodeJSON(t, `{"rateLimits":{"limitId":null,"primary":null,"secondary":null,"credits":null},"rateLimitsByLimitId":null}`).(map[string]any)
	if _, err := codexAppServerSnapshot(empty, readAt); ReasonOf(err) != ReasonNoPlan {
		t.Errorf("no limits: %v", err)
	}
	if _, err := codexAppServerSnapshot(map[string]any{"other": 1}, readAt); ReasonOf(err) != ReasonFormat {
		t.Errorf("unknown shape: %v", err)
	}
}

type fakeAppServer struct {
	lock   sync.Mutex
	calls  int
	result string
	err    error
	delay  time.Duration
}

func (f *fakeAppServer) run(ctx context.Context) (map[string]any, error) {
	f.lock.Lock()
	f.calls++
	result, err, delay := f.result, f.err, f.delay
	f.lock.Unlock()
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return nil, Unavailable(ReasonFailed)
		}
	}
	if err != nil {
		return nil, err
	}
	var rtn map[string]any
	json.Unmarshal([]byte(result), &rtn)
	return rtn, nil
}

func (f *fakeAppServer) count() int {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.calls
}

type codexClock struct {
	lock sync.Mutex
	at   time.Time
}

func (c *codexClock) now() time.Time {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.at
}

func (c *codexClock) add(d time.Duration) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.at = c.at.Add(d)
}

const appServerResult = `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":33,"windowDurationMins":300,"resetsAt":4102444800}}}`

func codexTestSources(t *testing.T, fake *fakeAppServer, lim *CodexTranscriptLimits) (*CodexUsage, *codexClock, UsageAdapter) {
	clock := &codexClock{at: time.Now()}
	cu := MakeCodexUsage(fake.run)
	cu.now = clock.now
	cu.SetTranscript(func(blockId string) (CodexTranscriptLimits, bool) {
		if lim == nil || blockId != "b1" {
			return CodexTranscriptLimits{}, false
		}
		return lim.Copy(), true
	})
	a := &pageAdapter{id: "codex", pageURL: CodexUsagePageURL, pageName: "Codex usage", domain: "chatgpt.com",
		sources: []GaugesSource{MakeCodexTranscriptSource(cu), MakeCodexAppServerSource(cu)}}
	return cu, clock, a
}

func codexRead(a UsageAdapter, clock *codexClock, refresh bool) GaugesResult {
	settings := &wconfig.SettingsType{CompanionUsageGauges: []string{"codex"}}
	ctx := WithRefresh(context.Background(), refresh)
	return ReadGauges(ctx, a, settings, "b1", clock.now().UnixMilli())
}

func TestCodexSourcesOptIn(t *testing.T) {
	fake := &fakeAppServer{result: appServerResult}
	_, clock, a := codexTestSources(t, fake, nil)
	for _, settings := range []*wconfig.SettingsType{{}, {CompanionUsageGauges: []string{"claude"}}} {
		if res := ReadGauges(context.Background(), a, settings, "b1", clock.now().UnixMilli()); res.State != GaugesOff {
			t.Errorf("off: %+v", res)
		}
	}
	if fake.count() != 0 {
		t.Error("no process before the opt-in (NFR-SHELL-011)")
	}
}

func TestCodexAppServerFillsWhenTheSessionHasNone(t *testing.T) {
	fake := &fakeAppServer{result: appServerResult}
	cu, clock, a := codexTestSources(t, fake, &CodexTranscriptLimits{})
	res := codexRead(a, clock, false)
	if res.State != GaugesEnabled || res.SourceName != "Codex app-server" || res.Snapshot.Windows[0].UsedPercent != 33 || fake.count() != 1 {
		t.Fatalf("no snapshot in the session: one app-server read: %+v (%d runs)", res, fake.count())
	}
	for i := 0; i < 5; i++ {
		clock.add(time.Minute)
		if res := codexRead(a, clock, false); res.State != GaugesEnabled {
			t.Errorf("cached: %+v", res)
		}
	}
	if fake.count() != 1 {
		t.Errorf("read once, then kept: %d runs", fake.count())
	}

	if res := codexRead(a, clock, true); res.State != GaugesEnabled || fake.count() != 2 {
		t.Errorf("Refresh reads again: %+v (%d runs)", res, fake.count())
	}
	clock.add(30 * time.Second)
	codexRead(a, clock, true)
	if fake.count() != 2 {
		t.Errorf("Refresh at most once a minute: %d runs", fake.count())
	}
	clock.add(31 * time.Second)
	codexRead(a, clock, true)
	if fake.count() != 3 {
		t.Errorf("Refresh after a minute: %d runs", fake.count())
	}

	ClearValues(a)
	if cu.cached() != nil {
		t.Error("hiding plan usage clears the app-server's values")
	}
	if res := codexRead(a, clock, false); res.State != GaugesUnavailable || fake.count() != 3 {
		t.Errorf("shown again within 5 min: no extra process: %+v (%d runs)", res, fake.count())
	}
	clock.add(codexAutoInterval)
	if res := codexRead(a, clock, false); res.State != GaugesEnabled || fake.count() != 4 {
		t.Errorf("after 5 min: read again: %+v (%d runs)", res, fake.count())
	}
}

func TestCodexAppServerWaitsForTheSession(t *testing.T) {
	fake := &fakeAppServer{result: appServerResult}
	lim := &CodexTranscriptLimits{Loading: true}
	_, clock, a := codexTestSources(t, fake, lim)
	if res := codexRead(a, clock, false); res.State != GaugesUnavailable || res.Reason != ReasonWaiting || fake.count() != 0 {
		t.Errorf("session still being read: no process: %+v", res)
	}
	settings := &wconfig.SettingsType{CompanionUsageGauges: []string{"codex"}}
	lim.Loading = false
	ReadGauges(WithoutProcess(context.Background()), a, settings, "b1", clock.now().UnixMilli())
	if fake.count() != 0 {
		t.Error("a read that may not start a process does not")
	}
}

func TestCodexTranscriptFirst(t *testing.T) {
	fake := &fakeAppServer{result: appServerResult}
	clockStart := time.Now()
	lim := transcriptOf(t, clockStart.Add(-time.Minute).UnixMilli(),
		`{"limit_id":"codex","primary":{"used_percent":12,"window_minutes":300,"resets_at":4102444800}}`)
	_, clock, a := codexTestSources(t, fake, &lim)
	res := codexRead(a, clock, false)
	if res.State != GaugesEnabled || res.SourceName != "Codex session log" || res.Snapshot.Windows[0].UsedPercent != 12 || fake.count() != 0 {
		t.Fatalf("the session's snapshot, no process: %+v (%d runs)", res, fake.count())
	}
	res = codexRead(a, clock, true)
	if fake.count() != 1 || res.SourceName != "Codex app-server" || res.Snapshot.Windows[0].UsedPercent != 33 {
		t.Errorf("Refresh: the newer app-server read shows: %+v", res)
	}
	clock.add(time.Second)
	lim.Add(decodeJSON(t, `{"limit_id":"codex","primary":{"used_percent":40,"window_minutes":300,"resets_at":4102444800}}`), clock.now().UnixMilli())
	res = codexRead(a, clock, false)
	if res.SourceName != "Codex session log" || res.Snapshot.Windows[0].UsedPercent != 40 {
		t.Errorf("a newer token_count wins again: %+v", res)
	}

	past := transcriptOf(t, clockStart.Add(-6*time.Hour).UnixMilli(),
		`{"limit_id":"codex","primary":{"used_percent":99,"window_minutes":300,"resets_at":`+strconv.FormatInt(clockStart.Add(-time.Hour).Unix(), 10)+`}}`)
	fake2 := &fakeAppServer{result: appServerResult}
	_, clock2, a2 := codexTestSources(t, fake2, &past)
	if res := codexRead(a2, clock2, false); res.State != GaugesEnabled || res.Snapshot.Windows[0].UsedPercent != 33 || fake2.count() != 1 {
		t.Errorf("a session snapshot past its reset is dropped and the app-server fills: %+v", res)
	}
}

func TestCodexAppServerFailures(t *testing.T) {
	fake := &fakeAppServer{err: Unavailable(ReasonFailed)}
	cu, clock, a := codexTestSources(t, fake, nil)
	if res := codexRead(a, clock, false); res.State != GaugesUnavailable || res.Reason != ReasonWaiting {
		t.Errorf("both fail: the best source's reason: %+v", res)
	}
	waits := []time.Duration{5 * time.Minute, 10 * time.Minute, 20 * time.Minute, 40 * time.Minute, 60 * time.Minute, 60 * time.Minute}
	for i, wait := range waits {
		clock.add(wait - time.Second)
		codexRead(a, clock, false)
		if fake.count() != i+1 {
			t.Fatalf("backoff %d: no run before %v (%d runs)", i, wait, fake.count())
		}
		clock.add(time.Second)
		codexRead(a, clock, false)
		if fake.count() != i+2 {
			t.Fatalf("backoff %d: a run after %v (%d runs)", i, wait, fake.count())
		}
	}
	fake.lock.Lock()
	fake.err, fake.result = nil, `{"unknown":true}`
	fake.lock.Unlock()
	clock.add(time.Hour)
	if res := codexRead(a, clock, false); res.State != GaugesUnavailable {
		t.Errorf("unknown shape: hidden: %+v", res)
	}
	if cu.lastReason() != ReasonFormat {
		t.Errorf("reason kept: %s", cu.lastReason())
	}

	missing := MakeCodexUsage(nil)
	if _, err := missing.readAppServer(context.Background()); err == nil {
		t.Error("no codex: the app-server source fails, the session source stays")
	}
}

func TestCodexAppServerOneAtATime(t *testing.T) {
	fake := &fakeAppServer{result: appServerResult, delay: 100 * time.Millisecond}
	_, clock, a := codexTestSources(t, fake, &CodexTranscriptLimits{})
	var wg sync.WaitGroup
	results := make([]GaugesResult, 6)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = codexRead(a, clock, false)
		}(i)
	}
	wg.Wait()
	if fake.count() != 1 {
		t.Errorf("one process for concurrent reads: %d", fake.count())
	}
	for _, res := range results {
		if res.State != GaugesEnabled {
			t.Errorf("each read takes its result: %+v", res)
		}
	}
}
