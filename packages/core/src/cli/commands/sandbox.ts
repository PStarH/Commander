import { getSandboxManager } from '../../sandbox';
import { $ } from '../util';

export async function cmdSandbox(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'status') {
    const mgr = getSandboxManager();
    const mechanisms = mgr.getAvailableMechanisms();
    const hasSb = mgr.hasSandbox();
    console.log(`\n  ${$.cyan}${$.bold}Sandbox Status${$.reset}\n`);
    console.log(
      `  ${$.dim}Available:${$.reset}  ${hasSb ? $.green : $.yellow}${hasSb ? 'yes' : 'no (UNSANDBOXED)'}${$.reset}`,
    );
    if (mechanisms.length > 0) {
      console.log(`  ${$.dim}Mechanisms:${$.reset} ${$.cyan}${mechanisms.join(', ')}${$.reset}`);
    }
    console.log(
      `  ${$.dim}Profiles:${$.reset}   read-only, workspace-write, full-access, hardened`,
    );
    console.log();
  } else {
    console.log(`\n  ${$.yellow}Unknown sandbox subcommand:${$.reset} ${sub}`);
    console.log(`  ${$.dim}Usage:${$.reset} commander sandbox status\n`);
  }
}
