// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshfs

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// #1831: the destination's server reads the source with the path it parses back from the uri wavesrv sends it
// (RemoteFileCopy's SrcUri); the grant must name that very path, for a home path, a Windows path or spaces.
func TestCopyGrantNamesThePathTheDestinationReads(t *testing.T) {
	dest, err := connparse.ParseURI("wsh://dev@build.example/tmp/")
	if err != nil {
		t.Fatal(err)
	}
	for _, uri := range []string{
		"wsh://local/~/notes.txt", "wsh://local/Users/me/My Notes/a b.txt", "wsh://local/C:\\Users\\me\\x.txt",
		"wsh://local/C:/Users/me/x.txt", "//local/~/x", "wsh://other@host:2222/var/log/x",
	} {
		src, err := connparse.ParseURI(uri)
		if err != nil {
			t.Fatal(err)
		}
		revoke := moltenGrantCopySource(src, dest)
		// What wshremote's RemoteFileCopyCommand does on the destination.
		remoteSide, err := connparse.ParseURI(src.GetFullURI())
		if err != nil {
			t.Fatal(err)
		}
		route := wshutil.MakeConnectionRouteId(src.Host)
		if !wshutil.RemoteReadGranted("dev@build.example:22", route, remoteSide.Path) {
			t.Errorf("%s: the destination reads %q, not granted", uri, remoteSide.Path)
		}
		if wshutil.RemoteReadGranted("dev@build.example", route, remoteSide.Path+".other") {
			t.Errorf("%s: another file was granted", uri)
		}
		revoke()
		if wshutil.RemoteReadGranted("dev@build.example", route, remoteSide.Path) {
			t.Errorf("%s: the grant outlived the copy", uri)
		}
	}
	same, _ := connparse.ParseURI("wsh://dev@build.example/tmp/x")
	moltenGrantCopySource(same, dest)()
	if wshutil.RemoteReadGranted("dev@build.example", wshutil.MakeConnectionRouteId("dev@build.example"), "/tmp/x") {
		t.Fatal("a copy on one connection granted a read")
	}
}
