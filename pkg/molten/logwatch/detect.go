// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"sort"
	"time"
)

// What Brokk raises (FR-BOSS-012 AC6, AC7): a new signature of a panic or a crash, a spike of any signature, a log that
// grows too fast. Each signature raises at most one card a day; while its card is open, the card's figures are kept up
// to date in place. The rules read the stamps of the log's lines, not the time of the look, and the clock they are
// handed: they are tested on synthetic logs with a clock of the test.

const (
	EventNew    = "new"
	EventSpike  = "spike"
	EventGrowth = "growth"

	// GrowthId stands for the log's growth where a signature's id would be.
	GrowthId = "growth"

	// A spike (the ticket's rule): more than one a minute (SpikePerMinute or more) in each of SpikeMinutes consecutive
	// minutes, ending at the minute of its last occurrence or the minute before it (the last one may have just begun), or
	// SpikeFactor times its usual rate with at least SpikeLookCount in one look, for a signature known for an hour.
	SpikeMinutes    = 5
	SpikePerMinute  = 2
	SpikeFactor     = 10
	SpikeLookCount  = 10
	usualMinHistory = time.Hour

	// GrowthLimit: the log's bytes of the last hour past which it grows abnormally.
	GrowthLimit = 50 << 20

	// RaiseEvery: a signature's card is raised at most once in this time.
	RaiseEvery = 24 * time.Hour
	// Recent: only what the log showed in this time raises anything.
	Recent = 24 * time.Hour
)

// lookFacts is what one look found, per signature.
type lookFacts struct {
	count   map[string]int64
	first   map[string]int64
	last    map[string]int64
	before  map[string]Signature
	created map[string]bool
	order   []string
}

// ingest adds the records to the state's signatures. Each signature's excerpt is its newest occurrence, masked once per
// look whatever the number of occurrences.
func (s *State) ingest(recs []Record, m masker) lookFacts {
	f := lookFacts{count: map[string]int64{}, first: map[string]int64{}, last: map[string]int64{},
		before: map[string]Signature{}, created: map[string]bool{}}
	index := s.index()
	newest := map[string]int{}
	for r, rec := range recs {
		id := rec.Id()
		at := rec.At.UnixMilli()
		i, ok := index[id]
		if !ok {
			s.Signatures = append(s.Signatures, Signature{Id: id, Kind: rec.Kind, Pattern: rec.Pattern, Frames: rec.Frames, First: at, Last: at})
			i = len(s.Signatures) - 1
			index[id] = i
			f.created[id] = true
		}
		sig := &s.Signatures[i]
		if _, seen := f.count[id]; !seen {
			f.before[id] = *sig
			f.first[id] = at
			f.order = append(f.order, id)
		}
		f.count[id]++
		f.first[id] = min(f.first[id], at)
		f.last[id] = max(f.last[id], at)
		sig.Count++
		sig.First = min(sig.First, at)
		if at >= sig.Last || sig.Excerpt == "" {
			sig.Last = max(sig.Last, at)
			newest[id] = r
		}
		sig.Minutes = addMinute(sig.Minutes, minuteOf(at), 1)
	}
	for id, r := range newest {
		s.Signatures[index[id]].Excerpt = excerptOf(recs[r], m)
	}
	return f
}

// index maps each signature's id to its place in the state.
func (s *State) index() map[string]int {
	index := make(map[string]int, len(s.Signatures))
	for i := range s.Signatures {
		index[s.Signatures[i].Id] = i
	}
	return index
}

// sustained: SpikePerMinute or more in each of the SpikeMinutes minutes that end at last.
func sustained(minutes []minuteCount, last int64) bool {
	for m := last - SpikeMinutes + 1; m <= last; m++ {
		if n, _ := sumMinutes(minutes, m, m); n < SpikePerMinute {
			return false
		}
	}
	return true
}

// addBytes counts the log's bytes in the minute of their stamp.
func (s *State) addBytes(at time.Time, n int64) {
	s.Bytes = addMinute(s.Bytes, minuteOf(at.UnixMilli()), n)
}

// spikeRate is the rate a minute of a spiking signature, 0 when it does not spike.
func spikeRate(sig Signature, f lookFacts) float64 {
	last := minuteOf(sig.Last)
	for _, end := range []int64{last, last - 1} {
		if sustained(sig.Minutes, end) {
			count, _ := sumMinutes(sig.Minutes, end-SpikeMinutes+1, end)
			return float64(count) / SpikeMinutes
		}
	}
	before, known := f.before[sig.Id], !f.created[sig.Id]
	n := f.count[sig.Id]
	history := time.Duration(before.Last-before.First) * time.Millisecond
	if !known || n < SpikeLookCount || before.Count <= 0 || history < usualMinHistory {
		return 0
	}
	usual := float64(before.Count) / history.Minutes()
	span := max(1, time.Duration(f.last[sig.Id]-f.first[sig.Id])*time.Millisecond/time.Minute)
	current := float64(n) / float64(span)
	if current >= SpikeFactor*usual {
		return current
	}
	return 0
}

// cardOp is a card to raise (a new one) or to refresh (only while it is open).
type cardOp struct {
	id    string
	raise bool
}

func raisesNew(kind string) bool {
	return kind == KindPanic || kind == KindCrash
}

// decide says which cards the look raises or refreshes, and marks the raised ones.
func (s *State) decide(f lookFacts, now time.Time) []cardOp {
	var ops []cardOp
	nowMs := now.UnixMilli()
	index := s.index()
	for _, id := range f.order {
		i, ok := index[id]
		if !ok || s.muted(id) {
			continue
		}
		sig := &s.Signatures[i]
		if nowMs-sig.Last > Recent.Milliseconds() {
			continue
		}
		event := ""
		if spikeRate(*sig, f) > 0 {
			event = EventSpike
		} else if f.created[id] && raisesNew(sig.Kind) {
			event = EventNew
		}
		if sig.Raised != 0 && nowMs-sig.Raised < RaiseEvery.Milliseconds() {
			if event == EventSpike {
				sig.Event = EventSpike
			}
			ops = append(ops, cardOp{id: id})
			continue
		}
		if event == "" {
			continue
		}
		sig.Raised, sig.Event, sig.Asked = nowMs, event, ""
		ops = append(ops, cardOp{id: id, raise: true})
	}
	grown := s.grownLastHour(now)
	if grown > GrowthLimit && !s.muted(GrowthId) {
		if s.Growth.Raised == 0 || nowMs-s.Growth.Raised >= RaiseEvery.Milliseconds() {
			s.Growth = growthMark{Raised: nowMs, Bytes: grown}
			ops = append(ops, cardOp{id: GrowthId, raise: true})
		} else if grown != s.Growth.Bytes {
			s.Growth.Bytes = grown
			ops = append(ops, cardOp{id: GrowthId})
		}
	}
	return ops
}

// grownLastHour: the log's bytes whose stamps fall in the hour before now.
func (s *State) grownLastHour(now time.Time) int64 {
	nowMinute := minuteOf(now.UnixMilli())
	total, _ := sumMinutes(s.Bytes, nowMinute-historyMinutes+1, nowMinute)
	return total
}

// rateOf is a signature's rate a minute over the minutes before its last occurrence, at least 1.
func rateOf(sig Signature) int64 {
	last := minuteOf(sig.Last)
	count, _ := sumMinutes(sig.Minutes, last-SpikeMinutes+1, last)
	return max(1, (count+SpikeMinutes/2)/SpikeMinutes)
}

// busiest are the signatures seen most in the last hour, for the brief of a log that grows: what writes it.
func (s *State) busiest(now time.Time, n int) []Signature {
	nowMinute := minuteOf(now.UnixMilli())
	type ranked struct {
		sig   Signature
		count int64
	}
	var all []ranked
	for _, sig := range s.Signatures {
		count, _ := sumMinutes(sig.Minutes, nowMinute-historyMinutes+1, nowMinute)
		if count > 0 {
			all = append(all, ranked{sig, count})
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].count > all[j].count })
	var out []Signature
	for i := 0; i < len(all) && i < n; i++ {
		out = append(out, all[i].sig)
	}
	return out
}
