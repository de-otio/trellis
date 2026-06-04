import { z } from "zod";

const FiniteNumber = z
  .number()
  .refine((v) => Number.isFinite(v), "Must be finite");

export const GPSCoordsSchema = z
  .object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .refine((v) => Number.isFinite(v), "Must be finite"),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .refine((v) => Number.isFinite(v), "Must be finite"),
  })
  .strict();

const ISODateString = z
  .string()
  .datetime()
  .refine((s) => {
    const t = new Date(s).getTime();
    const min = new Date("1900-01-01T00:00:00.000Z").getTime();
    const max = Date.now() + 365 * 24 * 60 * 60 * 1000;
    return t >= min && t <= max;
  }, "Date out of allowed range");

export const EXIFDataSchema = z
  .object({
    make: z.string().max(1024).optional(),
    model: z.string().max(1024).optional(),
    lensModel: z.string().max(1024).optional(),
    software: z.string().max(1024).optional(),

    iso: z.number().int().positive().optional(),
    fNumber: z.number().positive().optional(),
    exposureTime: z.number().positive().optional(),
    focalLength: z.number().positive().optional(),

    dateTimeOriginal: ISODateString.optional(),

    gps: GPSCoordsSchema.optional(),
  })
  .strict();

export const IPTCDataSchema = z
  .object({
    keywords: z.array(z.string().max(64)).max(100).optional(),
    copyrightNotice: z.string().max(1024).optional(),
    creator: z.string().max(1024).optional(),
    caption: z.string().max(1024).optional(),
  })
  .strict();

export const VideoMetadataSchema = z
  .object({
    // Basic, Workers-friendly fields (best-effort)
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    duration: z.number().int().positive().optional(),

    dateTaken: ISODateString.optional(),
    gps: GPSCoordsSchema.optional(),

    codec: z.string().max(128).optional(),
    bitrate: z.number().int().positive().optional(),
  })
  .strict();

export const MetadataVisibilitySchema = z
  .object({
    metadataVisible: z.boolean(),
    locationVisible: z.boolean(),
  })
  .strict();

export type EXIFData = z.infer<typeof EXIFDataSchema>;
export type IPTCData = z.infer<typeof IPTCDataSchema>;
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;
export type MetadataVisibility = z.infer<typeof MetadataVisibilitySchema>;
