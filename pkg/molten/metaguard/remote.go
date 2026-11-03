// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package metaguard

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// An SSH or WSL host runs nothing and opens nothing on this computer (NFR-FORK-001 (12), #1831). Wave lets the host
// of a connection call wavesrv as freely as a local terminal: a cmd or shell block with no connection runs here, a
// bare path or wsh://local reads and writes here. Only what reaches this computer is refused: a host keeps its own
// connection, and the other SSH connections Wave lets it hop to (wsh ssh, wsh file cp between servers).

const tsunamiController = "tsunami"

const wslConnPrefix = "wsl://"

// RemoteHint ends every refusal an SSH or WSL host gets: why, and where the developer does it instead.
const RemoteHint = " A server you connect to cannot run programs or open files on this computer; do it from the MoltenTerm window or a terminal of this computer."

// Remote is an SSH or WSL host, as its link proves it. Conn is the connection its token named, "" when unknown.
type Remote struct {
	Conn string
}

// RemoteOf tells whether ingressLinkId is an SSH or WSL host's link.
func RemoteOf(router *wshutil.WshRouter, ingressLinkId baseds.LinkId) (Remote, bool) {
	if router == nil {
		return Remote{}, false
	}
	conn, ok := router.RemoteLinkConn(ingressLinkId)
	return Remote{Conn: conn}, ok
}

// owns tells whether conn is r's own connection.
func (r Remote) owns(conn string) bool {
	own := wshutil.NormConnName(r.Conn)
	return own != wshrpc.LocalConnName && own == wshutil.NormConnName(conn)
}

// reaches tells whether r may act on conn (a block's connection, a path's host): its own, or an SSH server. This
// computer ("", local, local:*) and a WSL distribution, which runs on this computer, are out of its reach.
func (r Remote) reaches(conn string) bool {
	if r.owns(conn) {
		return true
	}
	return wshutil.NormConnName(conn) != wshrpc.LocalConnName && !strings.HasPrefix(conn, wslConnPrefix)
}

// RemoteCreateMeta is the meta a block r creates gets: a block meant for this computer (no connection, local, a WSL
// distribution) is forced onto r's own connection; one on an SSH server keeps it (wsh ssh). A host with no known
// connection opens no block on this computer, and none creates a tsunami controller (it builds and runs a local app).
func RemoteCreateMeta(r Remote, meta waveobj.MetaMapType) (waveobj.MetaMapType, error) {
	if err := checkRemoteKeys(meta); err != nil {
		return nil, err
	}
	rtn := waveobj.MetaMapType{}
	for key, value := range meta {
		rtn[key] = value
	}
	if conn, _ := meta[waveobj.MetaKey_Connection].(string); r.reaches(conn) {
		return rtn, nil
	}
	if r.Conn == "" {
		return nil, fmt.Errorf("refused: an SSH or WSL host whose connection is unknown cannot open a panel on this computer."+RemoteHint)
	}
	rtn[waveobj.MetaKey_Connection] = r.Conn
	return rtn, nil
}

// checkRemoteKeys refuses the keys no SSH or WSL host writes anywhere: a tsunami controller, and a web address
// that is not http or https (file:// opens this computer's files).
func checkRemoteKeys(meta waveobj.MetaMapType) error {
	if controller, _ := meta[waveobj.MetaKey_Controller].(string); controller == tsunamiController {
		return fmt.Errorf("refused: an SSH or WSL host cannot start a %s app on this computer."+RemoteHint, tsunamiController)
	}
	for key, value := range meta {
		if key != waveobj.MetaKey_Url && !strings.HasPrefix(key, molten.BrowserOpenKeyPrefix) {
			continue
		}
		if page := metaUrl(value); page != "" && !isWebPage(page) {
			return fmt.Errorf("refused: an SSH or WSL host opens only web pages (http, https) on this computer, not %q."+RemoteHint, page)
		}
	}
	return nil
}

// metaUrl is the address of a url key or of a browser queue entry (a plain url, or an object with a url).
func metaUrl(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case map[string]any:
		page, _ := v["url"].(string)
		return page
	}
	return ""
}

func isWebPage(page string) bool {
	u, err := url.Parse(strings.TrimSpace(page))
	if err != nil {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	return (scheme == "http" || scheme == "https") && u.Host != ""
}

// CheckRemoteMetaWrite tells whether r may write meta on oref. blockConn is the block's connection (its meta) when
// oref is a block. On a block of its own connection or of an SSH server a host writes Wave's keys, but cannot move the
// block onto this computer; on a block of this computer it only queues web pages in a browser panel (wsh web open).
// It writes no window or client meta; tabs and workspaces keep the rules of CheckWrite.
func CheckRemoteMetaWrite(r Remote, oref waveobj.ORef, blockConn string, meta waveobj.MetaMapType) error {
	switch oref.OType {
	case waveobj.OType_Block:
	case waveobj.OType_Tab, waveobj.OType_Workspace:
		return checkRemoteKeys(meta)
	default:
		return fmt.Errorf("refused: an SSH or WSL host cannot change the meta of %s."+RemoteHint, oref)
	}
	if err := checkRemoteKeys(meta); err != nil {
		return err
	}
	if r.reaches(blockConn) {
		if conn, ok := meta[waveobj.MetaKey_Connection]; ok {
			name, _ := conn.(string)
			if !r.reaches(name) {
				return fmt.Errorf("refused: an SSH or WSL host cannot move a panel onto this computer."+RemoteHint)
			}
		}
		return nil
	}
	var refused []string
	for key := range meta {
		if !strings.HasPrefix(key, molten.BrowserOpenKeyPrefix) && !strings.HasPrefix(key, molten.BrowserCloseKeyPrefix) {
			refused = append(refused, key)
		}
	}
	if len(refused) > 0 {
		return fmt.Errorf("refused: an SSH or WSL host cannot set %s on %s, a panel of this computer; it only queues web pages in a browser panel."+RemoteHint, sortedKeys(refused), oref)
	}
	return nil
}

// CheckRemoteBlock tells whether r may act (what) on a block whose connection is blockConn: a resync, an input or a
// restart of a block of this computer would run here.
func CheckRemoteBlock(r Remote, blockConn string, what string) error {
	if r.reaches(blockConn) {
		return nil
	}
	return fmt.Errorf("refused: an SSH or WSL host cannot %s a panel of this computer."+RemoteHint, what)
}

// CheckRemotePath tells whether r may use the file path uri: a wsh path on its own connection or an SSH server. A
// bare path names wavesrv's current host, this computer.
func CheckRemotePath(r Remote, uri string) error {
	conn, err := connparse.ParseURI(uri)
	if err == nil && conn.Scheme == connparse.ConnectionTypeWsh && conn.Host != connparse.ConnHostCurrent && conn.Host != "" && r.reaches(conn.Host) {
		return nil
	}
	own := "its own connection's files"
	if r.Conn != "" {
		own = fmt.Sprintf("its own connection's files (wsh://%s/...)", r.Conn)
	}
	return fmt.Errorf("refused: an SSH or WSL host reaches %s, not %q on this computer."+RemoteHint, own, uri)
}

// CheckRemoteConn tells whether r may act (what) on the connection connName: its own or an SSH server, never this
// computer or a WSL distribution.
func CheckRemoteConn(r Remote, connName string, what string) error {
	if r.reaches(connName) {
		return nil
	}
	return fmt.Errorf("refused: an SSH or WSL host cannot %s %q, which runs on this computer."+RemoteHint, what, connName)
}

// RemoteRefusedCommands are the wavesrv commands no SSH or WSL host sends: they write the configuration (a local
// shell path, widgets), build and run local apps, approve Wave AI's tool calls, or write this computer's files.
var RemoteRefusedCommands = map[string]bool{
	"setconfig":              true,
	"setconnectionsconfig":   true,
	"writetempfile":          true,
	"filerestorebackup":      true,
	"listallappfiles":        true,
	"readappfile":            true,
	"writeappfile":           true,
	"writeappgofile":         true,
	"deleteappfile":          true,
	"renameappfile":          true,
	"writeappsecretbindings": true,
	"deletebuilder":          true,
	"startbuilder":           true,
	"stopbuilder":            true,
	"restartbuilderandwait":  true,
	"publishapp":             true,
	"makedraftfromlocal":     true,
	"waveaitoolapprove":      true,
}

// CheckRemoteCommand refuses the commands of RemoteRefusedCommands. This computer's own connection server (conn:local:
// start a job, stream, copy or delete a file, signal a process) is out of a host's reach at the router.
func CheckRemoteCommand(command string) error {
	if RemoteRefusedCommands[command] {
		return fmt.Errorf("refused: an SSH or WSL host cannot send %q to this computer."+RemoteHint, command)
	}
	return nil
}
