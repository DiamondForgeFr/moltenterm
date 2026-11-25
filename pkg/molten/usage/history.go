// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"bufio"
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// The usage history (FR-SHELL-027, #2532): per provider, in MoltenTerm's own data folder, every reading of its plan
// windows, each measured session worth and, at each global reset, the window's dates, the share used and the share lost.
// Stored and not displayed: a dedicated usage panel comes later. One JSON line per record, written by appending.
//
// The session is the short window (5 h) and the pool the window of the global reset, weekly or monthly. A full
// session's worth is the pool's rise over a session MoltenTerm saw used in full; the rows draw the share lost from it
// (FR-SHELL-018), so nothing is drawn until a worth is measured.

const (
	historyDir = "molten/usage/history"
	historyExt = ".jsonl"

	recordReading = "reading"
	recordWorth   = "worth"
	recordReset   = "reset"

	historyKeepReadings = 8000
	historyKeepAge      = 120 * 24 * time.Hour
	historyKeepWorths   = 400
	historyKeepResets   = 1000
	// A reading identical to the last one is stored again only this long after it, so the file grows with the use and
	// not with the polling, and a series keeps a point in a quiet stretch.
	historyHeartbeat = 10 * time.Minute
	historyMaxBytes  = 8 << 20
	// The readings are pruned once they pass their bound by this much, so a long run does not rewrite the file at each one.
	historySlack = historyKeepReadings / 10

	// A session counts when it is seen from its start (its first reading shows at most worthStartMax % used) and seen
	// used in full (a reading at worthFullAt % or more), the pool's reset unchanged over it.
	worthStartMax = 10.0
	worthFullAt   = 99.0
	worthMedianOf = 5
	worthMaxAge   = 60 * 24 * time.Hour
	// Two reset times this close are one: sources round them differently.
	resetJitter = 2 * time.Minute
)

type historyWindow struct {
	Id       string  `json:"id"`
	Used     float64 `json:"used"`
	ResetsAt int64   `json:"resetsat,omitempty"`
	Mins     int64   `json:"mins,omitempty"`
}

type historyReading struct {
	Kind    string          `json:"kind"`
	At      int64           `json:"at"`
	Windows []historyWindow `json:"windows"`
}

// historyWorth is what a full session was worth in percent of a pool window, with the session it was measured on.
type historyWorth struct {
	Kind    string  `json:"kind"`
	At      int64   `json:"at"`
	Window  string  `json:"window"`
	Session int64   `json:"session"`
	Mins    int64   `json:"mins"`
	Worth   float64 `json:"worth"`
}

// historyReset closes a pool window: its dates, the share used at the last reading of it and what was left unused, in
// percent and in days of the window.
type historyReset struct {
	Kind     string  `json:"kind"`
	At       int64   `json:"at"`
	Window   string  `json:"window"`
	Start    int64   `json:"start"`
	End      int64   `json:"end"`
	Days     float64 `json:"days"`
	Used     float64 `json:"used"`
	Lost     float64 `json:"lost"`
	LostDays float64 `json:"lostdays"`
	ReadAt   int64   `json:"readat"`
}

// openWindow is a pool window still running: what its last reading said.
type openWindow struct {
	resetsAt int64
	mins     int64
	used     float64
	at       int64
}

type providerHistory struct {
	path     string
	readings []historyReading
	worths   []historyWorth
	resets   []historyReset
	open     map[string]openWindow
	// rewrite: the file on disk cannot be appended to as it is (too large to read, or holding what was pruned).
	rewrite bool
}

type usageHistory struct {
	lock sync.Mutex
	// dir gives the folder of the files; "" keeps nothing (a test that gives none).
	dir    func() string
	loc    *time.Location
	agents map[string]*providerHistory
	// on is what is known of each agent's gauges: absent until told, so MoltenTerm starting with them off clears nothing.
	on map[string]bool
}

func makeUsageHistory(dir func() string, loc *time.Location) *usageHistory {
	return &usageHistory{dir: dir, loc: loc, agents: map[string]*providerHistory{}, on: map[string]bool{}}
}

func defaultHistoryDir() string {
	dir := wavebase.GetWaveDataDir()
	// A test never writes in the data folder of the app it runs beside: it gives its own folder (UseHistoryForTest).
	if dir == "" || testing.Testing() {
		return ""
	}
	return filepath.Join(dir, historyDir)
}

var defaultHistory = makeUsageHistory(defaultHistoryDir, nil)

// NoteReading is what a source's merged reading goes through: it is kept in the provider's history and gets the
// session's worth, when measured, on its week and month windows.
func NoteReading(agent string, snap *UsageSnapshot, now time.Time) {
	defaultHistory.Note(agent, snap, now)
}

// SyncHistory follows the agent's gauges: turned from on to off, its history is deleted (NFR-SHELL-011).
func SyncHistory(agent string, on bool) {
	defaultHistory.Sync(agent, on)
}

// UseHistoryForTest keeps the history in dir, in the given time zone, until the returned function restores it.
func UseHistoryForTest(dir string, loc *time.Location) func() {
	if !testing.Testing() {
		panic("UseHistoryForTest outside a test")
	}
	previous := defaultHistory
	defaultHistory = makeUsageHistory(func() string { return dir }, loc)
	return func() { defaultHistory = previous }
}

func (h *usageHistory) location() *time.Location {
	if h.loc == nil {
		return time.Local
	}
	return h.loc
}

// isPoolWindow tells the windows of a global reset (a week, a model's week, a month, any window of a day or more) from
// the session and the spend limit.
func isPoolWindow(id string, mins int64) bool {
	if id == "" || id == WindowSession || id == "spend" {
		return false
	}
	return id == WindowWeek || id == WindowMonth || strings.HasPrefix(id, WindowModelPrefix) || mins >= 24*60
}

// hasWorth tells the windows a session's worth is measured for: the week and the month, never a model's week, which
// a session spent on other models would not move.
func hasWorth(id string) bool {
	return id == WindowWeek || id == WindowMonth
}

// agentFile is the history file of an agent; "" for an id that could name another place.
func (h *usageHistory) agentFile(agent string) string {
	dir := ""
	if h.dir != nil {
		dir = h.dir()
	}
	if dir == "" || agent == "" || strings.ContainsAny(agent, `/\.`) {
		return ""
	}
	return filepath.Join(dir, agent+historyExt)
}

// providerLocked loads the agent's file once; nil when nothing is kept.
func (h *usageHistory) providerLocked(agent string, now time.Time) *providerHistory {
	path := h.agentFile(agent)
	if path == "" {
		return nil
	}
	if p := h.agents[agent]; p != nil && p.path == path {
		return p
	}
	p := &providerHistory{path: path, open: map[string]openWindow{}}
	h.loadLocked(p, now)
	h.agents[agent] = p
	return p
}

func (h *usageHistory) loadLocked(p *providerHistory, now time.Time) {
	data, err := readBoundedRegularFile(p.path, historyMaxBytes)
	if err != nil {
		_, statErr := os.Lstat(p.path)
		p.rewrite = statErr == nil
		return
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		var head struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(line, &head) != nil {
			p.rewrite = true
			continue
		}
		switch head.Kind {
		case recordReading:
			var r historyReading
			if json.Unmarshal(line, &r) == nil {
				p.readings = append(p.readings, r)
			}
		case recordWorth:
			var w historyWorth
			if json.Unmarshal(line, &w) == nil {
				p.worths = append(p.worths, w)
			}
		case recordReset:
			var r historyReset
			if json.Unmarshal(line, &r) == nil {
				p.resets = append(p.resets, r)
			}
		default:
			p.rewrite = true
		}
	}
	for _, r := range p.readings {
		h.followLocked(p, r)
	}
	for id, o := range p.open {
		if h.resetKnown(p, id, o.resetsAt) {
			delete(p.open, id)
		}
	}
	if h.pruneLocked(p, now) {
		p.rewrite = true
	}
	if p.rewrite {
		h.rewriteLocked(p)
	}
}

// followLocked lets the running pool windows follow a reading.
func (h *usageHistory) followLocked(p *providerHistory, r historyReading) {
	for _, w := range r.Windows {
		if isPoolWindow(w.Id, w.Mins) && w.ResetsAt > 0 {
			p.open[w.Id] = openWindow{resetsAt: w.ResetsAt, mins: w.Mins, used: w.Used, at: r.At}
		}
	}
}

func (h *usageHistory) resetKnown(p *providerHistory, window string, end int64) bool {
	return slices.ContainsFunc(p.resets, func(r historyReset) bool { return r.Window == window && r.End == end })
}

func readingWindows(snap UsageSnapshot, nowMs int64) []historyWindow {
	var rtn []historyWindow
	for _, w := range snap.Windows {
		if w.Id == "" || math.IsNaN(w.UsedPercent) || math.IsInf(w.UsedPercent, 0) {
			continue
		}
		if w.ResetsAt > 0 && w.ResetsAt <= nowMs {
			continue
		}
		rtn = append(rtn, historyWindow{Id: w.Id, Used: round(w.UsedPercent, 3), ResetsAt: w.ResetsAt, Mins: w.WindowMins})
	}
	return rtn
}

func round(v float64, places int) float64 {
	scale := math.Pow(10, float64(places))
	return math.Round(v*scale) / scale
}

func sameWindows(a, b []historyWindow) bool {
	return slices.Equal(a, b)
}

// Note keeps a reading and gives it the session's worth.
func (h *usageHistory) Note(agent string, snap *UsageSnapshot, now time.Time) {
	if snap == nil {
		return
	}
	h.Record(agent, *snap, now)
	h.Annotate(agent, snap, now)
}

// Record keeps one reading of an agent's plan: the windows it gives, the pool windows whose reset has passed closed
// with their dates, used and lost share, and a session worth when the reading completes a full session. A reading the
// source kept because it could not read a fresh one is not a reading.
func (h *usageHistory) Record(agent string, snap UsageSnapshot, now time.Time) {
	if snap.Stale != "" {
		return
	}
	h.lock.Lock()
	defer h.lock.Unlock()
	h.on[agent] = true
	p := h.providerLocked(agent, now)
	if p == nil {
		return
	}
	nowMs := now.UnixMilli()
	windows := readingWindows(snap, nowMs)
	var lines []any
	for _, r := range h.finishLocked(p, nowMs) {
		lines = append(lines, r)
	}
	if len(windows) > 0 {
		at := snap.ReadAt
		if at <= 0 || at > nowMs {
			at = nowMs
		}
		var last *historyReading
		if n := len(p.readings); n > 0 {
			last = &p.readings[n-1]
			at = max(at, last.At)
		}
		if last == nil || !sameWindows(last.Windows, windows) || time.Duration(at-last.At)*time.Millisecond >= historyHeartbeat {
			reading := historyReading{Kind: recordReading, At: at, Windows: windows}
			p.readings = append(p.readings, reading)
			h.followLocked(p, reading)
			lines = append(lines, reading)
			for _, w := range h.measureLocked(p, reading) {
				lines = append(lines, w)
			}
		}
	}
	if len(lines) == 0 {
		return
	}
	pruned := h.pruneLocked(p, now)
	if pruned || p.rewrite {
		h.rewriteLocked(p)
		return
	}
	h.appendLocked(p, lines)
}

// finishLocked closes the running pool windows whose reset has passed, once each.
func (h *usageHistory) finishLocked(p *providerHistory, nowMs int64) []historyReset {
	var done []historyReset
	for id, o := range p.open {
		if o.resetsAt <= 0 || o.resetsAt > nowMs {
			continue
		}
		delete(p.open, id)
		if h.resetKnown(p, id, o.resetsAt) {
			continue
		}
		done = append(done, h.closeWindow(id, o, nowMs))
	}
	slices.SortFunc(done, func(a, b historyReset) int {
		return cmp.Or(cmp.Compare(a.End, b.End), strings.Compare(a.Window, b.Window))
	})
	p.resets = append(p.resets, done...)
	return done
}

// closeWindow tells how a pool window ended: what was left unused at its reset is the share lost, in percent and in
// days of the window.
func (h *usageHistory) closeWindow(id string, o openWindow, nowMs int64) historyReset {
	loc := h.location()
	end := time.UnixMilli(o.resetsAt).In(loc)
	start, days := windowSpan(id, o.mins, end)
	used := math.Max(0, o.used)
	lost := math.Max(0, 100-used)
	return historyReset{
		Kind:     recordReset,
		At:       nowMs,
		Window:   id,
		Start:    start.UnixMilli(),
		End:      o.resetsAt,
		Days:     days,
		Used:     round(used, 2),
		Lost:     round(lost, 2),
		LostDays: round(lost*days/100, 2),
		ReadAt:   o.at,
	}
}

// windowSpan is where a window started and how many calendar days it lasted, from the reset that ends it: whole days
// are taken off the calendar, so a change of daylight saving time never moves the start to the day before.
func windowSpan(id string, mins int64, end time.Time) (time.Time, float64) {
	var start time.Time
	switch {
	case mins > 0 && mins%(24*60) == 0:
		start = end.AddDate(0, 0, -int(mins/(24*60)))
	case mins > 0:
		start = end.Add(-time.Duration(mins) * time.Minute)
	case id == WindowMonth:
		start = previousMonthResetAt(end)
	default:
		return end, 0
	}
	return start, math.Round(end.Sub(start).Hours() / 24)
}

// previousMonthResetAt is the monthly window's start: the same day one calendar month before, the last day of that
// month when it is shorter (as the companion's previousMonthReset does).
func previousMonthResetAt(reset time.Time) time.Time {
	first := time.Date(reset.Year(), reset.Month()-1, 1, reset.Hour(), reset.Minute(), reset.Second(), reset.Nanosecond(), reset.Location())
	daysThere := time.Date(first.Year(), first.Month()+1, 0, 0, 0, 0, 0, reset.Location()).Day()
	return first.AddDate(0, 0, min(reset.Day(), daysThere)-1)
}

func windowIn(r historyReading, id string) *historyWindow {
	for i := range r.Windows {
		if r.Windows[i].Id == id {
			return &r.Windows[i]
		}
	}
	return nil
}

func sameReset(a, b int64) bool {
	return a > 0 && b > 0 && math.Abs(float64(a-b)) <= float64(resetJitter.Milliseconds())
}

// measureLocked tells what a full session was worth when the reading is the one that fills it: the run of readings of
// that session, the pool's reset unchanged, starts with a session at most worthStartMax % used, and the pool rose over
// it. The worth is the pool's rise scaled to the session's rise.
func (h *usageHistory) measureLocked(p *providerHistory, now historyReading) []historyWorth {
	session := windowIn(now, WindowSession)
	if session == nil || session.ResetsAt <= 0 || session.Used < worthFullAt {
		return nil
	}
	var measured []historyWorth
	for _, pool := range now.Windows {
		if !hasWorth(pool.Id) || pool.ResetsAt <= 0 {
			continue
		}
		known := slices.ContainsFunc(p.worths, func(w historyWorth) bool {
			return w.Window == pool.Id && sameReset(w.Session, session.ResetsAt)
		})
		if known {
			continue
		}
		var firstSession, firstPool *historyWindow
		for i := len(p.readings) - 1; i >= 0; i-- {
			s := windowIn(p.readings[i], WindowSession)
			q := windowIn(p.readings[i], pool.Id)
			if s == nil || q == nil || !sameReset(s.ResetsAt, session.ResetsAt) || !sameReset(q.ResetsAt, pool.ResetsAt) {
				break
			}
			firstSession, firstPool = s, q
		}
		if firstSession == nil || firstSession.Used > worthStartMax {
			continue
		}
		sessionRise := session.Used - firstSession.Used
		poolRise := pool.Used - firstPool.Used
		if sessionRise <= 0 || poolRise <= 0 {
			continue
		}
		worth := round(poolRise/sessionRise*100, 2)
		if worth <= 0 || worth > 100 {
			continue
		}
		mins := session.Mins
		if mins <= 0 {
			mins = fiveHourMins
		}
		measured = append(measured, historyWorth{Kind: recordWorth, At: now.At, Window: pool.Id, Session: session.ResetsAt, Mins: mins, Worth: worth})
	}
	p.worths = append(p.worths, measured...)
	return measured
}

// pruneLocked drops what is past its bound: the readings by age and count, the measures and the resets by count. It
// tells whether it dropped any, once the readings are well past theirs.
func (h *usageHistory) pruneLocked(p *providerHistory, now time.Time) bool {
	dropped := false
	oldest := now.Add(-historyKeepAge).UnixMilli()
	cut := 0
	for cut < len(p.readings) && p.readings[cut].At < oldest {
		cut++
	}
	if over := len(p.readings) - cut - historyKeepReadings; over > historySlack {
		cut += over
	}
	if cut > 0 {
		p.readings = slices.Clone(p.readings[cut:])
		dropped = true
	}
	if len(p.worths) > historyKeepWorths {
		p.worths = slices.Clone(p.worths[len(p.worths)-historyKeepWorths:])
		dropped = true
	}
	if len(p.resets) > historyKeepResets {
		p.resets = slices.Clone(p.resets[len(p.resets)-historyKeepResets:])
		dropped = true
	}
	return dropped
}

func encodeLines(lines []any) ([]byte, error) {
	var buf bytes.Buffer
	for _, line := range lines {
		data, err := json.Marshal(line)
		if err != nil {
			return nil, err
		}
		buf.Write(data)
		buf.WriteByte('\n')
	}
	return buf.Bytes(), nil
}

func (h *usageHistory) appendLocked(p *providerHistory, lines []any) {
	data, err := encodeLines(lines)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return
	}
	f, err := os.OpenFile(p.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		log.Printf("molten usage: cannot keep the history: %v\n", err)
		return
	}
	defer f.Close()
	f.Write(data)
}

// rewriteLocked writes the file again from memory, by rename.
func (h *usageHistory) rewriteLocked(p *providerHistory) {
	var lines []any
	for _, r := range p.readings {
		lines = append(lines, r)
	}
	for _, w := range p.worths {
		lines = append(lines, w)
	}
	for _, r := range p.resets {
		lines = append(lines, r)
	}
	data, err := encodeLines(lines)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(p.path), "."+filepath.Base(p.path)+".*")
	if err != nil {
		return
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp.Name(), p.path); err == nil {
		p.rewrite = false
	}
}

// worthLocked is the worth of a pool window: the median of its last measures within worthMaxAge, and the length of the
// session of the latest one; 0 when none.
func (h *usageHistory) worthLocked(p *providerHistory, window string, now time.Time) (float64, int64) {
	oldest := now.Add(-worthMaxAge).UnixMilli()
	var worths []float64
	var mins int64
	for i := len(p.worths) - 1; i >= 0 && len(worths) < worthMedianOf; i-- {
		if w := p.worths[i]; w.Window == window && w.At >= oldest {
			if len(worths) == 0 {
				mins = w.Mins
			}
			worths = append(worths, w.Worth)
		}
	}
	if len(worths) == 0 {
		return 0, 0
	}
	if mins <= 0 {
		mins = fiveHourMins
	}
	slices.Sort(worths)
	mid := len(worths) / 2
	if len(worths)%2 == 1 {
		return worths[mid], mins
	}
	return round((worths[mid-1]+worths[mid])/2, 2), mins
}

// Annotate gives the week and month windows of a reading the session's worth, when measured.
func (h *usageHistory) Annotate(agent string, snap *UsageSnapshot, now time.Time) {
	if snap == nil {
		return
	}
	h.lock.Lock()
	defer h.lock.Unlock()
	p := h.providerLocked(agent, now)
	if p == nil {
		return
	}
	for i := range snap.Windows {
		if hasWorth(snap.Windows[i].Id) {
			snap.Windows[i].SessionWorth, snap.Windows[i].SessionMins = h.worthLocked(p, snap.Windows[i].Id, now)
		}
	}
}

// Clear forgets an agent's history and deletes its file (NFR-SHELL-011).
func (h *usageHistory) Clear(agent string) {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.clearLocked(agent)
	h.on[agent] = false
}

func (h *usageHistory) clearLocked(agent string) {
	delete(h.agents, agent)
	path := h.agentFile(agent)
	if path == "" {
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Printf("molten usage: cannot remove the usage history: %v\n", err)
	}
}

// Sync follows the agent's gauges: the history goes when they turn from on to off, never at an unrelated change of
// settings, and never when MoltenTerm starts with them off, since nothing then says they were on.
func (h *usageHistory) Sync(agent string, on bool) {
	h.lock.Lock()
	defer h.lock.Unlock()
	wasOn := h.on[agent]
	h.on[agent] = on
	if wasOn && !on {
		h.clearLocked(agent)
	}
}
