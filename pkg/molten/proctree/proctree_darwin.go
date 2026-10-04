// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build darwin

package proctree

import (
	"golang.org/x/sys/unix"
)

// SZOMB in <sys/proc.h>.
const darwinZombie = 5

// One sysctl returns every process with its parent, group and terminal's foreground group.
func readProcs() ([]Proc, error) {
	kprocs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, err
	}
	list := make([]Proc, 0, len(kprocs))
	for i := range kprocs {
		k := &kprocs[i]
		start := k.Proc.P_starttime
		list = append(list, Proc{
			Pid:     k.Proc.P_pid,
			Ppid:    k.Eproc.Ppid,
			Pgid:    k.Eproc.Pgid,
			Tpgid:   k.Eproc.Tpgid,
			Name:    cString(k.Proc.P_comm[:]),
			StartMs: int64(start.Sec)*1000 + int64(start.Usec)/1000,
			Zombie:  k.Proc.P_stat == darwinZombie,
		})
	}
	return list, nil
}

func cString(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
