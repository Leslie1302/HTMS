/**
 * HTMS haulage-cost calculation engine (pure, deterministic, shared client+server).
 *
 * Reproduces the workbook pipeline exactly:
 *   1. distance  = DISTANCE_BASE_KM + chart_distance
 *   2. factor    = a + b·(Wn/Wo) + c·(Fuel_week / Fo)   ← per-trip, fuel-indexed
 *   3. rate      = factor × base_rate   (same factor applied to haulage AND offload)
 *   4. cost      = category branch (Material / Poles / Concrete Poles)
 *
 * Verified against real dashboard invoices (see calc.test.ts):
 *   waybill 12776/12777 → GHS 41,596.77, etc.
 *
 * The engine NEVER silently swallows errors (the workbook's IFERROR(...,"")
 * behaviour). A missing distance or fuel price throws CalcError so the caller
 * can surface *why*, rather than producing a blank/zero invoice.
 */
import { BaseRates, Category, DEFAULT_FIDIC, DISTANCE_BASE_KM, FidicParams } from './rates';

export class CalcError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'CalcError';
    this.code = code;
  }
}

export interface FuelWeek {
  /** ISO date (yyyy-mm-dd) of the week start. */
  weekStart: string;
  /** Diesel price in GHS per litre. */
  price: number;
}

export interface WaybillInput {
  category: Category;
  /** Distance to use, ALREADY including the +30 km base (i.e. the displayed distance). */
  distanceKm: number;
  /** Trip date (yyyy-mm-dd) — selects the fuel week. */
  date: string;
  numPoles: number;
  numStayBlocks: number;
  numConcretePoles: number;
  /** Truck footer: 20 or 40 (used directly as the `O` multiplier for materials). */
  truckSize: 20 | 40;
  numTrips: number;
}

export interface CalcConfig {
  fidic: FidicParams;
  baseRates: BaseRates;
  /** Weekly fuel series; need not be pre-sorted. */
  fuelSeries: FuelWeek[];
}

/** Round to 2 dp using banker-safe half-up at cedi-cent precision. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Step lookup: the price for the latest week whose start is <= the trip date
 * (Excel MATCH(..., 1) / approximate match on a sorted ascending series).
 */
export function fuelPriceForDate(date: string, fuelSeries: FuelWeek[]): number {
  if (!fuelSeries.length) throw new CalcError('Fuel price series is empty', 'NO_FUEL_SERIES');
  const target = date;
  let best: FuelWeek | undefined;
  for (const w of fuelSeries) {
    if (w.weekStart <= target && (!best || w.weekStart > best.weekStart)) best = w;
  }
  if (!best) {
    throw new CalcError(
      `No fuel price on or before ${date} (earliest is ${
        [...fuelSeries].sort((a, b) => a.weekStart.localeCompare(b.weekStart))[0]?.weekStart
      })`,
      'NO_FUEL_FOR_DATE',
    );
  }
  return best.price;
}

/** The FIDIC per-trip escalation multiplier for a given fuel price. */
export function escalationFactor(fuelPrice: number, fidic: FidicParams = DEFAULT_FIDIC): number {
  const { a, b, c, Wo, Wn, Fo } = fidic;
  return a + b * (Wn / Wo) + c * (fuelPrice / Fo);
}

export interface CalcResult {
  fuelPrice: number;
  factor: number;
  /** Escalated rates actually applied (for the invoice line snapshot). */
  rates: {
    haulagePerUnitKm: number; // pole/material/concrete per-km rate used
    offloadFlat: number; // pole/material/concrete offload used
    stayPerKm: number;
    offloadPerStay: number;
  };
  cost: number;
}

/**
 * Compute the haulage cost for one waybill. Pure function — no I/O.
 */
export function computeHaulageCost(input: WaybillInput, cfg: CalcConfig): CalcResult {
  if (!Number.isFinite(input.distanceKm) || input.distanceKm <= 0) {
    throw new CalcError(`Invalid distance: ${input.distanceKm}`, 'BAD_DISTANCE');
  }
  if (input.numTrips < 1) throw new CalcError('Number of trips must be >= 1', 'BAD_TRIPS');

  const fuelPrice = fuelPriceForDate(input.date, cfg.fuelSeries);
  const factor = escalationFactor(fuelPrice, cfg.fidic);
  const r = cfg.baseRates;
  const I = input.distanceKm;

  // Stay-block escalated rates (shared by Poles & Concrete Poles).
  const L = factor * r.stayPerKm;
  const M = factor * r.offloadPerStay;

  let cost: number;
  let haulagePerUnitKm: number;
  let offloadFlat: number;

  switch (input.category) {
    case 'Material': {
      const J = factor * r.materialPerTonKm; // per ton per km
      const K = factor * (input.truckSize === 40 ? r.offloadTruck40 : r.offloadTruck20);
      // (Distance × rate × truckSize + offload) × trips
      cost = (I * J * input.truckSize + K) * input.numTrips;
      haulagePerUnitKm = J;
      offloadFlat = K;
      break;
    }
    case 'Poles': {
      const J = factor * r.polePerKm;
      const K = factor * r.offloadPerPole;
      cost = (J * I + K) * input.numPoles + (L * I + M) * input.numStayBlocks;
      haulagePerUnitKm = J;
      offloadFlat = K;
      break;
    }
    case 'Concrete Poles': {
      const J = factor * r.concretePerKm;
      const K = factor * r.offloadPerConcrete;
      // Concrete poles share the Poles structure but use concrete rates.
      cost =
        (J * I + K) * (input.numConcretePoles || input.numPoles) +
        (L * I + M) * input.numStayBlocks;
      haulagePerUnitKm = J;
      offloadFlat = K;
      break;
    }
    default:
      throw new CalcError(`Unknown category: ${input.category as string}`, 'BAD_CATEGORY');
  }

  return {
    fuelPrice,
    factor,
    rates: { haulagePerUnitKm, offloadFlat, stayPerKm: L, offloadPerStay: M },
    cost: round2(cost),
  };
}

/** Convenience: total distance from a chart (surveyed) distance. */
export function chartToDistance(chartKm: number): number {
  return DISTANCE_BASE_KM + chartKm;
}
