/**
 * Request/response contracts. Inputs are validated before anything touches the
 * network; outputs are validated before they are cached or returned, so a bug
 * in the counter cannot quietly ship a malformed payload to clients.
 */

import { z } from 'zod';
import { isValidOwner, isValidRef, isValidRepo } from './parse-url';

export const OwnerSchema = z.string().refine(isValidOwner, 'invalid owner');
export const RepoSchema = z.string().refine(isValidRepo, 'invalid repo');
export const RefSchema = z.string().refine(isValidRef, 'invalid ref');
export const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/i, 'invalid sha');

export const CountOptionsSchema = z.object({
  includeLockfiles: z.boolean().default(false),
  includeVendored: z.boolean().default(false),
});
export type CountOptions = z.infer<typeof CountOptionsSchema>;

export const CountRequestSchema = z
  .object({
    url: z.string().max(2048).optional(),
    owner: OwnerSchema.optional(),
    repo: RepoSchema.optional(),
    ref: RefSchema.optional(),
    includeLockfiles: z.boolean().optional(),
    includeVendored: z.boolean().optional(),
    /** Skip the cache and recount. */
    fresh: z.boolean().optional(),
  })
  .refine((value) => Boolean(value.url) || (Boolean(value.owner) && Boolean(value.repo)), {
    message: 'Provide either url or owner+repo.',
  });
export type CountRequest = z.infer<typeof CountRequestSchema>;

const LineCountsSchema = z.object({
  lines: z.number().int().nonnegative(),
  code: z.number().int().nonnegative(),
  comment: z.number().int().nonnegative(),
  blank: z.number().int().nonnegative(),
});

export const LanguageRowSchema = LineCountsSchema.extend({
  language: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});

export const CountResultSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  full_name: z.string(),
  sha: z.string(),
  ref: z.string(),
  default_branch: z.string(),
  cached: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  counted_at: z.string(),
  totals: LineCountsSchema.extend({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  by_language: z.array(LanguageRowSchema),
  biggest_files: z.array(
    z.object({ path: z.string(), lines: z.number().int().nonnegative(), language: z.string() }),
  ),
  skipped: z.object({
    binary: z.number().int().nonnegative(),
    vendored: z.number().int().nonnegative(),
    generated: z.number().int().nonnegative(),
    too_large: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
  }),
  repo_meta: z.object({
    stars: z.number().int().nonnegative(),
    size_kb: z.number().int().nonnegative(),
    private: z.boolean(),
    archived: z.boolean(),
    fork: z.boolean(),
    description: z.string().nullable(),
    html_url: z.string(),
  }),
  options: CountOptionsSchema,
  strategy: z.enum(['blobs', 'tarball']),
  languages_without_comment_rules: z.array(z.string()),
  warnings: z.array(z.string()),
  timing: z.object({
    resolve_ms: z.number().int().nonnegative(),
    tree_ms: z.number().int().nonnegative(),
    fetch_ms: z.number().int().nonnegative(),
    parse_ms: z.number().int().nonnegative(),
  }),
  limits: z.object({
    max_files: z.number().int().positive(),
    max_total_bytes: z.number().int().positive(),
    max_file_bytes: z.number().int().positive(),
    hit_file_limit: z.boolean(),
    hit_byte_limit: z.boolean(),
    tree_truncated: z.boolean(),
  }),
  github_requests: z.number().int().nonnegative(),
  rate_limit_remaining: z.number().int().nullable(),
  counter_version: z.string(),
});
export type CountResult = z.infer<typeof CountResultSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
