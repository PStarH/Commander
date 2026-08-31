export function addedContentFromUnifiedDiff(patch: string): string {
  const added: string[] = [];
  let inHunk = false;

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (inHunk && line.startsWith('+')) added.push(line.slice(1));
  }

  return added.join('\n');
}
