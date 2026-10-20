import { HUB_API_PORT, type Result } from '@fractonica/protocol';

export function hubUrl(): string {
  return process.env.FR_HUB || `http://127.0.0.1:${HUB_API_PORT}`;
}

function unreachable(message: string): Result<never> {
  return {
    ok: false,
    cursor: '',
    error: {
      code: 'HUB_UNREACHABLE',
      message,
      retryable: true,
      remediation: [{ cli: 'fr hub start' }],
    },
  };
}

export async function hubHealth(): Promise<{ ok: boolean; version: string; registry_hash: string; pid: number } | null> {
  try {
    const r = await fetch(`${hubUrl()}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? ((await r.json()) as { ok: boolean; version: string; registry_hash: string; pid: number }) : null;
  } catch {
    return null;
  }
}

export async function hubCall(op: string, input: Record<string, unknown>, timeoutMs: number): Promise<Result> {
  try {
    const r = await fetch(`${hubUrl()}/api/v1/op/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await r.json()) as Result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort|timeout/i.test(msg)) {
      return { ok: false, cursor: '', error: { code: 'TIMEOUT', message: `no answer from the hub within ${timeoutMs} ms`, retryable: true } };
    }
    return unreachable(`hub not reachable at ${hubUrl()} (${msg})`);
  }
}
