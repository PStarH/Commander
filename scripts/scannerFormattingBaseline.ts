import { format } from 'prettier';

export async function formattingBaseline(
  file: string,
  head: string | undefined,
  staged: string,
): Promise<string | undefined> {
  if (head === undefined || !/\.[cm]?[jt]sx?$/.test(file)) return head;
  // Fixed options prevent staged configuration from changing what is inherited.
  try {
    const formatted = await format(head, { filepath: file, singleQuote: true, printWidth: 100 });
    return formatted === staged ? formatted : head;
  } catch (error) {
    if (error instanceof SyntaxError) return head;
    throw error;
  }
}
