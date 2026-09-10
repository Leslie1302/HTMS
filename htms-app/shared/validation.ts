/**
 * Zod validation schemas — the single source of truth for API input contracts.
 * Used on BOTH the client (early feedback) and the server (trust boundary).
 * The server NEVER trusts client-validated data; it re-validates here.
 */
import { z } from 'zod';
import { CATEGORIES } from './rates';
import { AUDIENCE_GROUPS, isValidAudience } from './comments';

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

// Allowed scan upload types/size (defence against malicious uploads).
export const SCAN_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const SCAN_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;

// Transporter editing a raised (generated-stage) invoice. The server recomputes
// every edited line's cost and the invoice total; the client never sends amounts.
export const SCAN_TYPES = ['acknowledgement', 'waybill', 'release_letter'] as const;
export type ScanType = (typeof SCAN_TYPES)[number];
export const scanTypeSchema = z.enum(SCAN_TYPES);

export const scanAddSchema = z.object({
  scanType: scanTypeSchema,
  storagePath: z.string().min(1).max(500),
  mimeType: z.enum(SCAN_ALLOWED_MIME),
  byteSize: z.number().int().positive().max(SCAN_MAX_BYTES),
});
export type ScanAdd = z.infer<typeof scanAddSchema>;

export const invoiceEditLineSchema = z
  .object({
    waybillId: uuid,
    waybillNo: z.string().trim().min(1).max(64).optional(),
    vehicleNo: z.string().trim().max(32).nullable().optional(),
    category: z.enum(CATEGORIES).optional(),
    originId: z.number().int().min(1).max(6).optional(),
    districtId: z.number().int().positive().optional(),
    destinationDistrictIds: z.array(z.number().int().positive()).max(30).optional(),
    numPoles: z.number().int().min(0).max(100000).optional(),
    numStayBlocks: z.number().int().min(0).max(100000).optional(),
    numConcretePoles: z.number().int().min(0).max(100000).optional(),
    truckSize: z.union([z.literal(20), z.literal(40)]).nullable().optional(),
    numTrips: z.number().int().min(1).max(1000).optional(),
    waybillDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    addScans: z.array(scanAddSchema).max(30).default([]),
    removeScanIds: z.array(uuid).max(30).default([]),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'waybillId' && v[k as keyof typeof v] !== undefined), {
    message: 'At least one field to change is required per waybill',
  })
  .refine((v) => v.destinationDistrictIds && v.destinationDistrictIds.length ? !!v.districtId : true, {
    message: 'A primary districtId is required when setting destination districts',
    path: ['districtId'],
  });
export type InvoiceEditLine = z.infer<typeof invoiceEditLineSchema>;

export const invoiceEditSchema = z.object({
  invoiceId: uuid,
  lines: z.array(invoiceEditLineSchema).min(1).max(500),
});
export type InvoiceEdit = z.infer<typeof invoiceEditSchema>;

export const generateDocSchema = z.object({
  invoiceId: uuid,
  type: z.enum(['invoice', 'letter']),
  addressee: z.string().trim().max(200).optional(),
  referenceNo: z.string().trim().max(64).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type GenerateDoc = z.infer<typeof generateDocSchema>;

export const ARCHIVE_DOC_TYPES = ['invoice', 'letter', 'memo', 'signatory'] as const;
export const archiveDocSchema = z.object({
  invoiceId: uuid,
  docType: z.enum(ARCHIVE_DOC_TYPES),
  storagePath: z.string().trim().min(1).max(500),
  label: z.string().trim().max(200).nullable().optional(),
});
export type ArchiveDoc = z.infer<typeof archiveDocSchema>;

export const scanMetaSchema = z.object({
  waybillId: uuid,
  mimeType: z.enum(SCAN_ALLOWED_MIME),
  byteSize: z.number().int().positive().max(SCAN_MAX_BYTES),
});

export const CHECKLIST_ITEMS = [
  'original_waybills',
  'original_acknowledgement_forms',
  'release_letters',
  'contract_agreement_copy',
] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];

export const checklistSchema = z.object(
  Object.fromEntries(CHECKLIST_ITEMS.map((k) => [k, z.boolean()])) as Record<ChecklistItem, z.ZodBoolean>,
);

export const stageTransitionSchema = z
  .object({
    invoiceId: uuid,
    stage: z.string().optional(),
    review: z.enum(['approved', 'disapproved']).optional(),
    note: z.string().max(500).optional(),
  })
  .refine((b) => (b.stage ? !b.review : !!b.review), { message: 'Provide either stage or review, not both' })
  .refine((b) => b.review !== 'disapproved' || !!b.note?.trim(), { message: 'Disapproval requires a note' });

export const commentCreateSchema = z.object({
  invoiceId: uuid,
  audience: z
    .array(z.enum(AUDIENCE_GROUPS))
    .min(1)
    .max(2)
    .refine(isValidAudience, { message: 'Invalid audience combination' }),
  body: z.string().trim().min(1).max(2000),
});
export type CommentCreate = z.infer<typeof commentCreateSchema>;

export const commentResolveSchema = z.object({
  commentId: uuid,
  resolved: z.boolean(),
});
export type CommentResolve = z.infer<typeof commentResolveSchema>;
