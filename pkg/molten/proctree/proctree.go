// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package proctree reads the local process table in one pass (FR-SHELL-011): which processes run, their parents,
// their process groups and the foreground process group of their terminal. wavesrv uses it to find the coding agent a
// terminal's shell runs in the foreground; only process metadata is read, never what a process prints.
package proctree

import (
	"errors"
	"sort"
)

const (
	// A terminal's foreground job is never this deep under its shell; the walk stops there.
	MaxDepth = 8
	// Nor this wide: a build spawning hundreds of workers is not walked further.
	MaxWalk = 512
)

var ErrUnsupported = errors.New("the process table cannot be read on this platform")

type Proc struct {
	Pid  int32
	Ppid int32
	Pgid int32
	// Tpgid: the foreground process group of the process's controlling terminal (0 or less: no terminal, or unknown).
	Tpgid int32
	// Name: the kernel's short name of the process (its executable's base name, cut to 15 or 16 bytes).
	Name string
	// StartMs: when the process started, in Unix milliseconds.
	StartMs int64
	Zombie  bool
}

type Table struct {
	procs    map[int32]*Proc
	children map[int32][]int32
}

func MakeTable(list []Proc) *Table {
	t := &Table{procs: make(map[int32]*Proc, len(list)), children: map[int32][]int32{}}
	for i := range list {
		p := &list[i]
		t.procs[p.Pid] = p
		if p.Ppid != p.Pid {
			t.children[p.Ppid] = append(t.children[p.Ppid], p.Pid)
		}
	}
	for ppid := range t.children {
		kids := t.children[ppid]
		sort.Slice(kids, func(i, j int) bool { return kids[i] < kids[j] })
	}
	return t
}

// Read reads the whole process table.
func Read() (*Table, error) {
	list, err := readProcs()
	if err != nil {
		return nil, err
	}
	return MakeTable(list), nil
}

func (t *Table) Get(pid int32) *Proc {
	if t == nil {
		return nil
	}
	return t.procs[pid]
}

func (t *Table) Len() int {
	if t == nil {
		return 0
	}
	return len(t.procs)
}

// Same tells whether pid is still the process that started at startMs (a reused pid is another process). Start times
// are compared within a second: platforms round them differently.
func (t *Table) Same(pid int32, startMs int64) bool {
	p := t.Get(pid)
	if p == nil || p.Zombie {
		return false
	}
	if startMs <= 0 || p.StartMs <= 0 {
		return true
	}
	diff := p.StartMs - startMs
	return diff > -1000 && diff < 1000
}

type walkItem struct {
	pid   int32
	depth int
	inFg  bool
}

// Foreground lists the processes of root's foreground job, nearest to root first: the processes under root (root
// included) in the foreground process group of root's terminal, and everything they started, whatever its group
// (sudo, a wrapper that starts its own session). An interactive shell at its prompt is itself the foreground group:
// its own children in another group (background jobs) are left out. Without a known terminal, every process under
// root is listed. Zombies are skipped.
func (t *Table) Foreground(root int32) []*Proc {
	rootProc := t.Get(root)
	if rootProc == nil {
		return nil
	}
	fg := rootProc.Tpgid
	var rtn []*Proc
	queue := []walkItem{{pid: root, depth: 0, inFg: fg <= 0 || rootProc.Pgid == fg}}
	seen := map[int32]bool{root: true}
	for len(queue) > 0 && len(seen) <= MaxWalk {
		item := queue[0]
		queue = queue[1:]
		p := t.procs[item.pid]
		if item.inFg && !p.Zombie {
			rtn = append(rtn, p)
		}
		if item.depth >= MaxDepth {
			continue
		}
		for _, kid := range t.children[item.pid] {
			if seen[kid] {
				continue
			}
			seen[kid] = true
			kp := t.procs[kid]
			// Under root, only root's foreground group counts; below a foreground process, everything does.
			inFg := fg <= 0 || kp.Pgid == fg || (item.inFg && item.pid != root)
			queue = append(queue, walkItem{pid: kid, depth: item.depth + 1, inFg: inFg})
		}
	}
	return rtn
}

// Running tells whether root's terminal runs a command: its foreground group is not root's own. Unknown (no
// terminal) counts as running.
func (t *Table) Running(root int32) bool {
	p := t.Get(root)
	if p == nil {
		return false
	}
	return p.Tpgid <= 0 || p.Tpgid != p.Pgid
}
