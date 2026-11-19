//go:build android

package eddytunnel

import (
	"net"
	"os"
	"time"

	"tailscale.com/net/netmon"

	_ "tailscale.com/feature/androidbin"
)

func init() {
	// androidbin's automatic registration deliberately excludes Android cgo
	// apps, whose normal client supplies Java interfaces. This app-scoped
	// client uses the same no-packet outbound-route discovery instead.
	netmon.RegisterInterfaceGetter(androidInterfaces)
	// Android 14+ distributes system trust anchors through Conscrypt APEX.
	// Keep certificate validation enabled and trust system anchors only.
	_ = os.Setenv("SSL_CERT_DIR", "/apex/com.android.conscrypt/cacerts:/system/etc/security/cacerts")
}

func androidInterfaces() ([]netmon.Interface, error) {
	var addresses []net.Addr
	for _, target := range []struct{ network, address string }{
		{"udp4", "8.8.8.8:53"}, {"udp6", "[2001:4860:4860::8888]:53"},
	} {
		// UDP connect asks the kernel for a route but sends no packets.
		connection, err := (&net.Dialer{Timeout: time.Second}).Dial(target.network, target.address)
		if err != nil {
			continue
		}
		address, ok := connection.LocalAddr().(*net.UDPAddr)
		_ = connection.Close()
		if !ok || address.IP.IsLoopback() || address.IP.IsUnspecified() {
			continue
		}
		bits := 128
		if address.IP.To4() != nil {
			bits = 32
		}
		addresses = append(addresses, &net.IPNet{IP: address.IP, Mask: net.CIDRMask(bits, bits)})
	}
	if len(addresses) == 0 {
		return nil, nil
	}
	return []netmon.Interface{{
		Interface: &net.Interface{Name: "android", Index: 1, MTU: 1500, Flags: net.FlagUp | net.FlagRunning},
		AltAddrs:  addresses,
	}}, nil
}
