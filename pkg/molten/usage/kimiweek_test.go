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

type kimiWeekFixture struct {
	src     *KimiOAuthSource
	ep      *fakeEndpoint
	clock   *fakeClock
	lock    sync.Mutex
	expires int64
	stamp   string
}

func (f *kimiWeekFixture) setExpires(at int64) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.expires = at
}

func (f *kimiWeekFixture) setStamp(stamp string) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.stamp = stamp
}

// newKimiWeekFixture reads from a fake kimi.ai service at 2026-11-19 12:00 UTC (a Thursday), the readings kept in
// history. conn, when given, is the managed connection, and the credential file's metadata is then really read.
func newKimiWeekFixture(t *testing.T, history string, conn *kimiManagedConnection, clock *fakeClock) *kimiWeekFixture {
	t.Helper()
	if clock == nil {
		clock = &fakeClock{t: time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)}
	}
	f := &kimiWeekFixture{ep: &fakeEndpoint{status: 200, body: sampleKimiMonthUsage}, clock: clock, stamp: "a"}
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
		Store:    func() string { return "~/.kimi-code/credentials/kimi-code.json" },
		Now:      f.clock.now,
		History:  history,
		Location: time.UTC,
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
	history := filepath.Join(t.TempDir(), "data", kimiHistoryFile)
	f := newKimiWeekFixture(t, history, nil, nil)
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
	again := newKimiWeekFixture(t, history, nil, f.clock)
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
	f := newKimiWeekFixture(t, filepath.Join(t.TempDir(), kimiHistoryFile), nil, nil)
	f.setExpires(f.clock.now().Add(-time.Minute).UnixMilli())
	if _, err := f.src.Read(fetchCtx(), "k1"); ReasonOf(err) != ReasonTokenExpired {
		t.Errorf("nothing to keep: %v", err)
	}
}

func TestKimiCredentialChangeFetchesAtOnce(t *testing.T) {
	f := newKimiWeekFixture(t, "", nil, nil)
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
	history := filepath.Join(dataDir, kimiHistoryDir, kimiHistoryFile)
	f := newKimiWeekFixture(t, history, &kimiManagedConnection{credentialPath: creds}, nil)
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
		t.Fatalf("the readings are kept in MoltenTerm's own folder: %v", err)
	}
	if after := treeState(t, kimiHome); after != before {
		t.Errorf("Kimi Code's folder changed:\nbefore\n%s\nafter\n%s", before, after)
	}
	f.src.Clear()
	if _, err := os.Stat(history); !os.IsNotExist(err) {
		t.Errorf("turning the gauges off removes the readings: %v", err)
	}
	if after := treeState(t, kimiHome); after != before {
		t.Error("clearing never touches Kimi Code's folder")
	}
}

func TestKimiReadingGetsTheDeducedWeekBeforeTheMonth(t *testing.T) {
	f := newKimiWeekFixture(t, filepath.Join(t.TempDir(), kimiHistoryFile), nil, nil)
	snap, err := f.src.Read(fetchCtx(), "k1")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, w := range snap.Windows {
		ids = append(ids, w.Id)
	}
	if strings.Join(ids, ",") != "session,week,month" {
		t.Fatalf("windows: %v", ids)
	}
	week := windowById(snap, WindowWeek)
	if !week.Deduced || week.Label != DeducedWeekLabel || week.WindowMins != sevenDayMins {
		t.Errorf("deduced week: %+v", week)
	}
	// Recording starts on Thursday: Monday to Wednesday are unknown, Thursday has no use yet, the weekend is to come.
	want := []float64{-1, -1, -1, 0, 0, 0, 0}
	for i, d := range week.Days {
		if d != want[i] {
			t.Errorf("days %v, want %v", week.Days, want)
			break
		}
	}
	if week.ResetsAt != time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("the week resets on Monday 00:00: %d", week.ResetsAt)
	}
}

func TestKimiReadingWithAWeekKeepsIt(t *testing.T) {
	f := newKimiWeekFixture(t, filepath.Join(t.TempDir(), kimiHistoryFile), nil, nil)
	f.ep.lock.Lock()
	f.ep.body = sampleKimiUsage
	f.ep.lock.Unlock()
	snap, err := f.src.Read(fetchCtx(), "k1")
	if err != nil {
		t.Fatal(err)
	}
	if week := windowById(snap, WindowWeek); week == nil || week.Deduced || len(snap.Windows) != 3 {
		t.Errorf("a provider's own week is never replaced: %+v", snap.Windows)
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

// ---- the deduced week from recorded readings ----

// readingAt records a monthly share at a moment of November 2026 (UTC), in the window that resets on 1 December.
func readingAt(h *kimiHistory, day int, hour int, used float64) {
	readingIn(h, time.Date(2026, 11, day, hour, 0, 0, 0, time.UTC), used, time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC))
}

func readingIn(h *kimiHistory, at time.Time, used float64, reset time.Time) {
	h.record(UsageSnapshot{Agent: "kimi", Windows: []UsageWindow{{Id: WindowMonth, UsedPercent: used, ResetsAt: reset.UnixMilli()}}, ReadAt: at.UnixMilli()}, at)
}

func novemberMonth() UsageWindow {
	return UsageWindow{Id: WindowMonth, UsedPercent: 0, ResetsAt: time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC).UnixMilli()}
}

func testHistory(t *testing.T) (*kimiHistory, string) {
	path := filepath.Join(t.TempDir(), kimiHistoryDir, kimiHistoryFile)
	return &kimiHistory{path: func() string { return path }, loc: time.UTC}, path
}

func TestDeducedWeekBudgetIsTheMonthTimesSevenOverItsDays(t *testing.T) {
	h, _ := testHistory(t)
	// November's window has 30 days: the week's budget is 7/30 of the month (23.33 %), a day's 1/30 (3.33 %).
	readingAt(h, 16, 9, 10)
	readingAt(h, 16, 20, 13.5)
	week, ok := h.deducedWeek(novemberMonth(), time.Date(2026, 11, 16, 21, 0, 0, 0, time.UTC))
	if !ok {
		t.Fatal("a week")
	}
	if week.UsedPercent != 15 {
		t.Errorf("3.5 points of the month over a 23.33-point week is 15 %%: %v", week.UsedPercent)
	}
	if week.Days[0] != 105 {
		t.Errorf("3.5 points over a 3.33-point day is 105 %%: %v", week.Days)
	}
	// A 31-day window (December, resetting on 1 January) gives a smaller week for the same use.
	h31, _ := testHistory(t)
	jan := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	readingIn(h31, time.Date(2026, 12, 14, 9, 0, 0, 0, time.UTC), 10, jan)
	readingIn(h31, time.Date(2026, 12, 14, 20, 0, 0, 0, time.UTC), 13.5, jan)
	week31, _ := h31.deducedWeek(UsageWindow{Id: WindowMonth, ResetsAt: jan.UnixMilli()}, time.Date(2026, 12, 14, 21, 0, 0, 0, time.UTC))
	if week31.UsedPercent != 15.5 {
		t.Errorf("3.5 points over a 7/31 week is 15.5 %%: %v", week31.UsedPercent)
	}
}

func TestDeducedWeekDailyUseComesFromTheReadings(t *testing.T) {
	h, _ := testHistory(t)
	readingAt(h, 15, 22, 5) // the Sunday before: Monday counts from its latest reading
	readingAt(h, 16, 10, 6)
	readingAt(h, 16, 18, 7)
	readingAt(h, 17, 9, 8) // Tuesday: 1 point since Monday's latest, then 1 more
	readingAt(h, 17, 23, 9)
	readingAt(h, 19, 9, 12) // Wednesday unrecorded: Thursday takes its use
	readingAt(h, 19, 11, 12)
	week, _ := h.deducedWeek(novemberMonth(), time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC))
	want := []float64{60, 60, -1, 90, 0, 0, 0}
	for i := range want {
		if week.Days[i] != want[i] {
			t.Fatalf("days %v, want %v", week.Days, want)
		}
	}
	// 7 points over a 23.33-point week.
	if week.UsedPercent != 30 {
		t.Errorf("week %v", week.UsedPercent)
	}
}

func TestDeducedWeekPassesAHundredAbovePace(t *testing.T) {
	h, _ := testHistory(t)
	readingAt(h, 16, 9, 0)
	readingAt(h, 18, 20, 35)
	week, _ := h.deducedWeek(novemberMonth(), time.Date(2026, 11, 18, 21, 0, 0, 0, time.UTC))
	if week.UsedPercent != 150 {
		t.Errorf("35 points over a 23.33-point week: %v", week.UsedPercent)
	}
}

func TestDeducedWeekDaysBeforeRecordingAreUnknown(t *testing.T) {
	h, _ := testHistory(t)
	readingAt(h, 11, 9, 1) // last week, too far to be a baseline
	readingAt(h, 18, 9, 4)
	readingAt(h, 18, 15, 5)
	week, _ := h.deducedWeek(novemberMonth(), time.Date(2026, 11, 18, 16, 0, 0, 0, time.UTC))
	want := []float64{DeducedDayUnknown, DeducedDayUnknown, 30, 0, 0, 0, 0}
	for i := range want {
		if week.Days[i] != want[i] {
			t.Fatalf("days %v, want %v", week.Days, want)
		}
	}
	if _, ok := (&kimiHistory{path: func() string { return "" }}).deducedWeek(novemberMonth(), time.Now()); ok {
		t.Error("no readings, no week")
	}
}

func TestDeducedWeekNewMonthlyWindowCountsFromZero(t *testing.T) {
	h, _ := testHistory(t)
	dec := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	jan := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	readingIn(h, time.Date(2026, 11, 30, 20, 0, 0, 0, time.UTC), 90, dec)
	readingIn(h, time.Date(2026, 12, 1, 10, 0, 0, 0, time.UTC), 2, jan)
	week, _ := h.deducedWeek(UsageWindow{Id: WindowMonth, ResetsAt: jan.UnixMilli()}, time.Date(2026, 12, 1, 11, 0, 0, 0, time.UTC))
	// Tuesday 1 December: 2 points of the new window, never a negative delta from the old one.
	if week.Days[1] != 62 || week.Days[0] != 0 {
		t.Errorf("days %v", week.Days)
	}
}

func TestDeducedWeekReadingsSurviveARestart(t *testing.T) {
	h, path := testHistory(t)
	readingAt(h, 16, 9, 10)
	readingAt(h, 16, 20, 13.5)
	restarted := &kimiHistory{path: func() string { return path }, loc: time.UTC}
	week, ok := restarted.deducedWeek(novemberMonth(), time.Date(2026, 11, 16, 21, 0, 0, 0, time.UTC))
	if !ok || week.UsedPercent != 15 {
		t.Errorf("the readings are read back: %+v", week)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("the file is the user's only: %v %v", info, err)
	}
}

func TestDefaultReadingsFolderIsMoltenTermsOwn(t *testing.T) {
	if got := defaultKimiHistoryPath(); got != "" {
		t.Errorf("a test never writes in the app's data folder: %q", got)
	}
	home, _ := os.UserHomeDir()
	if strings.Contains(kimiHistoryDir, ".kimi-code") || strings.HasPrefix(kimiHistoryDir, home) {
		t.Error("the readings never go under Kimi Code's folder")
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
