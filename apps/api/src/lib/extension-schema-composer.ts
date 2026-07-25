/**
 * Extension fragment composer — PURE CORE (O-1 design §4.2/§4.3/§12.2, PLAN L2).
 *
 * Merges extension-owned Prisma `.prisma` fragments into the core schema:
 *   1. parse each fragment into a structured model list,
 *   2. VALIDATE every model (all failures throw at compose time — §4.2),
 *   3. inject the reverse relation fields into core models (§4.3 —
 *      load-bearing: the merged schema fails `prisma validate` without them),
 *   4. emit the composed schema text, and
 *   5. generate the T0.5 {@link ExtensionModelRegistryEntry} array that L1 feeds
 *      into `TENANT_SCOPED_MODELS` and L4 iterates for GDPR erasure.
 *
 * This module is a **pure function** (input strings → output strings +
 * diagnostics — no fs, no process, no Prisma client). The process-spawn replay
 * baseline is a separate imperative shell (`extension-schema-baseline.ts`),
 * carved out of the coverage-gated surface by design (PLAN §5).
 *
 * Fragment-parsing is a focused hand-rolled line/brace parser over the subset of
 * the Prisma DSL a fragment may use (model blocks, scalar fields, `@map`,
 * `@relation(... onDelete: ...)`, `@@map`, doc comments) — NOT Prisma's DMMF,
 * which would require the `prisma` CLI + a datasource connection and so could
 * not live in a pure, mock-free, coverage-gated core (A-L2.1).
 */

import type { ExtensionModelRegistryEntry } from "./extension-model-registry.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown for any compose-time validation failure. Every rule in §4.2 fails the
 * whole compose — a bad fragment never reaches a database (R7).
 */
export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

// ---------------------------------------------------------------------------
// Parsed model shape (immutable)
// ---------------------------------------------------------------------------

/** GDPR erasure policy a model declares via its `/// erasure:` doc comment. */
export type ErasurePolicy =
  | { readonly kind: "subject"; readonly field: string }
  | { readonly kind: "cascade-only" }
  | { readonly kind: "none-personal" };

/** A relation (foreign key) from an extension model to another model. */
export interface ParsedRelation {
  /** The relation field name (e.g. "tenant"). */
  readonly field: string;
  /** The target model name (e.g. "Tenant"). */
  readonly target: string;
  /** The scalar FK column field(s) named in `@relation(fields: [...])`. */
  readonly fields: readonly string[];
  /** The `onDelete:` referential action, if declared (e.g. "Cascade"). */
  readonly onDelete: string | null;
}

/** A scalar field on an extension model. */
export interface ParsedField {
  readonly name: string;
  readonly type: string;
  /** The `@map("...")` DB column, if declared. */
  readonly mapColumn: string | null;
}

/** One fully parsed extension-owned model. */
export interface ParsedModel {
  /** The Prisma model name (e.g. "ext_widget__records"). */
  readonly name: string;
  /** The `@@map("...")` table target (e.g. "ext_widget__records"). */
  readonly mapTarget: string | null;
  readonly fields: readonly ParsedField[];
  readonly relations: readonly ParsedRelation[];
  /** The declared erasure policy, or null if the model declared none. */
  readonly erasure: ErasurePolicy | null;
  /** The extension id this model belongs to. */
  readonly extensionId: string;
}

// ---------------------------------------------------------------------------
// Compose input / output (immutable)
// ---------------------------------------------------------------------------

export interface FragmentInput {
  /** The already-validated extension id (charset per extension-validator). */
  readonly extensionId: string;
  /** The raw `.prisma` fragment text (models only). */
  readonly source: string;
}

export interface ComposeInput {
  /** The core `schema.prisma` text (the injection target). */
  readonly coreSchema: string;
  readonly fragments: readonly FragmentInput[];
  /**
   * Core model names an extension FK may target (Q8 item 3 — data-driven, so
   * a new core model like `Connection` becomes allowed with no code change).
   * The tenant/entity/subject FK targets MUST be in this set.
   */
  readonly fkAllowlist: ReadonlySet<string>;
}

export interface ComposedResult {
  /** The composed schema text (core + injected back-relations + fragments). */
  readonly schema: string;
  /** The generated registry (L1 → TENANT_SCOPED_MODELS, L4 → erasure). */
  readonly registry: readonly ExtensionModelRegistryEntry[];
  /** The parsed + validated models, in fragment/declaration order. */
  readonly models: readonly ParsedModel[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The three core models an extension FK may reference for erasure/scoping. */
export const CORE_ERASURE_TARGETS: ReadonlySet<string> = new Set([
  "User",
  "Entity",
  "Tenant",
]);

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

/** Extension-model-name / `@@map`-target shape: `ext_<extId>__<snake>`. */
export function extModelPattern(extensionId: string): RegExp {
  return new RegExp(`^ext_${escapeRegExp(extensionId)}__[a-z][a-z0-9_]*$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse a `.prisma` fragment into its model list. Throws {@link ComposeError}
 * on a structurally malformed fragment (unbalanced braces, a stray block that
 * is not a `model`). Pure: text in, structured models out.
 */
export function parseFragment(
  extensionId: string,
  source: string,
): readonly ParsedModel[] {
  const models: ParsedModel[] = [];
  const lines = source.split("\n");
  let i = 0;
  let pendingDocs: string[] = [];

  while (i < lines.length) {
    const raw = lines[i];

    // Doc comment (`/// ...`) — accumulate for the next model. Checked BEFORE
    // the blank test because stripLineComment() also strips `///`.
    const doc = matchDocComment(raw);
    if (doc !== null) {
      pendingDocs.push(doc);
      i += 1;
      continue;
    }

    const line = stripLineComment(raw).trim();
    if (line === "") {
      // Blank lines / plain `//` comments do not reset a pending doc run.
      i += 1;
      continue;
    }

    const modelMatch = line.match(new RegExp(`^model\\s+(${IDENT})\\s*\\{$`));
    if (modelMatch) {
      const [, name] = modelMatch;
      const { model, next } = parseModelBody(
        extensionId,
        name,
        lines,
        i + 1,
        pendingDocs,
      );
      models.push(model);
      pendingDocs = [];
      i = next;
      continue;
    }

    // Anything else at top level that opens a block is unsupported in a
    // fragment (datasource/generator/enum belong to core, not a fragment).
    if (line.endsWith("{")) {
      throw new ComposeError(
        `fragment for "${extensionId}": only \`model\` blocks are allowed in a fragment, found: ${line}`,
      );
    }
    // Non-block stray content resets any dangling docs.
    pendingDocs = [];
    i += 1;
  }

  return models;
}

interface ModelBodyResult {
  readonly model: ParsedModel;
  readonly next: number;
}

function parseModelBody(
  extensionId: string,
  name: string,
  lines: readonly string[],
  start: number,
  docs: readonly string[],
): ModelBodyResult {
  const fields: ParsedField[] = [];
  const relations: ParsedRelation[] = [];
  let mapTarget: string | null = null;
  let i = start;
  let closed = false;

  for (; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = stripLineComment(raw).trim();
    if (line === "") continue;
    if (line === "}") {
      closed = true;
      i += 1;
      break;
    }

    // Block attributes: @@map / @@index / @@unique / @@id
    if (line.startsWith("@@")) {
      const mapMatch = line.match(/^@@map\(\s*"([^"]+)"\s*\)$/);
      if (mapMatch) mapTarget = mapMatch[1];
      continue;
    }

    // Field line: `<name> <Type>[modifiers] <attrs...>`
    const fieldMatch = line.match(
      new RegExp(`^(${IDENT})\\s+(${IDENT})(\\??|\\[\\])?\\s*(.*)$`),
    );
    if (!fieldMatch) {
      throw new ComposeError(
        `model "${name}": cannot parse field line: ${line}`,
      );
    }
    const [, fieldName, typeName, , attrs] = fieldMatch;

    const relationMatch = attrs.match(/@relation\(([^)]*)\)/);
    if (relationMatch) {
      relations.push(parseRelation(fieldName, typeName, relationMatch[1]));
      // A relation field is not a scalar column; do not record as ParsedField.
      continue;
    }

    const mapMatch = attrs.match(/@map\(\s*"([^"]+)"\s*\)/);
    fields.push({
      name: fieldName,
      type: typeName,
      mapColumn: mapMatch ? mapMatch[1] : null,
    });
  }

  if (!closed) {
    throw new ComposeError(`model "${name}": unbalanced braces (no closing })`);
  }

  return {
    model: {
      name,
      mapTarget,
      fields,
      relations,
      erasure: parseErasureDocs(docs),
      extensionId,
    },
    next: i,
  };
}

function parseRelation(
  field: string,
  target: string,
  inner: string,
): ParsedRelation {
  const fieldsMatch = inner.match(/fields:\s*\[([^\]]*)\]/);
  const fkFields = fieldsMatch
    ? fieldsMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  const onDeleteMatch = inner.match(new RegExp(`onDelete:\\s*(${IDENT})`));
  return {
    field,
    target,
    fields: fkFields,
    onDelete: onDeleteMatch ? onDeleteMatch[1] : null,
  };
}

/**
 * Interpret the accumulated `/// ...` doc comments into an erasure policy.
 * Recognises exactly one directive line:
 *   `/// erasure: subject=<field>` | `cascade-only` | `none-personal`.
 * Returns null when no `erasure:` directive was present (compose then fails —
 * §6 "you cannot forget GDPR").
 */
function parseErasureDocs(docs: readonly string[]): ErasurePolicy | null {
  for (const doc of docs) {
    const m = doc.match(/^erasure:\s*(.+)$/);
    if (!m) continue;
    const spec = m[1].trim();
    if (spec === "cascade-only") return { kind: "cascade-only" };
    if (spec === "none-personal") return { kind: "none-personal" };
    const subjectMatch = spec.match(new RegExp(`^subject=(${IDENT})$`));
    if (subjectMatch) return { kind: "subject", field: subjectMatch[1] };
    throw new ComposeError(
      `unrecognised erasure directive: "/// erasure: ${spec}" (expected subject=<field> | cascade-only | none-personal)`,
    );
  }
  return null;
}

function matchDocComment(raw: string): string | null {
  const m = raw.match(/^\s*\/\/\/\s?(.*)$/);
  return m ? m[1].trim() : null;
}

/** Strip a trailing `//` line comment (but not a `///` doc comment). */
function stripLineComment(raw: string): string {
  const docIdx = raw.indexOf("///");
  if (docIdx !== -1) return raw.slice(0, docIdx);
  const idx = raw.indexOf("//");
  return idx === -1 ? raw : raw.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Validation (pure — throws ComposeError on any failure)
// ---------------------------------------------------------------------------

/**
 * The tenant relation on a model: an FK to `Tenant` with `onDelete: Cascade`.
 * Every model MUST have exactly this (design §6 — per-tenant erasure rides it).
 */
function tenantRelation(model: ParsedModel): ParsedRelation | undefined {
  return model.relations.find((r) => r.target === "Tenant");
}

/**
 * Validate one parsed model against every §4.2 rule. Throws on the first
 * failure (fail compose, never the DB).
 */
export function validateModel(
  model: ParsedModel,
  fkAllowlist: ReadonlySet<string>,
): void {
  const pattern = extModelPattern(model.extensionId);

  // (1) model name AND @@map target both match ext_<extId>__* (task L2).
  if (!pattern.test(model.name)) {
    throw new ComposeError(
      `model "${model.name}": name must match ext_${model.extensionId}__<snake> (blast-radius guard §4.2)`,
    );
  }
  if (model.mapTarget === null) {
    throw new ComposeError(
      `model "${model.name}": missing @@map("ext_${model.extensionId}__...") table mapping`,
    );
  }
  if (!pattern.test(model.mapTarget)) {
    throw new ComposeError(
      `model "${model.name}": @@map target "${model.mapTarget}" must match ext_${model.extensionId}__<snake>`,
    );
  }

  // (2) every @map/relation FK target stays within the allowlist (Q8 item 3).
  for (const rel of model.relations) {
    if (!fkAllowlist.has(rel.target)) {
      throw new ComposeError(
        `model "${model.name}": relation "${rel.field}" targets "${rel.target}", which is not in the FK allowlist [${[...fkAllowlist].sort().join(", ")}]`,
      );
    }
  }

  // (3) every model has a tenant field — FK → Tenant, onDelete: Cascade.
  const tenant = tenantRelation(model);
  if (!tenant) {
    throw new ComposeError(
      `model "${model.name}": missing the mandatory tenant relation (FK → Tenant)`,
    );
  }
  if (tenant.onDelete !== "Cascade") {
    throw new ComposeError(
      `model "${model.name}": tenant relation "${tenant.field}" must be onDelete: Cascade (per-tenant erasure §6), found: ${tenant.onDelete ?? "none"}`,
    );
  }
  if (tenant.fields.length !== 1) {
    throw new ComposeError(
      `model "${model.name}": tenant relation "${tenant.field}" must name exactly one scalar FK field`,
    );
  }

  // (4) erasure declaration is mandatory (§6 — compose fails on silence).
  if (model.erasure === null) {
    throw new ComposeError(
      `model "${model.name}": missing a "/// erasure:" declaration (subject=<field> | cascade-only | none-personal) — you cannot forget GDPR (§6)`,
    );
  }

  // (4a) subject=<field> must name a real scalar field.
  if (model.erasure.kind === "subject") {
    const field = model.erasure.field;
    const exists = model.fields.some((f) => f.name === field);
    if (!exists) {
      throw new ComposeError(
        `model "${model.name}": erasure subject field "${field}" is not a declared scalar field`,
      );
    }
  }

  // (4b) cascade-only ⇒ ALL FKs to User/Entity/Tenant are onDelete: Cascade.
  if (model.erasure.kind === "cascade-only") {
    for (const rel of model.relations) {
      if (CORE_ERASURE_TARGETS.has(rel.target) && rel.onDelete !== "Cascade") {
        throw new ComposeError(
          `model "${model.name}": erasure is cascade-only but relation "${rel.field}" → ${rel.target} is not onDelete: Cascade (found: ${rel.onDelete ?? "none"})`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Back-relation injection (pure — design §4.3, load-bearing)
// ---------------------------------------------------------------------------

/**
 * One back-relation to inject into a core model so the merged schema validates.
 */
interface BackRelation {
  /** The core model receiving the reverse field (e.g. "Entity"). */
  readonly coreModel: string;
  /** The injected list-field line (e.g. `ext_widget__records ext_widget__records[]`). */
  readonly fieldLine: string;
}

/**
 * Derive the reverse relation fields to inject. For every extension→core FK,
 * the core model needs `<field> <ExtModel>[]`. The field name is namespaced
 * `ext_<extId>__<model>` so two extensions never collide and core source is
 * never touched (the injection lives only in the composed artifact).
 */
export function deriveBackRelations(
  models: readonly ParsedModel[],
): readonly BackRelation[] {
  const out: BackRelation[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    for (const rel of model.relations) {
      // Namespaced reverse field: unique per (coreModel, extModel).
      const fieldName = model.name;
      const key = `${rel.target}::${fieldName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        coreModel: rel.target,
        fieldLine: `  ${fieldName} ${model.name}[]`,
      });
    }
  }
  return out;
}

/**
 * Inject the derived back-relations into the core schema text. Throws if a
 * targeted core model is not found (a fragment FK to a non-existent core model —
 * caught here rather than at `prisma validate`).
 */
export function injectBackRelations(
  coreSchema: string,
  backRelations: readonly BackRelation[],
): string {
  let out = coreSchema;
  for (const back of backRelations) {
    const openRe = new RegExp(`(model\\s+${escapeRegExp(back.coreModel)}\\s*\\{)`);
    if (!openRe.test(out)) {
      throw new ComposeError(
        `back-relation injection: core model "${back.coreModel}" not found in the core schema`,
      );
    }
    out = out.replace(openRe, `$1\n${back.fieldLine}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry generation (pure — T0.5 contract)
// ---------------------------------------------------------------------------

/**
 * The Prisma-client delegate key / `$allModels` model key for a model. For an
 * `ext_<id>__<snake>` name the first char is already lowercase, so the delegate
 * key, the camelCase form, and the `$allModels.model` name all coincide — no
 * casing ambiguity for extension-owned models.
 */
export function delegateKey(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

/**
 * Generate the {@link ExtensionModelRegistryEntry} array from validated models.
 * Every model is registered (L1 scopes ALL of them); only `subject`-erasure
 * models carry a non-null `erasureSubjectField` (L4 erases those per subject).
 */
export function generateRegistry(
  models: readonly ParsedModel[],
): readonly ExtensionModelRegistryEntry[] {
  return models.map((model) => {
    const tenant = tenantRelation(model);
    // Validated already, but keep the pure fn total.
    const tenantField = tenant?.fields[0] ?? "tenantId";
    const erasureSubjectField =
      model.erasure?.kind === "subject" ? model.erasure.field : null;
    // FK-tenant-validation fields (security F3/B4): relations to tenant-owned
    // core models the scoped proxy read-before-write-validates. Excludes the
    // tenant relation (that IS the tenantField) and User FKs (a per-SUBJECT
    // erasure linkage, not a tenant check — see CORE_FK_ALLOWLIST in
    // extension-scoped-db.ts). A single-scalar FK only (v1 models are shallow).
    const fkFields = model.relations
      .filter(
        (r) =>
          r.target !== "Tenant" && r.target !== "User" && r.fields.length === 1,
      )
      .map((r) => ({
        field: r.fields[0],
        targetModel: delegateKey(r.target),
        targetTenantField: "tenantId",
      }));
    return {
      model: delegateKey(model.name),
      tenantField,
      erasureSubjectField,
      ...(fkFields.length > 0 ? { fkFields } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Orchestration (pure)
// ---------------------------------------------------------------------------

/**
 * Compose the extension fragments into the core schema. Parses, validates every
 * model (throwing {@link ComposeError} on any §4.2 failure), injects the
 * back-relations (§4.3), emits the composed schema, and generates the registry.
 *
 * Deterministic and idempotent: composing the same inputs twice yields a
 * byte-identical schema, and the emitted registry is stable in declaration
 * order (design §7 "compose is deterministic and idempotent").
 */
export function composeSchema(input: ComposeInput): ComposedResult {
  // Detect duplicate model names across all fragments (name collision → §4.2).
  const seenNames = new Set<string>();
  const models: ParsedModel[] = [];

  for (const fragment of input.fragments) {
    const parsed = parseFragment(fragment.extensionId, fragment.source);
    for (const model of parsed) {
      if (seenNames.has(model.name)) {
        throw new ComposeError(
          `duplicate model name "${model.name}" across fragments (name collision §4.2)`,
        );
      }
      seenNames.add(model.name);
      models.push(model);
    }
  }

  for (const model of models) {
    // A fragment must never redefine a core model.
    if (new RegExp(`model\\s+${escapeRegExp(model.name)}\\s*\\{`).test(input.coreSchema)) {
      throw new ComposeError(
        `model "${model.name}": collides with a core model — a fragment may not redefine core (§4.2)`,
      );
    }
    validateModel(model, input.fkAllowlist);
  }

  const backRelations = deriveBackRelations(models);
  const injected = injectBackRelations(input.coreSchema, backRelations);
  const fragmentBlocks = input.fragments
    .map((f) => f.source.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");

  const schema =
    fragmentBlocks.length > 0
      ? `${injected.trimEnd()}\n\n// ---- composed extension fragments (O-1) ----\n\n${fragmentBlocks}\n`
      : injected;

  return {
    schema,
    registry: generateRegistry(models),
    models,
  };
}
