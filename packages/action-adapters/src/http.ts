import { adapterErrorFromHttpStatus } from '@commander/effect-broker';

export type FetchFn = typeof fetch;

export async function adapterFetch(
  fetchImpl: FetchFn,
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetchImpl(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    throw adapterErrorFromHttpStatus(
      response.status,
      `HTTP redirect not followed (${response.status})`,
    );
  }
  return response;
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

export async function assertOkResponse(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw adapterErrorFromHttpStatus(
    response.status,
    `${label} failed with HTTP ${response.status}: ${text.slice(0, 200)}`,
  );
}
