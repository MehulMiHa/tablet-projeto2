// Package eddytunnel embeds a private, app-scoped Tailscale transport.
package eddytunnel

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

const capabilityHeader = "X-Eddy-Tunnel-Key"

var allowedAddresses = netip.MustParsePrefix("100.64.0.0/10")

// Client has no public TCP listener and never configures an Android-wide VPN.
// Its sole local listener requires a fresh random capability on every request.
type Client struct {
	op         sync.Mutex
	mu         sync.Mutex
	run        *tunnelRun
	lastStatus string
}

type tunnelRun struct {
	ctx         context.Context
	cancel      context.CancelFunc
	server      *tsnet.Server
	initMu      sync.Mutex
	initialized bool
	startCalled bool
	http        *http.Server
	listener    net.Listener
	transport   *http.Transport
	target      string
	origin      string
	key         string
	status      string
	authURL     string
}

// NewClient creates a stopped client. The caller stores its identity directory
// inside Android's private noBackupFilesDir, never shared storage.
func NewClient() *Client { return &Client{lastStatus: "stopped"} }

// Start returns after creating the protected loopback bridge. Enrollment and
// connection proceed asynchronously; Status and AuthURL report their progress.
// Only an exact IPv4 tailnet address and port 8787 can be reached.
func (c *Client) Start(stateDir, targetIPv4 string) error {
	c.op.Lock()
	defer c.op.Unlock()
	ip, err := netip.ParseAddr(targetIPv4)
	if err != nil || !ip.Is4() || !allowedAddresses.Contains(ip) {
		return errors.New("invalid private tablet address")
	}
	if !filepath.IsAbs(stateDir) {
		return errors.New("identity directory must be absolute and private")
	}
	c.mu.Lock()
	if c.run != nil {
		same := c.run.target == net.JoinHostPort(ip.String(), "8787")
		c.mu.Unlock()
		if same {
			return nil
		}
		return errors.New("stop the existing tunnel before changing its tablet")
	}
	c.mu.Unlock()
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return errors.New("could not prepare private identity directory")
	}
	if err := os.Chmod(stateDir, 0700); err != nil {
		return errors.New("could not protect private identity directory")
	}
	// Android applications do not inherit HOME, a writable /tmp, or an XDG
	// cache directory. Tailscale's logpolicy requires an existing private
	// storage directory even when the app does not expose its diagnostic log.
	for variable, name := range map[string]string{"TS_LOGS_DIR": "logs", "XDG_CACHE_HOME": "cache", "TMPDIR": "tmp"} {
		directory := filepath.Join(stateDir, name)
		if err := os.MkdirAll(directory, 0700); err != nil {
			return errors.New("could not prepare private runtime directory")
		}
		if err := os.Chmod(directory, 0700); err != nil {
			return errors.New("could not protect private runtime directory")
		}
		if err := os.Setenv(variable, directory); err != nil {
			return errors.New("could not configure private runtime directory")
		}
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return errors.New("could not create tunnel capability")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return errors.New("could not open private app bridge")
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &tunnelRun{
		ctx: ctx, cancel: cancel, listener: listener,
		target: net.JoinHostPort(ip.String(), "8787"),
		origin: "http://" + listener.Addr().String(),
		key:    hex.EncodeToString(secret), status: "starting",
	}
	r.server = &tsnet.Server{
		Dir: stateDir, Hostname: "eddy-mobile",
		Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {},
	}
	r.transport = &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != r.target {
				return nil, errors.New("destination is not the tablet")
			}
			// Server.Dial uses UserDial, which may choose the OS dialer when
			// a target is absent from its peer map. Invoke the very same
			// userspace TCP dialer installed by tsnet directly: losing a peer
			// must never send tablet HTTP through Wi-Fi or cellular in clear.
			dial := r.server.Sys().Dialer.Get().NetstackDialTCP
			if dial == nil {
				return nil, errors.New("private TCP transport unavailable")
			}
			return dial(ctx, netip.AddrPortFrom(ip, 8787))
		},
		MaxIdleConns: 8, MaxIdleConnsPerHost: 8, IdleConnTimeout: 30 * time.Second,
		ResponseHeaderTimeout: 45 * time.Second, DisableCompression: true,
	}
	r.http = &http.Server{
		Handler:           proxyHandler(r.origin, r.target, r.key, r.transport, func() bool { return c.isRunning(r) }),
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second,
		MaxHeaderBytes: 32 << 10, ErrorLog: log.New(io.Discard, "", 0),
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	c.mu.Lock()
	c.run = r
	c.lastStatus = "starting"
	c.mu.Unlock()
	go func() { _ = r.http.Serve(listener) }()
	go c.connect(r)
	return nil
}

func (c *Client) connect(r *tunnelRun) {
	err := startServer(r)
	if err != nil {
		c.update(r, "error", "")
		return
	}
	local, err := r.server.LocalClient()
	if err != nil {
		c.update(r, "error", "")
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	loginRequested := false
	for {
		ctx, cancel := context.WithTimeout(r.ctx, 5*time.Second)
		status, err := local.Status(ctx)
		cancel()
		if r.ctx.Err() != nil {
			return
		}
		if err == nil {
			switch status.BackendState {
			case "Running":
				c.update(r, "running", "")
				loginRequested = false
			case "NeedsLogin", "NeedsMachineAuth":
				c.update(r, "needs-login", safeAuthURL(status.AuthURL))
				if !loginRequested && status.BackendState == "NeedsLogin" {
					ctx, cancel := context.WithTimeout(r.ctx, 5*time.Second)
					err = local.StartLoginInteractive(ctx)
					cancel()
					loginRequested = err == nil
				}
			default:
				c.update(r, "starting", "")
			}
		}
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func startServer(r *tunnelRun) (err error) {
	r.initMu.Lock()
	defer r.initMu.Unlock()
	defer func() {
		if recover() != nil {
			err = errors.New("private transport initialization failed")
		}
	}()
	if r.ctx.Err() != nil {
		return r.ctx.Err()
	}
	r.startCalled = true
	err = r.server.Start()
	r.initialized = err == nil
	return err
}

func safeAuthURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "login.tailscale.com" || u.User != nil {
		return ""
	}
	return u.String()
}

func (c *Client) update(r *tunnelRun, status, authURL string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.run == r && r.ctx.Err() == nil {
		r.status, r.authURL = status, authURL
	}
}

func (c *Client) isRunning(r *tunnelRun) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.run == r && r.status == "running" && r.ctx.Err() == nil
}

// Stop cancels active requests and closes the app's node and loopback socket.
// Identity persists for the next launch; this does not log the user out.
func (c *Client) Stop() {
	c.op.Lock()
	defer c.op.Unlock()
	c.mu.Lock()
	r := c.run
	c.run = nil
	c.lastStatus = "stopped"
	c.mu.Unlock()
	if r == nil {
		return
	}
	r.cancel()
	_ = r.http.Close()
	_ = r.listener.Close()
	r.transport.CloseIdleConnections()
	r.initMu.Lock()
	if r.startCalled {
		_ = r.server.Close()
	}
	r.initMu.Unlock()
}

func (c *Client) Status() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.run != nil {
		return c.run.status
	}
	return c.lastStatus
}

func (c *Client) AuthURL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.run != nil {
		return c.run.authURL
	}
	return ""
}

func (c *Client) ProxyURL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.run != nil {
		return c.run.origin
	}
	return ""
}

func (c *Client) ProxyToken() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.run != nil {
		return c.run.key
	}
	return ""
}

// NetworkChanged refreshes Android's restricted interface view after a Wi-Fi
// or cellular transition. Call it from a worker, never the Android UI thread.
func (c *Client) NetworkChanged() {
	c.mu.Lock()
	r := c.run
	c.mu.Unlock()
	if r == nil {
		return
	}
	r.initMu.Lock()
	defer r.initMu.Unlock()
	if !r.initialized || r.ctx.Err() != nil {
		return
	}
	r.server.Sys().NetMon.Get().Poll()
	if local, err := r.server.LocalClient(); err == nil {
		ctx, cancel := context.WithTimeout(r.ctx, 3*time.Second)
		_ = local.DebugAction(ctx, "rebind")
		cancel()
	}
}

func proxyHandler(origin, target, key string, transport http.RoundTripper, ready func() bool) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL.Scheme, p.Out.URL.Host = "http", target
			p.Out.Host = target
			p.Out.Header.Del(capabilityHeader)
			p.Out.Header.Del("Forwarded")
			p.Out.Header.Del("X-Forwarded-For")
			p.Out.Header.Del("X-Forwarded-Host")
			p.Out.Header.Del("X-Forwarded-Proto")
			if p.In.Header.Get("Origin") != "" {
				p.Out.Header.Set("Origin", "http://"+target)
			}
			if referer := p.In.Header.Get("Referer"); referer != "" {
				if parsed, err := url.Parse(referer); err == nil && parsed.Scheme+"://"+parsed.Host == origin {
					parsed.Host = target
					p.Out.Header.Set("Referer", parsed.String())
				} else {
					p.Out.Header.Del("Referer")
				}
			}
		},
		Transport: transport, FlushInterval: -1,
		ErrorLog: log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "Private tablet connection unavailable", http.StatusBadGateway)
		},
	}
	localHost := strings.TrimPrefix(origin, "http://")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if subtle.ConstantTimeCompare([]byte(r.Header.Get(capabilityHeader)), []byte(key)) != 1 {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if r.Host != localHost || r.URL.IsAbs() || r.URL.Host != "" || !strings.HasPrefix(r.URL.Path, "/") || r.Method == http.MethodConnect {
			http.Error(w, "Invalid app request", http.StatusBadRequest)
			return
		}
		if receivedOrigin := r.Header.Get("Origin"); receivedOrigin != "" && receivedOrigin != origin {
			http.Error(w, "Invalid app origin", http.StatusForbidden)
			return
		}
		if !ready() {
			http.Error(w, "Private connection is starting", http.StatusServiceUnavailable)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}
