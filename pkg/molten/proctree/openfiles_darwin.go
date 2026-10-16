// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build darwin

package proctree

import (
	"encoding/binary"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	// <sys/proc_info.h>: proc_pidinfo's PROC_PIDLISTFDS lists struct proc_fdinfo {int32 fd; uint32 type}; for a
	// vnode (PROX_FDTYPE_VNODE), proc_pidfdinfo's PROC_PIDFDVNODEPATHINFO gives struct vnode_fdinfowithpath: a struct
	// proc_fileinfo (24 bytes), a struct vnode_info (152) and the MAXPATHLEN path.
	procPidListFds         = 1
	procFdInfoSize         = 8
	proxFdTypeVnode        = 1
	procPidFdVnodePathInfo = 2
	vnodeFdPathInfoSize    = 24 + vnodeInfoSize + maxPathLen
	vnodeFdPathOffset      = 24 + vnodeInfoSize
	// An agent with more descriptors than this is not walked further.
	maxOpenFds = 4096
)

type procPidFdInfoFunc func(pid int32, fd int32, flavor int32, buffer uintptr, bufferSize int32) int32

var (
	fdLibOnce     sync.Once
	fdLibOk       bool
	procPidFdInfo procPidFdInfoFunc
)

func loadFdLib() bool {
	if !loadLib() {
		return false
	}
	fdLibOnce.Do(func() {
		handle, err := purego.Dlopen(systemLibPath, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		purego.RegisterLibFunc(&procPidFdInfo, handle, "proc_pidfdinfo")
		fdLibOk = true
	})
	return fdLibOk
}

// OpenFiles lists the paths of the files a process holds open, or nil when they cannot be read (another user's
// process, an ended one). Only metadata is read, never the files.
func OpenFiles(pid int32) []string {
	if pid <= 0 || !loadFdLib() {
		return nil
	}
	size := procPidInfo(pid, procPidListFds, 0, 0, 0)
	if size <= 0 {
		return nil
	}
	// Room for descriptors opened between the two calls.
	size += 32 * procFdInfoSize
	if size > maxOpenFds*procFdInfoSize {
		size = maxOpenFds * procFdInfoSize
	}
	buf := heapBuffer(int(size))
	n := procPidInfo(pid, procPidListFds, 0, uintptr(unsafe.Pointer(&buf[0])), size)
	runtime.KeepAlive(buf)
	if n <= 0 || int(n) > len(buf) {
		return nil
	}
	pathBuf := heapBuffer(vnodeFdPathInfoSize)
	var rtn []string
	for off := 0; off+procFdInfoSize <= int(n); off += procFdInfoSize {
		fd := int32(binary.LittleEndian.Uint32(buf[off:]))
		if binary.LittleEndian.Uint32(buf[off+4:]) != proxFdTypeVnode {
			continue
		}
		ret := procPidFdInfo(pid, fd, procPidFdVnodePathInfo, uintptr(unsafe.Pointer(&pathBuf[0])), vnodeFdPathInfoSize)
		runtime.KeepAlive(pathBuf)
		if ret != vnodeFdPathInfoSize {
			continue
		}
		if path := cString(pathBuf[vnodeFdPathOffset : vnodeFdPathOffset+maxPathLen]); path != "" {
			rtn = append(rtn, path)
		}
	}
	return rtn
}
