import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CalcError,
  computeHaulageCost,
  escalationFactor,
  fuelPriceForDate,
  type CalcConfig,
  type FuelWeek,
} from '../calc';
import { DEFAULT_BASE_RATES, DEFAULT_FIDIC } from '../rates';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Real weekly fuel series exported from the source workbook.
const rawFuel = JSON.parse(
  readFileSync(join(__dirname, '../../supabase/seed/weekly_fuel.json'), 'utf8'),
) as { week_start: string; price: number }[];
const fuelSeries: FuelWeek[] = rawFuel.map((f) => ({ weekStart: f.week_start, price: f.price }));

const cfg: CalcConfig = {
  fidic: DEFAULT_FIDIC,
  baseRates: DEFAULT_BASE_RATES,
  fuelSeries,
};

describe('fuelPriceForDate (Excel approximate MATCH)', () => {
  it('returns the price of the latest week <= the trip date', () => {
    // Week 2026-02-16 = 12.83; next week is 2026-04-08, so 2026-04-01 maps back to 12.83.
    expect(fuelPriceForDate('2026-04-01', fuelSeries)).toBe(12.83);
    // 2026-05-19 falls after 2026-05-02 (15.77).
    expect(fuelPriceForDate('2026-05-19', fuelSeries)).toBe(15.77);
  });

  it('throws (never returns blank) when the date precedes the series', () => {
    expect(() => fuelPriceForDate('2000-01-01', fuelSeries)).toThrow(CalcError);
  });
});

describe('escalationFactor', () => {
  it('uses live weights a=0.4 b=0.3 c=0.3 (NOT 0.3/0.3/0.4)', () => {
    // At fuel = 12.83: 0.4 + 0.3*(21.77/9.68) + 0.3*(12.83/3.73)
    expect(escalationFactor(12.83)).toBeCloseTo(2.1065936, 6);
  });
});

// Each fixture below is a real row from the production HAULAGE dashboard.
const TOL = 0.1; // sub-cedi rounding tolerance

describe('computeHaulageCost — regression vs real dashboard invoices', () => {
  it('Poles: waybill 12776/12777, Tema→Bolgatanga East, 893km, 120 poles → 41,596.77', () => {
    const r = computeHaulageCost(
      {
        category: 'Poles',
        distanceKm: 893,
        date: '2026-04-01',
        numPoles: 120,
        numStayBlocks: 0,
        numConcretePoles: 0,
        truckSize: 40,
        numTrips: 1,
      },
      cfg,
    );
    expect(r.rates.haulagePerUnitKm).toBeCloseTo(0.38374340410924374, 8);
    expect(r.cost).toBeGreaterThan(41596.77 - TOL);
    expect(r.cost).toBeLessThan(41596.77 + TOL);
  });

  it('Poles: Tema→Tamale Metropolitan, 712km, 120 poles → 36,995.44', () => {
    const r = computeHaulageCost(
      {
        category: 'Poles',
        distanceKm: 712,
        date: '2026-05-19',
        numPoles: 120,
        numStayBlocks: 0,
        numConcretePoles: 0,
        truckSize: 40,
        numTrips: 1,
      },
      cfg,
    );
    expect(r.rates.haulagePerUnitKm).toBeCloseTo(0.4268178722057585, 8);
    expect(r.cost).toBeCloseTo(36995.44, 1);
  });

  it('Material: tema→Sunyani Municipal, 461km, 40ft, 1 trip → 14,763.71', () => {
    const r = computeHaulageCost(
      {
        category: 'Material',
        distanceKm: 461,
        date: '2024-08-16',
        numPoles: 0,
        numStayBlocks: 0,
        numConcretePoles: 0,
        truckSize: 40,
        numTrips: 1,
      },
      cfg,
    );
    expect(r.cost).toBeGreaterThan(14763.71 - 1.5);
    expect(r.cost).toBeLessThan(14763.71 + 1.5);
  });
});
