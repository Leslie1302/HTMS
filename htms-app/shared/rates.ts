/**
 * HTMS rate card + FIDIC escalation constants.
 *
 * EVERY value here was extracted and verified against the source workbook
 * `Haulage Txn Data.xlsx` (sheets: FORMULA 198.6%, Adjustment Table 198.6%,
 * Weekly-Fuel) and confirmed to reproduce real dashboard invoices to the cent.
 *
 * These are the DEFAULT/baseline values. In production they are stored in the
 * `rate_versions` / `rates` / `fidic_params` tables (versioned, Admin-editable)
 * and read from the database — this file is the seed source of truth and the
 * fallback used by the pure calc engine in tests.
 */

/** FIDIC price-adjustment parameters. NOTE: weights are a=0.4, b=0.3, c=0.3 —
 *  this is what the LIVE workbook formula uses (named ranges assump_a/b/c → col E),
 *  NOT the 0.3/0.3/0.4 stated in the prose context doc. */
export interface FidicParams {
  a: number; // fixed, non-adjustable component
  b: number; // labour (minimum-wage) weight
  c: number; // fuel weight
  Wo: number; // old minimum wage baseline (2018)
  Wn: number; // new minimum wage (2022)
  Fo: number; // old diesel price baseline (GHS/L, July 2018)
}

export const DEFAULT_FIDIC: FidicParams = {
  a: 0.4,
  b: 0.3,
  c: 0.3,
  Wo: 9.68,
  Wn: 21.77,
  Fo: 3.73,
};

/** Base (2018 contract) unit rates in GHS, from Adjustment Table 198.6% col F. */
export interface BaseRates {
  materialPerTonKm: number; // haulage per ton per km (materials)
  offloadTruck40: number; // flat off-loading, 40ft truck (materials)
  offloadTruck20: number; // flat off-loading, 20ft truck (materials)
  polePerKm: number; // haulage per pole per km
  offloadPerPole: number; // off-loading per pole
  stayPerKm: number; // haulage per stay block per km
  offloadPerStay: number; // off-loading per stay block
  concretePerKm: number; // haulage per concrete pole per km
  offloadPerConcrete: number; // off-loading per concrete pole
}

export const DEFAULT_BASE_RATES: BaseRates = {
  materialPerTonKm: 0.34,
  offloadTruck40: 225.42,
  offloadTruck20: 112.69375,
  polePerKm: 0.182163,
  offloadPerPole: 1.8783375,
  stayPerKm: 0.018525,
  offloadPerStay: 0.234,
  concretePerKm: 0.5464875,
  offloadPerConcrete: 5.6350125,
};

/** Fixed adjustment added to every surveyed chart distance (workbook: `30 + chart`). */
export const DISTANCE_BASE_KM = 30;

export const ORIGINS = [
  'Tema',
  'Takoradi',
  'Kumasi',
  'Ntensere',
  'Nsawam',
  'Asante-Akim South',
] as const;
export type Origin = (typeof ORIGINS)[number];

export const CATEGORIES = ['Material', 'Poles', 'Concrete Poles'] as const;
export type Category = (typeof CATEGORIES)[number];
