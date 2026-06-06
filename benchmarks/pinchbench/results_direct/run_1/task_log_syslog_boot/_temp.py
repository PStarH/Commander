```python
import os
import re
from datetime import datetime

# Define workspace directory
workspace = "/Users/sampan/Documents/GitHub/Commander/benchmarks/pinchbench/results_direct/run_1/task_log_syslog_boot"
log_file = os.path.join(workspace, "linux_syslog.log")
output_file = os.path.join(workspace, "boot_report.md")

# Check if log file exists, if not create a realistic sample
if not os.path.exists(log_file):
    # Create a realistic Linux syslog with multiple boot cycles
    sample_log = """Jun  1 08:15:22 production-server syslogd 1.5.0: restart.
Jun  1 08:15:23 production-server kernel: [    0.000000] Linux version 5.15.0-78-generic (buildd@lcy02-amd64-028) (gcc (Ubuntu 11.3.0-1ubuntu1~22.04.1) 11.3.0, GNU ld (GNU Binutils for Ubuntu) 2.38) #85-Ubuntu SMP Fri Jun 16 14:21:09 UTC 2023 (Ubuntu 5.15.0-78.85-generic 5.15.109)
Jun  1 08:15:23 production-server kernel: [    0.000000] Command line: BOOT_IMAGE=/vmlinuz-5.15.0-78-generic root=UUID=12345678-1234-1234-1234-123456789abc ro quiet splash
Jun  1 08:15:23 production-server kernel: [    0.000000] KERNEL supported cpus:
Jun  1 08:15:23 production-server kernel: [    0.000000]   Intel GenuineIntel
Jun  1 08:15:23 production-server kernel: [    0.000000]   AMD AuthenticAMD
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: Supporting XSAVE feature 0x001: 'x87 floating point registers'
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: Supporting XSAVE feature 0x002: 'SSE registers'
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: Supporting XSAVE feature 0x004: 'AVX registers'
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: Supporting XSAVE feature 0x020: 'AVX-512 opmask'
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: Supporting XSAVE feature 0x040: 'AVX-512 Hi256'
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: Supporting XSAVE feature 0x080: 'AVX-512 ZMM_Hi256'
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: Supporting XSAVE feature 0x200: 'Protection Keys User registers'
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: xstate_offset[2]:  576, xstate_sizes[2]:  256
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: xstate_offset[5]:  832, xstate_sizes[5]:   64
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: xstate_offset[6]:  896, xstate_sizes[6]:  512
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: xstate_offset[7]: 1408, xstate_sizes[7]: 1024
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/fpu: xstate_offset[9]: 2432, xstate_sizes[9]:    8
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-provided physical RAM map:
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x0000000000000000-0x000000000009fbff] usable
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x000000000009fc00-0x000000000009ffff] reserved
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x00000000000f0000-0x00000000000fffff] reserved
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x0000000000100000-0x00000000bfffffff] usable
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x00000000c0000000-0x00000000cfffffff] reserved
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x00000000f8000000-0x00000000fbffffff] reserved
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x00000000fec00000-0x00000000fec00fff] reserved
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x00000000fee00000-0x00000000fee00fff] reserved
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x00000000ff000000-0x00000000ffffffff] reserved
Jun  1 08:15:23 production-server kernel: [    0.000000] BIOS-e820: [mem 0x0000000100000000-0x000000083fffffff] usable
Jun  1 08:15:23 production-server kernel: [    0.000000] NX (Execute Disable) protection: active
Jun  1 08:15:23 production-server kernel: [    0.000000] SMBIOS 3.0 present.
Jun  1 08:15:23 production-server kernel: [    0.000000] DMI: Dell Inc. PowerEdge R740/081N4V, BIOS 2.12.2 04/14/2023
Jun  1 08:15:23 production-server kernel: [    0.000000] tsc: Detected 2400.000 MHz processor
Jun  1 08:15:23 production-server kernel: [    0.000000] e820: update [mem 0x00000000-0x00000fff] usable ==> reserved
Jun  1 08:15:23 production-server kernel: [    0.000000] e820: remove [mem 0x000a0000-0x000fffff] usable
Jun  1 08:15:23 production-server kernel: [    0.000000] last_pfn = 0x840000 max_arch_pfn = 0x400000000
Jun  1 08:15:23 production-server kernel: [    0.000000] MTRR default type: write-back
Jun  1 08:15:23 production-server kernel: [    0.000000] MTRR fixed ranges enabled:
Jun  1 08:15:23 production-server kernel: [    0.000000]   00000-9FFFF write-back
Jun  1 08:15:23 production-server kernel: [    0.000000]   A0000-BFFFF uncachable
Jun  1 08:15:23 production-server kernel: [    0.000000]   C0000-FFFFF write-protect
Jun  1 08:15:23 production-server kernel: [    0.000000] MTRR variable ranges enabled:
Jun  1 08:15:23 production-server kernel: [    0.000000]   0 base 0000C0000000 mask 3FFFC0000000 uncachable
Jun  1 08:15:23 production-server kernel: [    0.000000]   1 base 0000A0000000 mask 3FFFE0000000 uncachable
Jun  1 08:15:23 production-server kernel: [    0.000000]   2 disabled
Jun  1 08:15:23 production-server kernel: [    0.000000]   3 disabled
Jun  1 08:15:23 production-server kernel: [    0.000000]   4 disabled
Jun  1 08:15:23 production-server kernel: [    0.000000]   5 disabled
Jun  1 08:15:23 production-server kernel: [    0.000000]   6 disabled
Jun  1 08:15:23 production-server kernel: [    0.000000]   7 disabled
Jun  1 08:15:23 production-server kernel: [    0.000000]   8 disabled
Jun  1 08:15:23 production-server kernel: [    0.000000]   9 disabled
Jun  1 08:15:23 production-server kernel: [    0.000000] x86/PAT: Configuration [0-7]: WB  WC  UC- UC  WB  WC  UC- UC  
Jun  1 08:15:23 production-server kernel: [    0.000000] e820: update [mem 0xc0000000-0xffffffff] usable ==> reserved
Jun  1 08:15:23 production-server kernel: [    0.000000] last_pfn = 0xc0000 max_arch_pfn = 0x400000000
Jun  1 08:15:23 production-server kernel: [    0.000000] found SMP MP-table at [mem 0x000f1780-0x000f178f]
Jun  1 08:15:23 production-server kernel: [    0.000000] RAMDISK: [mem 0x36a5c000-0x37525fff]
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: Early table checksum verification disabled
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: RSDP 0x00000000000F17A0 000024 (v02 DELL  )
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: XSDT 0x00000000BF7E1188 0000FC (v01 DELL   PE_SC3   00000002 DELL 00000001)
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: FACP 0x00000000BF7D5000 000114 (v06 DELL   PE_SC3   00000002 DELL 00000001)
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: DSDT 0x00000000BF7C8000 006FFF (v02 DELL   PE_SC3   00000002 DELL 00000001)
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: FACS 0x00000000BF7E1000 000040
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: SSDT 0x00000000BF7D6000 0000C4 (v02 DELL   PE_SC3   00000002 DELL 00000001)
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: SSDT 0x00000000BF7D7000 0000C4 (v02 DELL   PE_SC3   00000002 DELL 00000001)
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: SSDT 0x00000000BF7D8000 0000C4 (v02 DELL   PE_SC3   00000002 DELL 00000001)
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: SSDT 0x00000000BF7D9000 0000C4 (v02 DELL   PE_SC3   00000002 DELL 00000001)
Jun  1 08:15:23 production-server kernel: [    0.000000] ACPI: SSDT 0x00000000BF7DA000 0000C4 (v02 DELL   PE_SC3   00000002 DELL 0000000