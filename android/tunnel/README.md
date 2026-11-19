# Eddy app-scoped private transport

This Go module embeds the official Tailscale `tsnet` implementation inside the
phone APK. It creates no Android VPN interface and needs no separate Tailscale
app. Each installation enrolls its own persistent node through an HTTPS login
URL. No shared auth key, OAuth secret or family credentials are compiled in.

The mobile app owns one `eddytunnel.Client`. It calls `start(privateDirectory,
tabletIPv4)` on a worker, polls `status()` and `authURL()`, then uses `proxyURL()`
and `proxyToken()` for its HTTP transport. Status is `starting`, `needs-login`,
`running`, `stopped` or `error`. A Tailscale machine awaiting approval reports
`needs-login`; approval may need to be completed in the owner's console.

The private identity directory must be under Android `noBackupFilesDir`, with
backup disabled. `stop()` closes the local listener, ongoing HTTP streams and
the Tailscale node while retaining its identity for the next launch. It can
wait for node initialization, so it must also run on a worker. Call
`networkChanged()` on a worker after Android default-network changes and resume.
The app keeps the node alive during its file picker and active transfers.

The only local listener binds `127.0.0.1` on a random port. Every request requires
`X-Eddy-Tunnel-Key`, a fresh 256-bit capability generated for that run. The
listener checks its exact Host and any Origin before rewriting them for the
tablet's CSRF policy. It strips the capability and untrusted forwarding metadata
before forwarding. Requests can reach only the configured IPv4 in `100.64.0.0/10`
on TCP 8787 using the userspace TCP dialer installed by `tsnet`; there is no
public-network fallback, SOCKS service, generic proxy, exit node, public listener
or Internet publication. `Server.Dial` itself is deliberately not used: that
method can choose the operating system dialer when a peer disappears. This
transport invokes its installed netstack TCP function directly instead.
Files and media stream without buffering complete bodies; HEAD, Range and
encoded queries remain intact. Tablet authentication remains an additional gate.

For Android cgo, the official standalone `androidbin` interface fallback is not
registered automatically. This module registers an equivalent restricted
interface view based on the source addresses selected by local UDP connect;
these probes send no packets. DNS uses Android bionic through Go cgo. TLS
verification stays enabled using the Android system and Conscrypt APEX CA stores.

## Rebuild

Run `./build.ps1` from PowerShell, optionally supplying `-ToolchainRoot`,
`-AndroidSdk`, `-AndroidNdk` and `-Jdk`. Prerequisites are official Go 1.27.4,
Android NDK r30, the Android SDK with its Java platform, and JDK 17 or later.
The script pins gomobile/gobind, downloads checksum-verified Go modules through
the normal Go module mechanism, runs tests, builds the arm64 Android API 24 AAR,
and produces the notices bundled by the mobile APK. It uses upstream's linker
version stamps to identify the embedded module as `1.104.7-eddy`, recording the
actual pinned Tailscale commit rather than gomobile's absent main-module VCS
metadata. Other ABIs can be built by
changing gomobile's target; the deployed S25 and S5e are arm64.

The initial SDK downloads used for this workspace are official archives:

- `https://go.dev/dl/go1.27.4.windows-amd64.zip`, SHA-256
  `178ab98950ac69ab25069307dc6ade79f3816e414cce95b4da166a115cde1e7e`.
- `https://dl.google.com/android/repository/android-ndk-r30-windows.zip`, SHA-1
  `9bf167a1985fa7d4a036186b78f702eab9179408`, as published in Google's SDK metadata.

Toolchains and generated native libraries are build artifacts. The Go sources,
`go.mod`, `go.sum`, script and distribution notices are required to reproduce and
redistribute the integrated APK.

## Validation

`go test ./...` checks capability/Host/Origin rejection, fixed upstream targets,
header rewriting, HEAD/Range, encoded queries and streaming uploads. Those tests
use an isolated HTTP transport and do not enroll a node or control appliances.
Android enrollment, Wi-Fi/cellular switching, background/resume, picker/upload
lifecycle and real tablet operations require the physical phone.
