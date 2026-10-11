// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package proctree

import (
	"bytes"
	"strconv"
	"strings"
	"time"
)

// Linux's clock ticks per second (USER_HZ): 100 on every architecture Linux ships for.
const linuxClockTicks = 100

// parseStat reads one /proc/<pid>/stat line: "pid (name) state ppid pgrp session tty_nr tpgid ... starttime ...".
// The name may hold spaces and parentheses: it ends at the last ')'.
func parseStat(data []byte, bootSec int64) (Proc, bool) {
	open := bytes.IndexByte(data, '(')
	end := bytes.LastIndexByte(data, ')')
	if open < 0 || end < open {
		return Proc{}, false
	}
	pid, err := strconv.ParseInt(strings.TrimSpace(string(data[:open])), 10, 32)
	if err != nil {
		return Proc{}, false
	}
	fields := strings.Fields(string(data[end+1:]))
	// fields[0] is the state (field 3); starttime is field 22.
	if len(fields) < 20 {
		return Proc{}, false
	}
	num := func(i int) int64 {
		v, _ := strconv.ParseInt(fields[i], 10, 64)
		return v
	}
	startTicks := num(19)
	return Proc{
		Pid:     int32(pid),
		Ppid:    int32(num(1)),
		Pgid:    int32(num(2)),
		Tpgid:   int32(num(5)),
		Name:    string(data[open+1 : end]),
		StartMs: bootSec*1000 + startTicks*1000/linuxClockTicks,
		Zombie:  fields[0] == "Z" || fields[0] == "X",
	}, true
}

// parseStatCpu reads the CPU times of one /proc/<pid>/stat line: utime, stime (fields 14 and 15), and cutime, cstime
// (16 and 17, the children it waited for), in clock ticks.
func parseStatCpu(data []byte) (Cpu, bool) {
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return Cpu{}, false
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 15 {
		return Cpu{}, false
	}
	ticks := func(i int) time.Duration {
		v, _ := strconv.ParseInt(fields[i], 10, 64)
		if v < 0 {
			v = 0
		}
		return time.Duration(v) * time.Second / linuxClockTicks
	}
	return Cpu{Self: ticks(11) + ticks(12), Children: ticks(13) + ticks(14)}, true
}

// parseBootTime reads the "btime" line of /proc/stat.
func parseBootTime(data []byte) int64 {
	for _, line := range strings.Split(string(data), "\n") {
		if rest, ok := strings.CutPrefix(line, "btime "); ok {
			v, _ := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
			return v
		}
	}
	return 0
}
