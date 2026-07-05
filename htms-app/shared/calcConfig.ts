/**
 * Builds a CalcConfig from the active rate version + fuel series in the DB.
 * Cached in-memory per warm instance (rates change rarely; cache invalidates
 * naturally on cold start, and the active-version id is part of the cache key).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CalcConfig, FuelWeek } from './calc';
import { DEFAULT_BASE_RATES, DEFAULT_FIDIC, type BaseRates } from './rates';

interface Cached {
  versionId: string;
  cfg: CalcConfig;
  at: number;
}
let cache: Cached | null = null;
const TTL_MS = 5 * 60 * 1000;

export async function loadCalcConfig(db: SupabaseClient): Promise<CalcConfig> {
  const { data: ver } = await db
    .from('rate_versions')
    .select('id')
    .eq('is_active', true)
    .single();
  const versionId = ver?.id ?? 'default';

  if (cache && cache.versionId === versionId && Date.now() - cache.at < TTL_MS) {
    return cache.cfg;
  }

  // FIDIC params
  const { data: fp } = await db
    .from('fidic_params')
    .select('a,b,c,w_old,w_new,f_old')
    .eq('rate_version_id', versionId)
    .single();
  const fidic = fp
    ? { a: +fp.a, b: +fp.b, c: +fp.c, Wo: +fp.w_old, Wn: +fp.w_new, Fo: +fp.f_old }
    : DEFAULT_FIDIC;

  // Base rates
  const { data: rateRows } = await db
    .from('rates')
    .select('item_key, base_rate')
    .eq('rate_version_id', versionId);
  const baseRates: BaseRates = { ...DEFAULT_BASE_RATES };
  for (const r of rateRows ?? []) {
    if (r.item_key in baseRates) {
      (baseRates as unknown as Record<string, number>)[r.item_key] = Number(r.base_rate);
    }
  }

  // Fuel series
  const { data: fuelRows } = await db
    .from('weekly_fuel')
    .select('week_start, price_per_litre')
    .order('week_start', { ascending: true });
  const fuelSeries: FuelWeek[] = (fuelRows ?? []).map((f) => ({
    weekStart: f.week_start,
    price: Number(f.price_per_litre),
  }));

  const cfg: CalcConfig = { fidic, baseRates, fuelSeries };
  cache = { versionId, cfg, at: Date.now() };
  return cfg;
}
