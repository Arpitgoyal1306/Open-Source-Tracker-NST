/**
 * The summary cache is a ~3.3MB blob. Reading it from Upstash on every render
 * is what exhausted the 10GB/month bandwidth allowance and got the production
 * database suspended -- 26,000 commands had moved 11GB, about 423KB per
 * command. The command COUNT was never the binding limit; the payload size was.
 *
 * These tests pin the two properties that fix that, because both are easy to
 * regress and neither is visible locally (on-disk dev KV makes a re-read look
 * free):
 *   1. repeated reads hit KV once, not once per caller
 *   2. writers that mutate the result in place never share the cached instance
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvStore = new Map<string, unknown>();
let getCalls = 0;

vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => {
    getCalls++;
    // Real kvGet JSON.parses the payload (Upstash) or the file (disk fallback),
    // so it hands back a fresh object every time. A Map returning the same
    // reference would hide exactly the aliasing bug these tests exist to catch.
    return kvStore.has(key) ? JSON.parse(JSON.stringify(kvStore.get(key))) : null;
  },
  kvSet: async (key: string, value: unknown) => {
    kvStore.set(key, value);
    return true;
  },
  kvDel: async (key: string) => {
    kvStore.delete(key);
    return true;
  },
}));

const { readSummaryCache, writeSummaryCache, forgetSummaryCacheMemory } = await import('./summary-cache');

type Summary = { profile: { login: string }; mergedPRs: number };
const summaries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ profile: { login: `u${i}` }, mergedPRs: i })) as unknown as never[];

describe('summary cache in-process memory', () => {
  beforeEach(() => {
    kvStore.clear();
    forgetSummaryCacheMemory();
    getCalls = 0;
  });

  it('serves repeated reads from memory instead of refetching the blob', async () => {
    await writeSummaryCache(summaries(3), 'all');
    forgetSummaryCacheMemory();

    getCalls = 0;
    for (let i = 0; i < 25; i++) await readSummaryCache('all');

    // 25 renders, one fetch. This is the bandwidth fix.
    expect(getCalls).toBe(1);
  });

  it('keeps periods independent', async () => {
    await writeSummaryCache(summaries(2), 'all');
    await writeSummaryCache(summaries(5), 'week');
    forgetSummaryCacheMemory();

    getCalls = 0;
    const all = await readSummaryCache('all');
    const week = await readSummaryCache('week');
    await readSummaryCache('all');
    await readSummaryCache('week');

    expect(getCalls).toBe(2);
    expect(all?.summaries).toHaveLength(2);
    expect(week?.summaries).toHaveLength(5);
  });

  it('does not hand a mutating writer the cached instance', async () => {
    await writeSummaryCache(summaries(3), 'all');

    // A writer takes its own copy, mutates it (as both refresh routes do),
    // and abandons it without writing -- a failed tick. Readers must be
    // unaffected, before and after.
    const before = await readSummaryCache('all');
    const writer = await readSummaryCache('all', { bypassMemory: true });
    (writer!.summaries as unknown as Summary[])[0].mergedPRs = 9999;

    expect((before!.summaries as unknown as Summary[])[0].mergedPRs).not.toBe(9999);
    const after = await readSummaryCache('all');
    expect((after!.summaries as unknown as Summary[])[0].mergedPRs).not.toBe(9999);
  });

  it('a write refreshes what readers see immediately', async () => {
    await writeSummaryCache(summaries(1), 'all');
    expect((await readSummaryCache('all'))?.summaries).toHaveLength(1);

    await writeSummaryCache(summaries(4), 'all');
    expect((await readSummaryCache('all'))?.summaries).toHaveLength(4);
  });

  it('bypassMemory always reaches KV', async () => {
    await writeSummaryCache(summaries(2), 'all');
    getCalls = 0;
    await readSummaryCache('all', { bypassMemory: true });
    await readSummaryCache('all', { bypassMemory: true });
    expect(getCalls).toBe(2);
  });
});
