// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package machineload

import (
	"errors"
	"testing"
	"time"
)

// #2502: the load that slows the developer's runs, normalised by the number of cores, with a hysteresis.

type fakeMachine struct {
	average float64
	err     error
	cores   int
	clock   time.Time
}

func (f *fakeMachine) monitor() *Monitor {
	return &Monitor{
		average: func() (float64, error) { return f.average, f.err },
		cores:   func() int { return f.cores },
		now:     func() time.Time { return f.clock },
	}
}

func TestLoadIsNormalisedByTheNumberOfCores(t *testing.T) {
	t.Parallel()
	f := &fakeMachine{average: 96, cores: 12, clock: time.Unix(1_000_000, 0)}
	r := f.monitor().Read()
	if !r.Known || r.PerCore != 8 || r.Load1 != 96 || r.Cores != 12 || !r.Loaded {
		t.Errorf("a load of 96 on 12 cores is 8 per core, far over the threshold: %+v", r)
	}
	f.cores = 128
	if r := f.monitor().Read(); r.Loaded || r.PerCore >= 1 {
		t.Errorf("the same load on a machine of 128 cores is nothing: %+v", r)
	}
}

func TestNextHasAHysteresis(t *testing.T) {
	t.Parallel()
	cases := []struct {
		loaded  bool
		perCore float64
		want    bool
	}{
		{false, 0.4, false},
		{false, 1.9, false},
		{false, EnterPerCore, true},
		{false, 7, true},
		{true, 7, true},
		{true, EnterPerCore, true},
		{true, 1.5, true},
		{true, LeavePerCore, true},
		{true, 1.24, false},
		{true, 0, false},
	}
	for _, tc := range cases {
		if got := Next(tc.loaded, tc.perCore); got != tc.want {
			t.Errorf("loaded %v at %.2f per core: %v, want %v", tc.loaded, tc.perCore, got, tc.want)
		}
	}
}

func TestAReadingAroundTheThresholdDoesNotBlink(t *testing.T) {
	t.Parallel()
	f := &fakeMachine{cores: 10, clock: time.Unix(1_000_000, 0)}
	m := f.monitor()
	verdicts := []bool{}
	for _, perCore := range []float64{1.0, 1.9, 2.1, 1.8, 2.05, 1.6, 1.3, 1.2, 1.8} {
		f.average = perCore * 10
		f.clock = f.clock.Add(5 * time.Second)
		verdicts = append(verdicts, m.Read().Loaded)
	}
	want := []bool{false, false, true, true, true, true, true, false, false}
	for i := range want {
		if verdicts[i] != want[i] {
			t.Fatalf("verdicts %v, want %v", verdicts, want)
		}
	}
}

func TestAnOldVerdictIsNotCarriedOver(t *testing.T) {
	t.Parallel()
	f := &fakeMachine{average: 40, cores: 10, clock: time.Unix(1_000_000, 0)}
	m := f.monitor()
	if !m.Read().Loaded {
		t.Fatalf("loaded")
	}
	f.average = 15
	f.clock = f.clock.Add(HoldFor - time.Second)
	if !m.Read().Loaded {
		t.Errorf("a minute ago it was loaded and 1.5 per core is above the way out")
	}
	f.clock = f.clock.Add(HoldFor + time.Second)
	if m.Read().Loaded {
		t.Errorf("last looked at long ago: the enter threshold applies again, and 1.5 per core is below it")
	}
}

func TestNoLoadAverageIsNothingToSay(t *testing.T) {
	t.Parallel()
	f := &fakeMachine{average: 40, cores: 10, clock: time.Unix(1_000_000, 0)}
	m := f.monitor()
	m.Read()
	f.err = errors.New("no load average here")
	if r := m.Read(); r.Known || r.Loaded || r.PerCore != 0 {
		t.Errorf("unknown: %+v", r)
	}
	f.err, f.cores = nil, 0
	if r := m.Read(); r.Known {
		t.Errorf("no core, no reading: %+v", r)
	}
	f.cores, f.average = 10, 15
	if r := m.Read(); r.Loaded {
		t.Errorf("a failed look forgot the verdict: %+v", r)
	}
}

func TestTheSystemGivesAReading(t *testing.T) {
	t.Parallel()
	r := Default.Read()
	if r.Known && (r.Cores <= 0 || r.PerCore < 0 || r.Load1 < 0) {
		t.Errorf("a known reading is made of real numbers: %+v", r)
	}
}
