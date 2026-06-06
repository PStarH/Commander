# Linux Syslog Boot Sequence Report

## 1. System Identification

| Item | Value |
|------|-------|
| **Hostname** | `server01` |
| **Kernel Version** | `5.4.0-74-generic` (Ubuntu, compiled with gcc 9.3.0) |
| **CPU Model** | Not recorded in syslog (not available from this log source) |
| **Total Available RAM** | ~3 GB (BIOS e820 usable range: 0x00100000–0xBFFFFFFF, approximately 3,072 MB) |

**Notes:**
- The kernel command line indicates boot via `/vmlinuz-5.4.0-74-generic` with the root device on an LVM volume (`/dev/mapper/ubuntu--vg-ubuntu--lv`).
- NX (Execute Disable) protection is active.
- GCC version used to build the kernel: `9.3.0-17ubuntu1~20.04`.

---

## 2. Storage

| Item | Value |
|------|-------|
| **Primary Hard Drive Model** | Not recorded in syslog (not available from this log source) |
| **Root Partition** | `/dev/mapper/ubuntu--vg-ubuntu--lv` (LVM logical volume) |
| **Filesystem Type** | **ext4** (confirmed by `systemd-fsck` output: clean filesystem check) |
| **Filesystem Size** | ~4,567,890 blocks (~4.4 GB); 234,567 of 1,234,567 files in use |

**Notes:**
- The system uses LVM2 (Logical Volume Manager), indicating Ubuntu VG name `ubuntu-vg` with LV `ubuntu-lv`.
- The filesystem check at boot reported the root volume as **clean** — no corruption or recovery needed.

---

## 3. Boot Timeline

| Event | Timestamp |
|-------|-----------|
| **First log entry** (pre-boot CRON) | `Jun  1 06:00:01` |
| **Kernel boot begins** (first kernel message) | `Jun  1 06:01:15` |
| **systemd init starts** (first systemd message) | `Jun  1 06:01:17` |
| **Multi-User System reached** | `Jun  1 06:01:29` |
| **Boot complete** (startup finished message) | `Jun  1 06:01:29` |

### Boot Duration Breakdown

| Phase | Duration |
|-------|----------|
| Kernel loading + hardware init | **3.456 seconds** |
| Userspace (systemd + services) | **12.789 seconds** |
| **Total boot time** | **16.245 seconds** |

**Notes:**
- The first CRON entry at `06:00:01` precedes the kernel boot at `06:01:15` by 1 minute 14 seconds — this likely represents the previous shutdown/pre-reboot cron activity or a timestamp offset.
- From the first kernel message (`06:01:15`) to `Reached target Multi-User System` (`06:01:29`) is **14 seconds** of wall-clock time, consistent with the reported 16.245s total.

---

## 4. Services — "Startup Succeeded" Messages

All services that reported successful startup during the first boot sequence:

| # | Service | Timestamp |
|---|---------|-----------|
| 1 | udev Kernel Device Manager | `Jun  1 06:01:17` |
| 2 | LVM2 metadata daemon | `Jun  1 06:01:18` |
| 3 | File System Check on Root Device | `Jun  1 06:01:20` |
| 4 | Load Kernel Modules | `Jun  1 06:01:21` |
| 5 | Network Service | `Jun  1 06:01:23` |
| 6 | OpenSSH server daemon | `Jun  1 06:01:24` |
| 7 | Apache HTTP Server | `Jun  1 06:01:25` |
| 8 | MySQL Community Server | `Jun  1 06:01:27` |
| 9 | Redis In-Memory Data Store | `Jun  1 06:01:28` |

**Total services started successfully: 9**

Additionally, systemd reached `target Multi-User System` at `06:01:29`.

---

## 5. Errors, Failures, and Warnings

### Warnings

| Severity | Source | Message | Timestamp |
|----------|--------|---------|-----------|
| **Warning** | Apache (`apache2[2678]`) | `AH00558: apache2: Could not reliably determine the server's fully qualified domain name, using 127.0.0.1. Set the 'ServerName' directive globally to suppress this message` | `Jun  1 06:01:25` |

**Analysis:** This is a common Apache warning indicating that `ServerName` is not set in the global Apache configuration. The server defaults to `127.0.0.1`. This does not prevent Apache from starting but should be resolved by adding `ServerName server01` (or the FQDN) to `/etc/apache2/apache2.conf`.

### Security Events (Post-Boot)

| Severity | Source | Details |
|----------|--------|---------|
| **Alert** | `sshd[5428]` | **Brute-force SSH attack** from `203.0.113.50` — 5 failed password attempts for users `admin`, `root`, and `test` between `08:02:15`–`08:02:17`. Connection closed after preauth. |

**Analysis:** This is a notable security concern. The IP `203.0.113.50` attempted to log in with common usernames. Recommended actions:
- Install and configure `fail2ban` to block repeated failed login attempts.
- Consider disabling password authentication in sshd (`PasswordAuthentication no`), since the server already uses publickey auth for the `deploy` user.
- The attempted usernames (`admin`, `root`, `test`) are typical of automated bot scans.

### Failures

**None detected.** All 9 services started successfully with no error-level log entries during the boot sequence.

---

## 6. Network

### Network Interface Card

| Item | Value |
|------|-------|
| **Detected NIC** | `eth0` |
| **IP Address** | `10.0.1.50/24` (DHCP-assigned) |
| **Gateway** | `10.0.1.1` |

### Named/Listening Interfaces (BIND-style)

Services listening on named interfaces:

| Service | Listening Address | Protocol |
|---------|-------------------|----------|
| sshd | `0.0.0.0:22` | IPv4 (all interfaces) |
| sshd | `:::22` | IPv6 (all interfaces) |
| apache2 | `127.0.0.1:80` (implied by FQDN warning) | IPv4 (localhost) |

**Total named/listening IP interfaces: 4**

- `0.0.0.0` (IPv4 wildcard — sshd)
- `::` (IPv6 wildcard — sshd)
- `127.0.0.1` (localhost — Apache default)
- `10.0.1.50` (physical interface — eth0, DHCP-assigned)

**Notes:**
- Only one physical network interface (`eth0`) was detected.
- The system uses DHCP for address assignment rather than static configuration.
- SSH accepts connections on both IPv4 and IPv6 on port 22.

---

## Summary

The first boot recorded in the syslog shows a healthy Ubuntu 20.04 server (`server01`) running kernel `5.4.0-74-generic` with ~3 GB RAM. The system boots in approximately **16.2 seconds** (3.5s kernel + 12.8s userspace) with **9 services** all starting successfully. The only warning is a non-critical Apache `ServerName` misconfiguration. A post-boot SSH brute-force attack from `203.0.113.50` is the most notable security event. The system uses LVM on ext4 with a single `eth0` network interface assigned via DHCP.
