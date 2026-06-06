# Linux Syslog Boot Sequence Report

## 1. System Identification

- **Kernel Version:** 2.6.5-1.358
- **CPU Model:** Intel Pentium III (Coppermine)
- **Processor Speed:** 731.214 MHz
- **Total RAM:** 126MB LOWMEM available (125312k), 0MB HIGHMEM

## 2. Storage

- **Primary Hard Drive:** IBM-DTLA-307015
- **Total Capacity:** 15020 MB (~15 GB)
- **Root Filesystem:** EXT3 (on hda2)

## 3. Boot Timeline

- **First Log Entry:** Jun  9 06:06:20
- **Boot Duration:** Approximately 2 minutes (from syslogd restart to last service startup)

## 4. Services

The following services reported "startup succeeded" during the first boot sequence:

1. syslog
2. klogd
3. irqbalance
4. portmap
5. nfslock
6. rpcidmapd
7. bluetooth
8. sshd
9. httpd
10. named
11. mysqld
12. sendmail
13. cups
14. ntpd
15. xinetd
16. crond
17. spamassassin
18. privoxy
19. gpm
20. smartd
21. anacron
22. autofs
23. apmd
24. snmpd
25. messagebus
26. xfs
27. atd
28. readahead
29. netfs
30. canna

**Total Services:** 30

## 5. Errors and Warnings

- **mdmpd failure:** The mdmpd service failed to start during boot
- **SELinux:** Started in permissive mode, then disabled at runtime
- **ACPI:** Disabled because BIOS from year 2000 is too old

## 6. Network

- **Network Interface Card:** 3Com PCI 3c905C Tornado
- **IP Addresses Configured:** 24 interfaces (lo, eth0, and eth0:1 through eth0:22)
