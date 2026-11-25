// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"context"
	"fmt"
	"io/fs"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// What the managed kimi.ai service answers: a five-hour and a monthly window, no weekly one.
const sampleKimiMonthUsage = `{
	"usages": {
		"limit_5h": {"used_ratio": 0.0015, "reset_time": "2026-11-19T14:00:00Z"},
		"limit_month_total": {"used_ratio": 0.10, "reset_time": "2026-12-01T00:00:00Z"},
		"limit_month_code": {"used_ratio": 0.10, "reset_time": "2026-12-01T00:00:00Z"}
	}
}`

type kimiFixture struct {
	src     *KimiOAuthSource
	ep      *fakeEndpoint
	clock   *fakeClock
	lock    sync.Mutex
	expires int64
	stamp   string
}

func (f *kimiFixture) setExpires(at int64) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.expires = at
}

func (f *kimiFixture) setStamp(stamp string) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.stamp = stamp
}

// newKimiFixture reads from a fake kimi.ai service at 2026-11-19 12:00 UTC (a Thursday), the last reading kept in
// history. conn, when given, is the managed connection, and the credential file's metadata is then really read.
func newKimiFixture(t *testing.T, history string, conn *kimiManagedConnection, clock *fakeClock) *kimiFixture {
	t.Helper()
	if clock == nil {
		clock = &fakeClock{t: time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)}
	}
	f := &kimiFixture{ep: &fakeEndpoint{status: 200, body: sampleKimiMonthUsage}, clock: clock, stamp: "a"}
	f.ep.srv = httptest.NewTLSServer(f.ep)
	t.Cleanup(f.ep.srv.Close)
	f.src = MakeKimiOAuthSource()
	hooks := KimiOAuthTestHooks{
		Endpoint: f.ep.srv.URL + "/coding/v1/usages",
		Client:   tlsClientFor(f.ep.srv),
		Credentials: func(ctx context.Context) (string, int64, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			return fakeKimiToken, f.expires, nil
		},
		Store:   func() string { return "~/.kimi-code/credentials/kimi-code.json" },
		Now:     f.clock.now,
		History: history,
	}
	if conn != nil {
		c := *conn
		hooks.Connection = func() (kimiManagedConnection, error) { return c, nil }
	} else {
		hooks.Managed = func() error { return nil }
		hooks.CredentialStamp = func() string {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.stamp
		}
	}
	t.Cleanup(f.src.UseForTest(hooks))
	return f
}

func TestKimiExpiredTokenKeepsTheLastReadingAsStale(t *testing.T) {
	history := filepath.Join(t.TempDir(), "data", kimiLastFile)
	f := newKimiFixture(t, history, nil, nil)
	fresh, err := f.src.Read(fetchCtx(), "k1")
	if err != nil || fresh.Stale != "" || windowById(fresh, WindowMonth) == nil {
		t.Fatalf("first reading: %+v %v", fresh, err)
	}
	if f.src.RefreshEvery() != oauthAutoInterval {
		t.Error("a fresh reading is asked again at the automatic interval")
	}
	f.setExpires(f.clock.now().Add(time.Minute).UnixMilli())
	f.clock.add(oauthAutoInterval + time.Minute)
	kept, err := f.src.Read(fetchCtx(), "k1")
	if err != nil {
		t.Fatalf("an expired token keeps the last reading: %v", err)
	}
	if kept.Stale != ReasonTokenExpired || kept.ReadAt != fresh.ReadAt || windowById(kept, WindowMonth) == nil {
		t.Errorf("kept reading, stale, with its own age: %+v", kept)
	}
	if f.ep.hits.Load() != 1 {
		t.Errorf("an expired token is never sent: %d calls", f.ep.hits.Load())
	}
	if f.src.RefreshEvery() != kimiStaleRecheck {
		t.Error("a stale reading looks for a new token more often")
	}
	res := ReadGauges(fetchCtx(), kimiTestAdapter{f.src}, kimiOn(), "k1", f.clock.now().UnixMilli())
	if res.State != GaugesEnabled || res.Snapshot == nil || res.Snapshot.Stale != ReasonTokenExpired {
		t.Errorf("the gauges show the kept reading as stale: %+v", res)
	}

	// After a restart, with the token still expired, the reading recorded last shows.
	again := newKimiFixture(t, history, nil, f.clock)
	again.setExpires(f.clock.now().Add(-time.Minute).UnixMilli())
	restarted, err := again.src.Read(fetchCtx(), "k1")
	if err != nil || restarted.Stale != ReasonTokenExpired || restarted.ReadAt != fresh.ReadAt {
		t.Errorf("the last reading survives a restart: %+v %v", restarted, err)
	}
	if again.ep.hits.Load() != 0 {
		t.Error("a restart with an expired token calls nothing")
	}
}

func TestKimiExpiredTokenWithoutReadingStaysUnavailable(t *testing.T) {
	f := newKimiFixture(t, filepath.Join(t.TempDir(), kimiLastFile), nil, nil)
	f.setExpires(f.clock.now().Add(-time.Minute).UnixMilli())
	if _, err := f.src.Read(fetchCtx(), "k1"); ReasonOf(err) != ReasonTokenExpired {
		t.Errorf("nothing to keep: %v", err)
	}
}

func TestKimiCredentialChangeFetchesAtOnce(t *testing.T) {
	f := newKimiFixture(t, "", nil, nil)
	f.src.Read(fetchCtx(), "k1")
	waitKimiHits(t, f.ep, 1)
	f.clock.add(2 * time.Minute)
	f.src.Read(fetchCtx(), "k1")
	if f.ep.hits.Load() != 1 {
		t.Fatal("the same credential file waits for the automatic interval")
	}
	f.setStamp("b")
	f.src.Read(fetchCtx(), "k1")
	waitKimiHits(t, f.ep, 2)
	f.clock.add(2 * time.Minute)
	f.src.Read(fetchCtx(), "k1")
	if f.ep.hits.Load() != 2 {
		t.Error("one change gives one call")
	}
	f.setStamp("c")
	f.src.Read(context.Background(), "k1")
	if f.ep.hits.Load() != 2 {
		t.Error("a hidden companion calls nothing, even after a change")
	}
}

// treeState lists every entry of a folder with what a write would change.
func treeState(t *testing.T, root string) string {
	t.Helper()
	var b strings.Builder
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			t.Fatalf("walk: %v", err)
		}
		info, err := d.Info()
		if err != nil {
			t.Fatalf("info: %v", err)
		}
		rel, _ := filepath.Rel(root, path)
		fmt.Fprintf(&b, "%s %s %d %d\n", rel, info.Mode(), info.Size(), info.ModTime().UnixNano())
		return nil
	})
	return b.String()
}

func TestKimiNeverWritesUnderKimiHome(t *testing.T) {
	kimiHome := filepath.Join(t.TempDir(), ".kimi-code")
	creds := filepath.Join(kimiHome, "credentials", "kimi-code.json")
	if err := os.MkdirAll(filepath.Dir(creds), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(creds, []byte(`{"access_token":"synthetic","expires_at":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kimiHome, "config.toml"), []byte("default_model = \"kimi-code/k2\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	os.Chtimes(creds, old, old)
	before := treeState(t, kimiHome)
	dataDir := t.TempDir()
	history := filepath.Join(dataDir, kimiLastDir, kimiLastFile)
	f := newKimiFixture(t, history, &kimiManagedConnection{credentialPath: creds}, nil)
	if _, err := f.src.Read(fetchCtx(), "k1"); err != nil {
		t.Fatalf("read: %v", err)
	}
	f.setExpires(f.clock.now().Add(time.Minute).UnixMilli())
	f.clock.add(oauthAutoInterval + time.Minute)
	if snap, err := f.src.Read(fetchCtx(), "k1"); err != nil || snap.Stale != ReasonTokenExpired {
		t.Fatalf("stale: %+v %v", snap, err)
	}
	f.clock.add(24 * time.Hour)
	f.setExpires(0)
	if _, err := f.src.Read(fetchCtx(), "k1"); err != nil {
		t.Fatalf("next day: %v", err)
	}
	if _, err := os.Stat(history); err != nil {
		t.Fatalf("the reading is kept in MoltenTerm's own folder: %v", err)
	}
	if after := treeState(t, kimiHome); after != before {
		t.Errorf("Kimi Code's folder changed:\nbefore\n%s\nafter\n%s", before, after)
	}
	f.src.Clear()
	if _, err := os.Stat(history); !os.IsNotExist(err) {
		t.Errorf("turning the gauges off removes the reading: %v", err)
	}
	if after := treeState(t, kimiHome); after != before {
		t.Error("clearing never touches Kimi Code's folder")
	}
}

func TestKimiReadingsGoOnlyWhenTheSourceTurnsOff(t *testing.T) {
	history := filepath.Join(t.TempDir(), kimiLastDir, kimiLastFile)
	exists := func() bool {
		_, err := os.Stat(history)
		return err == nil
	}
	f := newKimiFixture(t, history, nil, nil)
	a := kimiTestAdapter{f.src}
	if _, err := f.src.Read(fetchCtx(), "k1"); err != nil || !exists() {
		t.Fatalf("a reading is recorded: %v", err)
	}
	// An unrelated edit of settings.json, the source still on.
	unrelated := kimiOn()
	unrelated.CompanionUsageClaudeOAuth = true
	SyncSources(a, unrelated)
	if !exists() {
		t.Fatal("an unrelated settings change never wipes the readings")
	}
	// The gauges turned off for Kimi: on to off.
	SyncSources(a, &wconfig.SettingsType{CompanionUsageKimiOAuth: true})
	if exists() {
		t.Fatal("removing kimi from companion:usagegauges deletes the readings")
	}
	// Off and still off: another edit while off keeps what exists.
	f.src.history.record(UsageSnapshot{Agent: "kimi", Windows: []UsageWindow{{Id: WindowMonth}}})
	SyncSources(a, &wconfig.SettingsType{CompanionUsageKimiOAuth: true, TermFontSize: 13})
	if !exists() {
		t.Fatal("off to off is no transition")
	}

	// MoltenTerm starting with the source off: nothing is known yet, nothing goes.
	restarted := newKimiFixture(t, history, nil, nil)
	SyncSources(kimiTestAdapter{restarted.src}, &wconfig.SettingsType{})
	if !exists() {
		t.Fatal("a source never seen on deletes nothing")
	}
	// The source's own opt-in turned off after it was on.
	SyncSources(kimiTestAdapter{restarted.src}, kimiOn())
	off := kimiOn()
	off.CompanionUsageKimiOAuth = false
	SyncSources(kimiTestAdapter{restarted.src}, off)
	if exists() {
		t.Fatal("companion:usagekimioauth turned off deletes the readings")
	}
}

// The week deduced from the month is gone (#2532): the month draws its own row, so the reading is what the endpoint
// gave and nothing is added to it.
func TestKimiReadingAddsNoWindowToTheMonth(t *testing.T) {
	f := newKimiFixture(t, filepath.Join(t.TempDir(), kimiLastFile), nil, nil)
	snap, err := f.src.Read(fetchCtx(), "k1")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, w := range snap.Windows {
		ids = append(ids, w.Id)
	}
	if strings.Join(ids, ",") != "session,month" {
		t.Fatalf("windows: %v", ids)
	}
}

func TestKimiReadingWithAWeekKeepsIt(t *testing.T) {
	f := newKimiFixture(t, filepath.Join(t.TempDir(), kimiLastFile), nil, nil)
	f.ep.lock.Lock()
	f.ep.body = sampleKimiUsage
	f.ep.lock.Unlock()
	snap, err := f.src.Read(fetchCtx(), "k1")
	if err != nil {
		t.Fatal(err)
	}
	if week := windowById(snap, WindowWeek); week == nil || len(snap.Windows) != 3 {
		t.Errorf("a provider's own week is kept: %+v", snap.Windows)
	}
}

func kimiOn() *wconfig.SettingsType {
	return &wconfig.SettingsType{CompanionUsageGauges: []string{"kimi"}, CompanionUsageKimiOAuth: true}
}

type kimiTestAdapter struct{ src *KimiOAuthSource }

func (a kimiTestAdapter) Id() string              { return "kimi" }
func (a kimiTestAdapter) PageURL() string         { return KimiUsagePageURL }
func (a kimiTestAdapter) PageName() string        { return "Kimi" }
func (a kimiTestAdapter) Domain() string          { return "kimi.com" }
func (a kimiTestAdapter) Sources() []GaugesSource { return []GaugesSource{a.src} }

func TestKimiLastReadingOfAnOlderFileIsStillRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), kimiLastDir, kimiLastFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	// Version 1 also held the per-day readings of the deduced week.
	old := `{"version":1,"days":[{"day":"2026-11-18","first":{"at":1,"used":4,"resetsat":2},"last":{"at":1,"used":5,"resetsat":2}}],"last":{"agent":"kimi","source":"kimi-oauth","windows":[{"id":"month","label":"This month","usedpercent":12,"resetsat":1764547200000}],"readat":1763553600000}}`
	if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	h := &kimiLast{path: func() string { return path }}
	last := h.last()
	if last == nil || last.ReadAt != 1763553600000 || len(last.Windows) != 1 || last.Windows[0].UsedPercent != 12 {
		t.Errorf("the last reading of an older file: %+v", last)
	}
	h.record(UsageSnapshot{Agent: "kimi", Windows: []UsageWindow{{Id: WindowMonth, UsedPercent: 13}}, ReadAt: 5})
	data, err := os.ReadFile(path)
	if err != nil || strings.Contains(string(data), `"days"`) || !strings.Contains(string(data), `"version":2`) {
		t.Errorf("a new reading writes the file without the days: %s %v", data, err)
	}
}

func TestDefaultReadingsFolderIsMoltenTermsOwn(t *testing.T) {
	if got := defaultKimiLastPath(); got != "" {
		t.Errorf("a test never writes in the app's data folder: %q", got)
	}
	if got := defaultHistoryDir(); got != "" {
		t.Errorf("a test never writes the history in the app's data folder: %q", got)
	}
	home, _ := os.UserHomeDir()
	for _, dir := range []string{kimiLastDir, historyDir} {
		if strings.Contains(dir, ".kimi-code") || strings.HasPrefix(dir, home) {
			t.Errorf("the readings never go under Kimi Code's folder: %s", dir)
		}
	}
}

func TestPreviousMonthResetClampsToTheShorterMonth(t *testing.T) {
	cases := []struct{ reset, want time.Time }{
		{time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)},
		{time.Date(2027, 3, 31, 1, 0, 0, 0, time.UTC), time.Date(2027, 2, 28, 1, 0, 0, 0, time.UTC)},
		{time.Date(2027, 1, 15, 0, 0, 0, 0, time.UTC), time.Date(2026, 12, 15, 0, 0, 0, 0, time.UTC)},
	}
	for _, tc := range cases {
		if got := previousMonthResetAt(tc.reset); !got.Equal(tc.want) {
			t.Errorf("%v: %v, want %v", tc.reset, got, tc.want)
		}
	}
}
