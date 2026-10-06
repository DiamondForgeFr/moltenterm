// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build darwin

package proctree

import (
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	systemLibPath = "/usr/lib/libSystem.B.dylib"
	// <sys/proc_info.h>
	procPidVnodePathInfo = 9
	procPidPathMaxSize   = 4096
	// struct proc_vnodepathinfo: the current folder's struct vnode_info_path, then the root folder's. Each is a
	// struct vnode_info (152 bytes) followed by a MAXPATHLEN path.
	vnodeInfoSize     = 152
	maxPathLen        = 1024
	vnodePathInfoSize = 2 * (vnodeInfoSize + maxPathLen)
)

type procPidPathFunc func(pid int32, buffer uintptr, bufferSize uint32) int32
type procPidInfoFunc func(pid int32, flavor int32, arg uint64, buffer uintptr, bufferSize int32) int32

var (
	libOnce     sync.Once
	libOk       bool
	procPidPath procPidPathFunc
	procPidInfo procPidInfoFunc
)

func loadLib() bool {
	libOnce.Do(func() {
		handle, err := purego.Dlopen(systemLibPath, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		purego.RegisterLibFunc(&procPidPath, handle, "proc_pidpath")
		purego.RegisterLibFunc(&procPidInfo, handle, "proc_pidinfo")
		libOk = true
	})
	return libOk
}

// heapBuffer is what libproc writes into. The buffer reaches C as a bare address, which the stack does not track: a
// buffer on the goroutine's stack moves when the stack grows or shrinks before the call reaches C, and libproc then
// writes into freed stack memory, another goroutine's frames (#249: gopsutil's Exe and Cwd do this on macOS, and
// wavesrv crashed on a garbage return address). The heap never moves; returning the buffer from a function that is
// never inlined keeps it there.
//
//go:noinline
func heapBuffer(size int) []byte {
	return make([]byte, size)
}

// Exe is the path of a process's executable, or "" when it cannot be read (another user's process, an ended one).
func Exe(pid int32) string {
	if pid <= 0 || !loadLib() {
		return ""
	}
	buf := heapBuffer(procPidPathMaxSize)
	ret := procPidPath(pid, uintptr(unsafe.Pointer(&buf[0])), procPidPathMaxSize)
	runtime.KeepAlive(buf)
	if ret <= 0 || int(ret) > len(buf) {
		return ""
	}
	return cString(buf[:ret])
}

// Cwd is a process's current folder, or "" when it cannot be read.
func Cwd(pid int32) string {
	if pid <= 0 || !loadLib() {
		return ""
	}
	buf := heapBuffer(vnodePathInfoSize)
	ret := procPidInfo(pid, procPidVnodePathInfo, 0, uintptr(unsafe.Pointer(&buf[0])), vnodePathInfoSize)
	runtime.KeepAlive(buf)
	if ret != vnodePathInfoSize {
		return ""
	}
	return cString(buf[vnodeInfoSize : vnodeInfoSize+maxPathLen])
}
