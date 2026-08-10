/**
 * One camera loop, two formats.
 *
 * The vault speaks its own wire (envelope.ts) to its own companion and BC-UR
 * (ur.ts) to everybody else. A person holding a phone should not have to know
 * which, or be asked to pick from a menu before pointing it at a screen. The
 * two are trivially distinguishable from the first characters, so this routes
 * each frame to the collector that owns it and keeps both going at once.
 *
 * Keeping both alive rather than locking onto the first format seen is
 * deliberate. A half-finished scan of one animation should not stop somebody
 * walking over to a different wallet and scanning that instead; the collectors
 * are independent, and whichever completes first is the answer.
 */

import { Collector, type PayloadKind } from './envelope';
import { UrCollector, urPayloadBytes } from './ur';

export type WireFormat = 'labyrinth' | 'ur';

export interface ScanProgress {
  /** Which wire the last usable frame came from, null before any. */
  format: WireFormat | null;
  /** Frames of this payload gathered so far, and how many there are. */
  have: number;
  total: number;
  /** The payload, once a complete one has been assembled and verified. */
  payload: Uint8Array | null;
  /** What it is: a payload kind for our wire, a UR type for BC-UR. */
  kind: PayloadKind | string | null;
  problem?: string;
}

/**
 * Which format a frame is, from its prefix alone.
 *
 * Cheap enough to run on every frame of a camera preview, and it means a wifi
 * code or a URL costs one string comparison rather than two parse attempts.
 */
export function formatOf(text: string): WireFormat | null {
  const raw = String(text ?? '').trim();
  if (/^LV\d+:/.test(raw)) return 'labyrinth';
  if (/^ur:/i.test(raw)) return 'ur';
  return null;
}

export class Scanner {
  private own = new Collector();
  private ur = new UrCollector();

  /**
   * Offer whatever the camera just read.
   *
   * A BC-UR payload is handed back unwrapped: `ur:crypto-psbt` carries its
   * PSBT inside a CBOR byte string, and a caller that wanted to think about
   * CBOR would not be calling this. A UR type whose contents are not a plain
   * byte string is reported with a null payload rather than a guess at which
   * slice of it was meant.
   */
  offer(text: string): ScanProgress {
    const format = formatOf(text);
    if (format === null) {
      return { format: null, have: 0, total: 0, payload: null, kind: null, problem: 'That is not a code this device reads.' };
    }

    if (format === 'labyrinth') {
      const progress = this.own.offer(text);
      const out: ScanProgress = {
        format,
        have: progress.have,
        total: progress.total,
        payload: progress.payload,
        kind: progress.payload ? progress.kind : null,
      };
      if (progress.problem !== undefined) out.problem = progress.problem;
      return out;
    }

    const progress = this.ur.offer(text);
    const payload = progress.cbor ? urPayloadBytes(progress.cbor) : null;
    const out: ScanProgress = {
      format,
      have: progress.have,
      total: progress.total,
      payload,
      kind: progress.cbor ? progress.type : null,
    };
    if (progress.problem !== undefined) out.problem = progress.problem;
    if (progress.cbor && payload === null) {
      out.problem = `That is a ${progress.type} code, which this device cannot read yet.`;
    }
    return out;
  }

  reset(): void {
    this.own.reset();
    this.ur.reset();
  }
}
