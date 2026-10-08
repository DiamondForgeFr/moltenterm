// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package proctree

import (
	"errors"
	"os"
	"runtime"
	"strings"
	"testing"
)

func pids(list []*Proc) []int32 {
	var rtn []int32
	for _, p := range list {
		rtn = append(rtn, p.Pid)
	}
	return rtn
}

func samePids(a []int32, b ...int32) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestForeground(t *testing.T) {
	cases := []struct {
		name    string
		procs   []Proc
		want    []int32
		running bool
	}{
		{
			name: "an agent in the foreground, its own children, not the prompt's background helpers",
			procs: []Proc{
				{Pid: 100, Ppid: 1, Pgid: 100, Tpgid: 200, Name: "zsh"},
				{Pid: 150, Ppid: 100, Pgid: 150, Tpgid: 200, Name: "gitstatusd"},
				{Pid: 200, Ppid: 100, Pgid: 200, Tpgid: 200, Name: "claude"},
				{Pid: 210, Ppid: 200, Pgid: 200, Tpgid: 200, Name: "node"},
			},
			want:    []int32{200, 210},
			running: true,
		},
		{
			name: "a shell at its prompt: itself only, background jobs left out",
			procs: []Proc{
				{Pid: 100, Ppid: 1, Pgid: 100, Tpgid: 100, Name: "zsh"},
				{Pid: 160, Ppid: 100, Pgid: 160, Tpgid: 100, Name: "claude"},
				{Pid: 170, Ppid: 100, Pgid: 100, Tpgid: 100, Name: "git"},
			},
			want:    []int32{100, 170},
			running: false,
		},
		{
			name: "sudo: the agent in another session under the foreground process",
			procs: []Proc{
				{Pid: 100, Ppid: 1, Pgid: 100, Tpgid: 300, Name: "zsh"},
				{Pid: 300, Ppid: 100, Pgid: 300, Tpgid: 300, Name: "sudo"},
				{Pid: 310, Ppid: 300, Pgid: 310, Tpgid: 310, Name: "claude"},
			},
			want:    []int32{300, 310},
			running: true,
		},
		{
			name: "a nested shell: the inner shell's job is the terminal's foreground",
			procs: []Proc{
				{Pid: 100, Ppid: 1, Pgid: 100, Tpgid: 130, Name: "zsh"},
				{Pid: 120, Ppid: 100, Pgid: 120, Tpgid: 130, Name: "bash"},
				{Pid: 130, Ppid: 120, Pgid: 130, Tpgid: 130, Name: "codex"},
			},
			want:    []int32{130},
			running: true,
		},
		{
			name: "no terminal known: everything under root, zombies skipped",
			procs: []Proc{
				{Pid: 100, Ppid: 1, Pgid: 100, Tpgid: -1, Name: "sh"},
				{Pid: 110, Ppid: 100, Pgid: 100, Tpgid: -1, Name: "claude", Zombie: true},
				{Pid: 120, Ppid: 100, Pgid: 100, Tpgid: -1, Name: "claude"},
			},
			want:    []int32{100, 120},
			running: true,
		},
	}
	for _, c := range cases {
		table := MakeTable(c.procs)
		if got := pids(table.Foreground(100)); !samePids(got, c.want...) {
			t.Errorf("%s: foreground %v, want %v", c.name, got, c.want)
		}
		if got := table.Running(100); got != c.running {
			t.Errorf("%s: running %v, want %v", c.name, got, c.running)
		}
	}
	if MakeTable(nil).Foreground(100) != nil || MakeTable(nil).Running(100) {
		t.Error("an unknown root has no foreground")
	}
}

func TestForegroundBounded(t *testing.T) {
	var procs []Proc
	procs = append(procs, Proc{Pid: 1, Ppid: 0, Pgid: 1, Tpgid: -1})
	for i := int32(2); i < 50; i++ {
		procs = append(procs, Proc{Pid: i, Ppid: i - 1, Pgid: 1, Tpgid: -1})
	}
	if got := len(MakeTable(procs).Foreground(1)); got != MaxDepth+1 {
		t.Errorf("a deep chain is walked %d levels, want %d", got, MaxDepth+1)
	}
	procs = []Proc{{Pid: 1, Ppid: 0, Pgid: 1, Tpgid: -1}}
	for i := int32(2); i < 2000; i++ {
		procs = append(procs, Proc{Pid: i, Ppid: 1, Pgid: 1, Tpgid: -1})
	}
	if got := len(MakeTable(procs).Foreground(1)); got > MaxWalk+1 {
		t.Errorf("a wide tree is walked over %d processes: %d", MaxWalk, got)
	}
	// A cycle (a corrupt table) does not loop.
	cycle := MakeTable([]Proc{{Pid: 1, Ppid: 2, Pgid: 1, Tpgid: -1}, {Pid: 2, Ppid: 1, Pgid: 1, Tpgid: -1}})
	if got := len(cycle.Foreground(1)); got != 2 {
		t.Errorf("cycle walked %d", got)
	}
}

func TestDescendants(t *testing.T) {
	table := MakeTable([]Proc{
		{Pid: 1, Ppid: 0, Name: "zsh"},
		{Pid: 2, Ppid: 1, Name: "sleep"},
		{Pid: 3, Ppid: 2, Name: "child"},
		{Pid: 4, Ppid: 1, Name: "gone", Zombie: true},
		{Pid: 5, Ppid: 9, Name: "other"},
	})
	var names []string
	for _, p := range table.Descendants(1) {
		names = append(names, p.Name)
	}
	if strings.Join(names, ",") != "sleep,child" {
		t.Errorf("got %v", names)
	}
	if table.Descendants(42) != nil {
		t.Error("a missing root has no descendants")
	}
}

func TestSame(t *testing.T) {
	table := MakeTable([]Proc{{Pid: 10, StartMs: 5_000}, {Pid: 11, StartMs: 7_000, Zombie: true}})
	if !table.Same(10, 5_400) || !table.Same(10, 0) {
		t.Error("the same process, start times rounded differently")
	}
	if table.Same(10, 9_000) {
		t.Error("a reused pid is another process")
	}
	if table.Same(11, 7_000) || table.Same(12, 0) {
		t.Error("a zombie or a missing process is gone")
	}
}

func TestParseStat(t *testing.T) {
	line := []byte("4242 (my (odd) name) S 4000 4242 4000 34816 4242 4194304 1 0 0 0 0 0 0 0 20 0 1 0 1500 1000 100\n")
	p, ok := parseStat(line, 1_700_000_000)
	if !ok {
		t.Fatal("not parsed")
	}
	want := Proc{Pid: 4242, Ppid: 4000, Pgid: 4242, Tpgid: 4242, Name: "my (odd) name", StartMs: 1_700_000_000_000 + 15_000}
	if p != want {
		t.Errorf("parsed %+v, want %+v", p, want)
	}
	z, _ := parseStat([]byte("7 (x) Z 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0"), 0)
	if !z.Zombie || z.Tpgid != -1 {
		t.Errorf("zombie: %+v", z)
	}
	if _, ok := parseStat([]byte("garbage"), 0); ok {
		t.Error("garbage parsed")
	}
	if got := parseBootTime([]byte("cpu 1 2 3\nbtime 1700000000\nprocesses 5\n")); got != 1_700_000_000 {
		t.Errorf("boot time %d", got)
	}
}

func TestReadSelf(t *testing.T) {
	table, err := Read()
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		if !errors.Is(err, ErrUnsupported) {
			t.Errorf("unsupported platform: %v", err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	self := table.Get(int32(os.Getpid()))
	if self == nil || self.Ppid != int32(os.Getppid()) || self.StartMs <= 0 || self.Name == "" {
		t.Fatalf("this process: %+v", self)
	}
	if !table.Same(self.Pid, self.StartMs) {
		t.Error("this process is itself")
	}
}

// The cost of one pass's read of the process table.
func BenchmarkRead(b *testing.B) {
	for i := 0; i < b.N; i++ {
		if _, err := Read(); err != nil {
			b.Skip(err)
		}
	}
}
