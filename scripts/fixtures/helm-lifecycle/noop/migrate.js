const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  process.stderr.write('usage: migrate.js <tenant-cutover-migrate|tenant-cutover-prove>\n');
  process.exit(1);
}

if (command !== 'tenant-cutover-migrate' && command !== 'tenant-cutover-prove') {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(1);
}

process.stdout.write(`noop ${command}\n`);
process.exit(0);
