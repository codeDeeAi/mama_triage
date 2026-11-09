import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePcpnc } from '../../../src/rag/ensureIndex';
import { PCPNC_FILE } from '../../../src/rag/fetchPcpnc';

describe('ensurePcpnc — the corpus has WHO PCPNC however the service was built', () => {
  const quiet = (): void => undefined;

  it('does nothing when the file is already there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ensure-'));
    writeFileSync(join(dir, PCPNC_FILE), 'x');
    const fetcher = jest.fn();
    expect(await ensurePcpnc(dir, fetcher, quiet)).toBe('present');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches it when it is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ensure-'));
    const fetcher = jest.fn(async (d: string) => join(d, PCPNC_FILE));
    expect(await ensurePcpnc(dir, fetcher, quiet)).toBe('fetched');
    expect(fetcher).toHaveBeenCalledWith(dir);
  });

  it('reports a failed download instead of throwing, and says so in the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ensure-'));
    const lines: string[] = [];
    const out = await ensurePcpnc(
      dir,
      async () => {
        throw new Error('hash mismatch');
      },
      (m) => lines.push(m),
    );
    expect(out).toBe('failed');
    expect(lines.join('\n')).toMatch(/could not be fetched.*hash mismatch/);
  });
});
