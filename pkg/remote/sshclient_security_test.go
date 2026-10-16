// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package remote

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestConnectInternalSSHAuthentication(t *testing.T) {
	makeSigner := func() ssh.Signer {
		_, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		signer, err := ssh.NewSignerFromKey(private)
		if err != nil {
			t.Fatal(err)
		}
		return signer
	}
	host, identity, other := makeSigner(), makeSigner(), makeSigner()
	for _, name := range []string{"authenticated", "wrong-host-key", "wrong-identity"} {
		t.Run(name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			serverDone := make(chan struct{})
			var client *ssh.Client
			t.Cleanup(func() {
				listener.Close()
				if client != nil {
					client.Close()
				}
				<-serverDone
			})
			go func() {
				defer close(serverDone)
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(time.Minute))
				config := &ssh.ServerConfig{PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
					if meta.User() != "fixture" || !bytes.Equal(key.Marshal(), identity.PublicKey().Marshal()) {
						return nil, fmt.Errorf("unknown fixture identity")
					}
					return nil, nil
				}}
				config.AddHostKey(host)
				server, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					return
				}
				requestsDone := make(chan struct{})
				go func() { ssh.DiscardRequests(requests); close(requestsDone) }()
				defer func() { server.Close(); <-requestsDone }()
				for channel := range channels {
					channel.Reject(ssh.Prohibited, "handshake fixture")
				}
			}()
			trustedHost, clientIdentity := host.PublicKey(), identity
			if name == "wrong-host-key" {
				trustedHost = other.PublicKey()
			}
			if name == "wrong-identity" {
				clientIdentity = other
			}
			client, err = connectInternal(context.Background(), listener.Addr().String(), &ssh.ClientConfig{
				User: "fixture", Auth: []ssh.AuthMethod{ssh.PublicKeys(clientIdentity)}, HostKeyCallback: ssh.FixedHostKey(trustedHost), Timeout: time.Minute,
			}, nil)
			if name == "authenticated" && (err != nil || client == nil) {
				t.Fatalf("authenticated fixture handshake failed: %v", err)
			}
			if name != "authenticated" && err == nil {
				t.Fatal("SSH accepted the wrong host key or user identity")
			}
		})
	}
}
