# 10. HTTPS hangs, but only inside containers (Hard)

## Situation

On a new cloud VM that sits behind a corporate VPN, `apt-get update` and `npm install` inside builds hang forever on some hosts but not others. `curl https://google.com` from the host works. The same `curl` inside a container connects, then stalls during the TLS handshake. Small HTTP requests work fine.

## Your task

Find the root cause and fix it for both the default bridge network and Compose-created networks.

## Hint

"Connects, then hangs on large packets" is a classic sign of MTU trouble. Compare the MTU of the host interface with `docker0`, and look at the `mtu` setting in `daemon.json` and the network driver options.

---

## Solution

### Root cause

The VM's primary interface has an MTU smaller than 1500 (VPN tunnels, PPPoE, VXLAN overlays, and some cloud networks commonly use 1400–1450). Docker's default `docker0` bridge uses MTU **1500**. When a container sends a full-size 1500-byte packet, the VPN path must fragment it. If the path has PMTUD blackholed — ICMP "fragmentation needed" packets are dropped by the corporate firewall — the large packet silently disappears.

This matches the symptoms exactly:

- TCP connect succeeds (small SYN/ACK packets fit).
- TLS handshake stalls: the ServerHello / certificate is large and spans multiple full-size packets.
- Small HTTP requests work; downloads and `apt`/`npm` hang.
- Only some hosts fail: those behind the VPN have the reduced MTU; those on a normal LAN are 1500 end to end.

### Diagnose

```bash
# host interface MTU
ip link show
ip route get 1.1.1.1

# docker0 MTU
ip link show docker0

# container MTU (should match host path MTU)
docker run --rm alpine ip link show eth0

# prove it is an MTU problem: force a small MTU and retry
docker run --rm --network host alpine \
  sh -c 'ip link set dev eth0 mtu 1400 2>/dev/null; curl -sS https://registry.npmjs.org/ >/dev/null && echo OK'

# find the real path MTU (from the host)
ping -M do -s 1472 -c 1 1.1.1.1     # 1472 + 28 = 1500
ping -M do -s 1372 -c 1 1.1.1.1     # 1372 + 28 = 1400
```

Decrease `-s` until it succeeds; add 28 for the ICMP/IP header. The largest working size is the path MTU.

### Fix 1: set Docker's MTU in `daemon.json`

Make the default bridge (and therefore all containers) use the path MTU. Restart Docker afterward.

```json
{
  "mtu": 1400
}
```

```bash
sudo systemctl restart docker
docker run --rm alpine ip link show eth0 | grep mtu   # should show 1400
```

Choose a value at or below the measured path MTU. 1400 is a safe common choice for VPN/tunneled hosts.

### Fix 2: set the MTU for Compose-created networks

Networks created by Compose do not always inherit `daemon.json` `mtu` in the way you expect (and the default bridge's setting is not applied to user-defined bridges on all versions). Set it explicitly on the network:

```yaml
networks:
  default:
    driver: bridge
    driver_opts:
      com.docker.network.driver.mtu: "1400"
```

Or, in the service, set the container interface MTU (less clean, requires `NET_ADMIN`):

```yaml
services:
  app:
    build: .
    sysctls:
      net.ipv4.tcp_mtu_probing: "1"
```

`tcp_mtu_probing=1` is a useful complement: it makes the kernel probe downward for a working MSS when PMTUD fails, which recovers even if the MTU is slightly wrong. It is not a substitute for setting the correct MTU.

### Fix 3: clamp MSS at the host (belt and braces)

If you cannot restart Docker or want protection for host-originated traffic too, clamp TCP MSS on the host:

```bash
# find the external interface
IFACE=$(ip route get 1.1.1.1 | awk '{print $5; exit}')

sudo iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --clamp-mss-to-pmtu
sudo iptables -t mangle -A OUTPUT -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --clamp-mss-to-pmtu
```

Make it persistent with `iptables-persistent` or a systemd unit. This tells endpoints to advertise a smaller MSS so they never send oversized packets, which also covers the PMTUD blackhole.

### Verify

```bash
# from inside a container on the default bridge
docker run --rm alpine sh -c 'ip link show eth0 | grep mtu; apk add --no-cache curl >/dev/null; curl -sSI https://registry.npmjs.org/ | head -1'

# from inside a Compose network
docker compose run --rm app sh -c 'ip link show eth0 | grep mtu; npm ping'

# large transfer no longer stalls
docker run --rm alpine sh -c 'apk add --no-cache curl >/dev/null; curl -sS -o /dev/null -w "%{size_download}\n" https://speed.cloudflare.com/__down?bytes=10000000'
```

### Why the fixes are needed at both levels

- `daemon.json` `mtu` covers the default `docker0` bridge and containers started without a custom network.
- Compose creates a **user-defined bridge** per project; its MTU is not guaranteed to follow the daemon default, so set `com.docker.network.driver.mtu` explicitly.
- MSS clamping is a host-level safety net for paths you do not control and for host traffic.

### Notes

- Determine the MTU empirically, not by copying 1400. If the VPN path is 1420, using 1400 works but leaves a little throughput on the table; using 1500 fails.
- Changing `daemon.json` requires recreating existing containers/networks to take effect; `docker compose down && docker compose up -d` after the restart.
- If only *builds* hang but running containers are fine, BuildKit builders may use their own network; `docker build --network=host` is a quick confirmation test but not a production fix.
- ICMP being blocked is the usual reason PMTUD fails; if you control the firewall, allowing ICMP type 3 code 4 is the cleanest fix. MSS clamping is the fallback when you do not.