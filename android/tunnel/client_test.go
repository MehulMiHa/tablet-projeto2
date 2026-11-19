package eddytunnel

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/tsnet"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func appProxy(t *testing.T, transport http.RoundTripper, ready func() bool) *httptest.Server {
	t.Helper()
	s := httptest.NewUnstartedServer(nil)
	s.Config.Handler = proxyHandler("http://"+s.Listener.Addr().String(), "100.99.231.9:8787", strings.Repeat("a", 64), transport, ready)
	s.Start()
	t.Cleanup(s.Close)
	return s
}

func TestCapabilityAndOriginGate(t *testing.T) {
	var called atomic.Int32
	s := appProxy(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		called.Add(1)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("ok"))}, nil
	}), func() bool { return true })
	for _, test := range []struct {
		name, token, origin, host, method string
		code                              int
	}{
		{"missing capability", "", "", "", "GET", 403},
		{"wrong capability", strings.Repeat("b", 64), "", "", "GET", 403},
		{"public origin", strings.Repeat("a", 64), "https://attacker.example", "", "POST", 403},
		{"null origin", strings.Repeat("a", 64), "null", "", "POST", 403},
		{"different host", strings.Repeat("a", 64), "", "attacker.example", "GET", 400},
		{"CONNECT rejected", strings.Repeat("a", 64), "", "", "CONNECT", 400},
		{"valid local request", strings.Repeat("a", 64), s.URL, "", "GET", 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			req, _ := http.NewRequest(test.method, s.URL+"/api/family?parent=abc", nil)
			req.Header.Set(capabilityHeader, test.token)
			if test.origin != "" {
				req.Header.Set("Origin", test.origin)
			}
			if test.host != "" {
				req.Host = test.host
			}
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.code {
				t.Fatalf("status=%d want %d", response.StatusCode, test.code)
			}
		})
	}
	if called.Load() != 1 {
		t.Fatalf("forbidden requests reached transport: %d", called.Load())
	}
}

func TestFixedTargetRangeAndRewrite(t *testing.T) {
	var requestCount int
	var localOrigin string
	s := appProxy(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requestCount++
		if r.URL.Scheme != "http" || r.URL.Host != "100.99.231.9:8787" || r.Host != "100.99.231.9:8787" {
			t.Errorf("unexpected target %s host=%s", r.URL, r.Host)
		}
		if r.Header.Get(capabilityHeader) != "" {
			t.Error("local capability leaked upstream")
		}
		if r.Header.Get("Origin") != "http://100.99.231.9:8787" {
			t.Error("local Origin was not rewritten")
		}
		if r.Header.Get("Referer") != "http://100.99.231.9:8787/" {
			t.Error("local Referer was not rewritten")
		}
		if r.Header.Get("Range") != "bytes=100-199" || r.Header.Get("Authorization") != "Basic test-only" {
			t.Error("request credentials/range were not preserved")
		}
		if r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Forwarded") != "" {
			t.Error("untrusted forwarding metadata retained")
		}
		if r.URL.RawQuery != "parent=abc%2Fdef" {
			t.Error("query encoding changed")
		}
		body := []byte(strings.Repeat("z", 100))
		return &http.Response{StatusCode: 206, Header: http.Header{"Content-Range": {"bytes 100-199/1024"}, "Content-Length": {"100"}}, ContentLength: 100, Body: io.NopCloser(bytes.NewReader(body))}, nil
	}), func() bool { return true })
	localOrigin = s.URL
	for _, method := range []string{"GET", "HEAD"} {
		req, _ := http.NewRequest(method, s.URL+"/api/family/files/id/preview?parent=abc%2Fdef", nil)
		req.Header.Set(capabilityHeader, strings.Repeat("a", 64))
		req.Header.Set("Origin", localOrigin)
		req.Header.Set("Referer", localOrigin+"/")
		req.Header.Set("Range", "bytes=100-199")
		req.Header.Set("Authorization", "Basic test-only")
		req.Header.Set("X-Forwarded-For", "attacker")
		req.Header.Set("Forwarded", "host=attacker")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 206 || response.Header.Get("Content-Range") != "bytes 100-199/1024" {
			t.Fatal("range response was changed")
		}
		if method == "HEAD" && len(body) != 0 {
			t.Error("HEAD returned a body")
		}
		if method == "GET" && len(body) != 100 {
			t.Error("range body length changed")
		}
	}
	if requestCount != 2 {
		t.Fatal("unexpected upstream request count")
	}
}

func TestUploadsStreamBeforeBodyCompletes(t *testing.T) {
	firstChunk := make(chan struct{})
	s := appProxy(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		first := make([]byte, 5)
		if _, err := io.ReadFull(r.Body, first); err != nil {
			t.Error(err)
		}
		close(firstChunk)
		rest, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		if string(first)+string(rest) != "firstsecond" {
			t.Error("stream body changed")
		}
		return &http.Response{StatusCode: 201, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("saved"))}, nil
	}), func() bool { return true })
	reader, writer := io.Pipe()
	req, _ := http.NewRequest("POST", s.URL+"/api/family/files", reader)
	req.Header.Set(capabilityHeader, strings.Repeat("a", 64))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req = req.WithContext(ctx)
	go func() {
		_, _ = writer.Write([]byte("first"))
		select {
		case <-firstChunk:
			_, _ = writer.Write([]byte("second"))
		case <-ctx.Done():
		}
		_ = writer.Close()
	}()
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 201 {
		t.Fatalf("status=%d", response.StatusCode)
	}
}

func TestAbsoluteFormAndStartingFailClosed(t *testing.T) {
	transport := roundTripFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected network call"); return nil, nil })
	handler := proxyHandler("http://127.0.0.1:4567", "100.99.231.9:8787", strings.Repeat("a", 64), transport, func() bool { return false })
	request := httptest.NewRequest("GET", "http://public.example/", nil)
	request.Host = "127.0.0.1:4567"
	request.Header.Set(capabilityHeader, strings.Repeat("a", 64))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 400 {
		t.Fatalf("absolute form status=%d", response.Code)
	}
	request = httptest.NewRequest("GET", "/api/session", nil)
	request.Host = "127.0.0.1:4567"
	request.Header.Set(capabilityHeader, strings.Repeat("a", 64))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 503 {
		t.Fatalf("starting status=%d", response.Code)
	}
}

func TestInputAndLoginURLValidation(t *testing.T) {
	c := NewClient()
	defer c.Stop()
	for _, target := range []string{"192.168.1.2", "127.0.0.1", "100.63.255.255", "100.128.0.0", "100.99.231.9:3000", "[::1]", "attacker.example"} {
		if err := c.Start(t.TempDir(), target); err == nil {
			t.Fatalf("accepted invalid tablet %s", target)
		}
	}
	if err := c.Start("relative/path", "100.99.231.9"); err == nil {
		t.Fatal("accepted relative identity directory")
	}
	for _, raw := range []string{"http://login.tailscale.com/a/test", "https://login.tailscale.com.evil/a/test", "https://login.tailscale.com@evil/a/test", "https://login.tailscale.com:443/a/test"} {
		if safeAuthURL(raw) != "" {
			t.Errorf("accepted unsafe auth URL %s", raw)
		}
	}
	if safeAuthURL("https://login.tailscale.com/a/test") == "" {
		t.Fatal("valid official auth URL rejected")
	}
	c.Stop()
	if c.Status() != "stopped" || c.ProxyURL() != "" || c.ProxyToken() != "" || c.AuthURL() != "" {
		t.Fatal("stopped state exposes an old session")
	}
}

func TestStopClosesAnUninitializedSession(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &tunnelRun{ctx: ctx, cancel: cancel, listener: listener, server: &tsnet.Server{},
		http: &http.Server{}, transport: &http.Transport{}, status: "starting", origin: "http://" + listener.Addr().String(), key: "old-secret"}
	c := NewClient()
	c.run = r
	c.Stop()
	if c.Status() != "stopped" || c.ProxyURL() != "" || c.ProxyToken() != "" {
		t.Fatal("stopped session retained endpoint/capability")
	}
	if ctx.Err() == nil {
		t.Fatal("stop did not cancel ongoing requests")
	}
	connection, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err == nil {
		connection.Close()
		t.Fatal("stop left loopback listener open")
	}
	c.Stop()
}
