// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	// Kimi gives a month and no week: MoltenTerm deduces the week from the readings it records itself (FR-SHELL-018,
	// FR-SHELL-156, #2451), in its own data folder, never under Kimi Code's.
	kimiHistoryDir      = "molten/usage"
	kimiHistoryFile     = "kimi-usage.json"
	kimiHistoryVersion  = 1
	kimiHistoryKeepDays = 62
	kimiHistoryMaxBytes = 256 * 1024
	kimiDayLayout       = "2006-01-02"

	DeducedWeekLabel = "Week (from the month)"
)

// monthReading is the monthly used share (percent) at one moment, with the reset of the window it belongs to.
type monthReading struct {
	At       int64   `json:"at"`
	Used     float64 `json:"used"`
	ResetsAt int64   `json:"resetsat"`
}

// monthDay holds a day's first reading and its latest.
type monthDay struct {
	Day   string       `json:"day"`
	First monthReading `json:"first"`
	Last  monthReading `json:"last"`
}

type kimiHistoryDoc struct {
	Version int        `json:"version"`
	Days    []monthDay `json:"days"`
	// Last is the last reading the endpoint gave, shown again while the token has expired, a restart included.
	Last *UsageSnapshot `json:"last,omitempty"`
}

// kimiHistory keeps the readings in memory and in one file. An empty path keeps nothing (a test that gives none).
type kimiHistory struct {
	lock   sync.Mutex
	path   func() string
	loc    *time.Location
	doc    *kimiHistoryDoc
	loaded string
}

func defaultKimiHistoryPath() string {
	dir := wavebase.GetWaveDataDir()
	// A test never writes in the data folder of the app it runs beside: it gives its own folder (UseForTest).
	if dir == "" || testing.Testing() {
		return ""
	}
	return filepath.Join(dir, kimiHistoryDir, kimiHistoryFile)
}

func (h *kimiHistory) location() *time.Location {
	if h.loc == nil {
		return time.Local
	}
	return h.loc
}

// docLocked loads the file once per path; a missing, unreadable or foreign file starts an empty history.
func (h *kimiHistory) docLocked() (*kimiHistoryDoc, string) {
	path := ""
	if h.path != nil {
		path = h.path()
	}
	if path == "" {
		return nil, ""
	}
	if h.doc != nil && h.loaded == path {
		return h.doc, path
	}
	doc := &kimiHistoryDoc{Version: kimiHistoryVersion}
	if data, err := readBoundedRegularFile(path, kimiHistoryMaxBytes); err == nil {
		var read kimiHistoryDoc
		if json.Unmarshal(data, &read) == nil && read.Version == kimiHistoryVersion {
			doc = &read
		}
	}
	h.doc, h.loaded = doc, path
	return doc, path
}

func writeKimiHistory(path string, doc *kimiHistoryDoc) error {
	data, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+kimiHistoryFile+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func monthWindowOf(snap UsageSnapshot) *UsageWindow {
	for i := range snap.Windows {
		if snap.Windows[i].Id == WindowMonth {
			return &snap.Windows[i]
		}
	}
	return nil
}

// record keeps the snapshot as the last reading and its monthly share as the day's first reading or its latest.
func (h *kimiHistory) record(snap UsageSnapshot, now time.Time) {
	h.lock.Lock()
	defer h.lock.Unlock()
	doc, path := h.docLocked()
	if doc == nil {
		return
	}
	last := cloneSnapshot(snap)
	last.Stale = ""
	doc.Last = &last
	if month := monthWindowOf(snap); month != nil && month.ResetsAt > 0 {
		reading := monthReading{At: now.UnixMilli(), Used: month.UsedPercent, ResetsAt: month.ResetsAt}
		day := now.In(h.location()).Format(kimiDayLayout)
		if n := len(doc.Days); n > 0 && doc.Days[n-1].Day == day {
			doc.Days[n-1].Last = reading
		} else if n == 0 || doc.Days[n-1].Day < day {
			doc.Days = append(doc.Days, monthDay{Day: day, First: reading, Last: reading})
		}
		oldest := now.In(h.location()).AddDate(0, 0, -kimiHistoryKeepDays).Format(kimiDayLayout)
		for len(doc.Days) > 0 && doc.Days[0].Day < oldest {
			doc.Days = doc.Days[1:]
		}
	}
	writeKimiHistory(path, doc)
}

// last is the last reading recorded, nil when there is none.
func (h *kimiHistory) last() *UsageSnapshot {
	h.lock.Lock()
	defer h.lock.Unlock()
	doc, _ := h.docLocked()
	if doc == nil || doc.Last == nil {
		return nil
	}
	snap := cloneSnapshot(*doc.Last)
	return &snap
}

// clear forgets every reading and removes the file: turning the gauges off clears what they read (NFR-SHELL-011).
func (h *kimiHistory) clear() {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.doc, h.loaded = nil, ""
	path := ""
	if h.path != nil {
		path = h.path()
	}
	if path == "" {
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		log.Printf("molten usage: cannot remove the Kimi readings: %v\n", err)
	}
}

// previousMonthResetAt is the monthly window's start: the same day one calendar month before, the last day of that
// month when it is shorter (as the companion's previousMonthReset does).
func previousMonthResetAt(reset time.Time) time.Time {
	first := time.Date(reset.Year(), reset.Month()-1, 1, reset.Hour(), reset.Minute(), reset.Second(), reset.Nanosecond(), reset.Location())
	daysThere := time.Date(first.Year(), first.Month()+1, 0, 0, 0, 0, 0, reset.Location()).Day()
	return first.AddDate(0, 0, min(reset.Day(), daysThere)-1)
}

func weekStartOf(now time.Time) time.Time {
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	return day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
}

// deducedWeek computes this week's row from the month (#2451). The weekly budget is the month × 7 / the days of the
// monthly window. A day's use is the rise of its latest reading over the latest one before it when that one is from
// this week or the Sunday before (so the use of unrecorded days in between counts on the next recorded day), else over
// the day's own first reading; a reading of a new monthly window counts from 0. A day with no reading is unknown.
func (h *kimiHistory) deducedWeek(month UsageWindow, now time.Time) (UsageWindow, bool) {
	if month.ResetsAt <= 0 {
		return UsageWindow{}, false
	}
	h.lock.Lock()
	defer h.lock.Unlock()
	doc, _ := h.docLocked()
	if doc == nil || len(doc.Days) == 0 {
		return UsageWindow{}, false
	}
	loc := h.location()
	now = now.In(loc)
	reset := time.UnixMilli(month.ResetsAt).In(loc)
	windowDays := math.Round(reset.Sub(previousMonthResetAt(reset)).Hours() / 24)
	if windowDays < 1 {
		return UsageWindow{}, false
	}
	dayBudget := 100 / windowDays
	start := weekStartOf(now)
	floor := start.AddDate(0, 0, -1).Format(kimiDayLayout)
	today := now.Format(kimiDayLayout)
	byDay := map[string]int{}
	for i, d := range doc.Days {
		byDay[d.Day] = i
	}
	days := make([]float64, 7)
	total, known := 0.0, false
	for i := range days {
		key := start.AddDate(0, 0, i).Format(kimiDayLayout)
		if key > today {
			days[i] = 0
			continue
		}
		idx, ok := byDay[key]
		if !ok {
			days[i] = DeducedDayUnknown
			continue
		}
		entry := doc.Days[idx]
		base := entry.First
		if idx > 0 && doc.Days[idx-1].Day >= floor {
			base = doc.Days[idx-1].Last
		}
		use := entry.Last.Used - base.Used
		if base.ResetsAt != entry.Last.ResetsAt {
			use = entry.Last.Used
		}
		use = max(0, use)
		total += use
		known = true
		days[i] = math.Round(use/dayBudget*1000) / 10
	}
	if !known {
		return UsageWindow{}, false
	}
	return UsageWindow{
		Id:          WindowWeek,
		Label:       DeducedWeekLabel,
		UsedPercent: math.Round(total/(dayBudget*7)*1000) / 10,
		ResetsAt:    start.AddDate(0, 0, 7).UnixMilli(),
		WindowMins:  sevenDayMins,
		Deduced:     true,
		Days:        days,
	}, true
}

// withDeducedWeek adds the deduced week, before the month, to a reading that has a month and no week of its own.
func (h *kimiHistory) withDeducedWeek(snap UsageSnapshot, now time.Time) UsageSnapshot {
	at := -1
	for i, w := range snap.Windows {
		if w.Id == WindowWeek {
			return snap
		}
		if w.Id == WindowMonth {
			at = i
		}
	}
	if at < 0 {
		return snap
	}
	week, ok := h.deducedWeek(snap.Windows[at], now)
	if !ok {
		return snap
	}
	snap.Windows = slices.Insert(slices.Clone(snap.Windows), at, week)
	return snap
}
