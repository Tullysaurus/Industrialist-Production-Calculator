import type { RateMode } from '../../types/ui';
import { getRateSuffix } from '../../utils/rateFormatting';
import { formatQuantity } from '../../utils/unitFormatting';

/** A per-second rate in the user's rate mode (raw shows /s). */
export function formatRate(perSecond: number, mode: RateMode): string {
  const mult = mode === 'minute' ? 60 : mode === 'hour' ? 3600 : 1;
  return `${formatQuantity(perSecond * mult, 3)}${getRateSuffix(mode === 'raw' ? 'second' : mode)}`;
}

export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction >= 0.995 && fraction < 1 ? 1 : 0)}%`;
}
