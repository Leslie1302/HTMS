/**
 * Zod validation schemas — the single source of truth for API input contracts.
 * Used on BOTH the client (early feedback) and the server (trust boundary).
 * The server NEVER trusts client-validated data; it re-validates here.
 */
import { z } from 'zod';
import { CATEGORIES } from './rates';

export const uuid = z.string().uuid();

export const waybillCreateSchema = z
  .object({
    transporterId: uuid,
    category: z.enum(CATEGORIES),
    waybillNo: z.string().trim().min(1).max(64),
    vehicleNo: z.string().trim().max(32).optional(),
    originId: z.number().int().min(1).max(6),
    districtId: z.number().int().positive(),
    // Consolidated same-trip drops; cost uses the furthest of these (+ districtId).
    destinationDistrictIds: z.array(z.number().int().positive()).max(30).optional(),
    numPoles: z.number().int().min(0).max(100000).default(0),
    numStayBlocks: z.number().int().min(0).max(100000).default(0),
    numConcretePoles: z.number().int().min(0).max(100000).default(0),
    truckSize: z.union([z.literal(20), z.literal(40)]).optional(),
    numTrips: z.number().int().min(1).max(1000).default(1),
    waybillDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected yyyy-mm-dd'),
    processedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.category === 'Material' && !v.truckSize) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Material requires a truck size', path: ['truckSize'] });
    }
    if (v.category === 'Poles' && v.numPoles < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Poles requires num_poles >= 1', path: ['numPoles'] });
    }
    if (v.category === 'Concrete Poles' && v.numConcretePoles < 1 && v.numPoles < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Concrete Poles requires a pole count',
        path: ['numConcretePoles'],
      });
    }
  });
export type WaybillCreate = z.infer<typeof waybillCreateSchema>;

export const invoiceCreateSchema = z.object({
  transporterId: uuid,
  waybillIds: z.array(uuid).min(1).max(500),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  referenceNo: z.string().trim().max(64).optional(),
});
export type InvoiceCreate = z.infer<typeof invoiceCreateSchema>;

export const generateDocSchema = z.object({
  invoiceId: uuid,
  type: z.enum(['invoice', 'letter']),
  addressee: z.string().trim().max(200).optional(),
  referenceNo: z.string().trim().max(64).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type GenerateDoc = z.infer<typeof generateDocSchema>;

// Allowed scan upload types/size (defence against malicious uploads).
export const SCAN_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const SCAN_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;
export const scanMetaSchema = z.object({
  waybillId: uuid,
  mimeType: z.enum(SCAN_ALLOWED_MIME),
  byteSize: z.number().int().positive().max(SCAN_MAX_BYTES),
});
