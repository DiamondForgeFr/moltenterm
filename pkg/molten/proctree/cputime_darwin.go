// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build darwin

package proctree

import (
	"encoding/binary"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	// <libproc.h>, <sys/resource.h>: struct rusage_info_v1 is the first with the reaped children's times.
	rusageInfoV1     = 1
	rusageInfoV1Size = 144
	// Offsets of ri_user_time, ri_system_time, ri_child_user_time and ri_child_system_time (after the 16-byte uuid).
	riUserTime        = 16
	riSystemTime      = 24
	riChildUserTime   = 96
	riChildSystemTime = 104
	machTimebaseSize  = 8
)

type procPidRusageFunc func(pid int32, flavor int32, buffer uintptr) int32
type machTimebaseInfoFunc func(info uintptr) int32

var (
	cpuOnce       sync.Once
	cpuOk         bool
	procPidRusage procPidRusageFunc
	// The rusage times are Mach absolute time units: nanoseconds on Intel, 125/3 ns ticks on Apple silicon.
	timebaseNumer uint64
	timebaseDenom uint64
)

func loadCpu() bool {
	cpuOnce.Do(func() {
		handle, err := purego.Dlopen(systemLibPath, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		var machTimebaseInfo machTimebaseInfoFunc
		purego.RegisterLibFunc(&procPidRusage, handle, "proc_pid_rusage")
		purego.RegisterLibFunc(&machTimebaseInfo, handle, "mach_timebase_info")
		buf := heapBuffer(machTimebaseSize)
		ret := machTimebaseInfo(uintptr(unsafe.Pointer(&buf[0])))
		runtime.KeepAlive(buf)
		numer := uint64(binary.LittleEndian.Uint32(buf[0:4]))
		denom := uint64(binary.LittleEndian.Uint32(buf[4:8]))
		if ret != 0 || numer == 0 || denom == 0 {
			return
		}
		timebaseNumer, timebaseDenom = numer, denom
		cpuOk = true
	})
	return cpuOk
}

func machToDuration(ticks uint64) time.Duration {
	return time.Duration(ticks/timebaseDenom*timebaseNumer + ticks%timebaseDenom*timebaseNumer/timebaseDenom)
}

// The buffer goes to libproc from the heap, never the goroutine's stack (heapBuffer, #249).
func readCpu(pid int32) (Cpu, bool) {
	if !loadCpu() {
		return Cpu{}, false
	}
	buf := heapBuffer(rusageInfoV1Size)
	ret := procPidRusage(pid, rusageInfoV1, uintptr(unsafe.Pointer(&buf[0])))
	runtime.KeepAlive(buf)
	if ret != 0 {
		return Cpu{}, false
	}
	at := func(offset int) uint64 {
		return binary.LittleEndian.Uint64(buf[offset : offset+8])
	}
	return Cpu{
		Self:     machToDuration(at(riUserTime) + at(riSystemTime)),
		Children: machToDuration(at(riChildUserTime) + at(riChildSystemTime)),
	}, true
}
