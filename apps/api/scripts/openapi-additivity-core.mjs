/**
 * OpenAPI additivity classifier — PURE module, no I/O, no process.exit.
 *
 * Compares two OpenAPI 3.1-ish documents (as produced by
 * `src/lib/openapi/generator.ts`, or any structurally-similar synthetic
 * fixture) and classifies every difference as either BREAKING or an
 * additive OK-but-snapshot-stale change.
 *
 * WOKEN (plan 034 lane B, was: KNOWN LIMITATION, plan §2.3 / §4-T2): the
 * generator used to emit every path/method/parameter with an empty `{}`
 * schema, which meant only three of the rules below could ever fire against
 * real output (path removed, method removed, parameter removed/made
 * required). As of lane B, a route that declares `requestSchema` /
 * `responseSchema` (Zod) emits a real, `$ref`-ed JSON Schema instead — so
 * the other four rules (response field removed, field type changed,
 * required-request-field added, enum value removed) can now fire against
 * REAL generator output too, for any route that has adopted the richer
 * fields. They remain untested against real output for routes that
 * haven't (adoption is progressive, per the generator's module doc); the
 * unit tests below and in `test/unit/openapi/additivity-gate.test.ts` cover
 * both the pure-classifier and real-generator paths.
 *
 * All eight rules:
 *   1. path removed                                 -> BREAKING
 *   2. method removed                                -> BREAKING
 *   3. parameter removed OR made required             -> BREAKING
 *   4. response field removed                         -> BREAKING
 *   5. field type changed                              -> BREAKING
 *   6. required request-body field added               -> BREAKING
 *   7. enum value removed                               -> BREAKING
 *   8. a required security scope added to an operation   -> BREAKING
 *      (a client that worked yesterday must not need a new grant today);
 *      a scope REMOVED from an operation's `security` is additive.
 * Pure additions (new path, new method, new optional param, new optional
 * response field, new enum value, relaxing a required field to optional,
 * a scope removed from `security`) are reported as `additions` —
 * informational, non-blocking.
 */

/**
 * @typedef {{ rule: string, path: string, method?: string, detail: string }} Finding
 */

const JSON_MEDIA_TYPE = "application/json";

/** @returns {Record<string, unknown>} */
function safeSchema(schema) {
  return schema && typeof schema === "object" ? schema : {};
}

function getContentSchema(contentHolder) {
  const content = contentHolder && contentHolder.content;
  if (!content || typeof content !== "object") return undefined;
  const mediaType = content[JSON_MEDIA_TYPE];
  return mediaType ? safeSchema(mediaType.schema) : undefined;
}

/**
 * Resolve a local JSON-pointer `$ref` (e.g. `#/components/schemas/FooRequest`)
 * against its own document. The generator emits every request/response body
 * as a single top-level `$ref` into `components.schemas` (plan 034 lane B) —
 * without this, the classifier only ever sees `{ $ref: "..." }` on both
 * sides of a comparison and the four schema-shape rules never fire against
 * real output. Follows nested `$ref`s too (bounded, in case a reused Zod
 * schema instance makes `z.toJSONSchema` emit internal `$defs` refs).
 */
function resolveRef(doc, ref, depth = 0) {
  if (depth > 10 || typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => decodeURIComponent(s).replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = doc;
  for (const segment of segments) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[segment];
  }
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    return resolveRef(doc, node.$ref, depth + 1);
  }
  return node;
}

/** @returns {Record<string, unknown>} */
function resolveSchema(doc, schema) {
  const s = safeSchema(schema);
  if (typeof s.$ref === "string") {
    const resolved = resolveRef(doc, s.$ref);
    return resolved !== undefined ? safeSchema(resolved) : s;
  }
  return s;
}

/**
 * Recursively compare two JSON-schema-like objects and push findings.
 * Handles: object properties + required[], array items, enum[], type.
 * `oldDoc`/`newDoc` are the full documents each schema was pulled from, so
 * a `$ref` (at the top level or nested) can be resolved against the right
 * `components.schemas`.
 */
function compareSchemas(oldSchema, newSchema, pointer, breaking, additions, oldDoc, newDoc) {
  const oldS = resolveSchema(oldDoc, oldSchema);
  const newS = resolveSchema(newDoc, newSchema);

  // Rule 5: field type changed (only meaningful once both sides declare a type)
  if (oldS.type !== undefined && newS.type !== undefined && oldS.type !== newS.type) {
    breaking.push({
      rule: "field-type-changed",
      path: pointer,
      detail: `${pointer}: type changed from "${oldS.type}" to "${newS.type}"`,
    });
  }

  // Rule 7: enum value removed
  if (Array.isArray(oldS.enum)) {
    const newEnum = Array.isArray(newS.enum) ? newS.enum : [];
    for (const value of oldS.enum) {
      if (!newEnum.includes(value)) {
        breaking.push({
          rule: "enum-value-removed",
          path: pointer,
          detail: `${pointer}: enum value ${JSON.stringify(value)} removed`,
        });
      }
    }
    for (const value of newEnum) {
      if (!oldS.enum.includes(value)) {
        additions.push({
          rule: "enum-value-added",
          path: pointer,
          detail: `${pointer}: enum value ${JSON.stringify(value)} added`,
        });
      }
    }
  }

  // Object properties / required
  const oldProps = oldS.properties && typeof oldS.properties === "object" ? oldS.properties : undefined;
  const newProps = newS.properties && typeof newS.properties === "object" ? newS.properties : undefined;

  if (oldProps || newProps) {
    const oldRequired = new Set(Array.isArray(oldS.required) ? oldS.required : []);
    const newRequired = new Set(Array.isArray(newS.required) ? newS.required : []);
    const oldKeys = oldProps ? Object.keys(oldProps) : [];
    const newKeys = newProps ? Object.keys(newProps) : [];

    for (const key of oldKeys) {
      if (!newProps || !(key in newProps)) {
        // Rule 4: response field removed. (Also covers a request-body field
        // removed, which is not one of the seven named rules but is a safe
        // BREAKING classification either way.)
        breaking.push({
          rule: "field-removed",
          path: `${pointer}.${key}`,
          detail: `${pointer}.${key}: field removed`,
        });
        continue;
      }
      compareSchemas(oldProps[key], newProps[key], `${pointer}.${key}`, breaking, additions, oldDoc, newDoc);
    }

    for (const key of newKeys) {
      if (!oldProps || !(key in oldProps)) {
        additions.push({
          rule: "field-added",
          path: `${pointer}.${key}`,
          detail: `${pointer}.${key}: field added${newRequired.has(key) ? " (required)" : ""}`,
        });
      }
    }

    // Rule 6: required request-body field added (a field that exists on both
    // sides, or is brand new, becoming required where it previously was not).
    for (const key of newRequired) {
      if (!oldRequired.has(key)) {
        breaking.push({
          rule: "required-field-added",
          path: `${pointer}.${key}`,
          detail: `${pointer}.${key}: made required (was not required before)`,
        });
      }
    }
    for (const key of oldRequired) {
      if (!newRequired.has(key)) {
        additions.push({
          rule: "required-field-relaxed",
          path: `${pointer}.${key}`,
          detail: `${pointer}.${key}: no longer required`,
        });
      }
    }
  }

  // Array items
  if (oldS.items || newS.items) {
    compareSchemas(oldS.items, newS.items, `${pointer}[]`, breaking, additions, oldDoc, newDoc);
  }
}

function compareParameters(oldParams, newParams, pointer, breaking, additions) {
  const oldList = Array.isArray(oldParams) ? oldParams : [];
  const newList = Array.isArray(newParams) ? newParams : [];
  const newByName = new Map(newList.map((p) => [`${p.in}:${p.name}`, p]));
  const oldByName = new Map(oldList.map((p) => [`${p.in}:${p.name}`, p]));

  for (const p of oldList) {
    const key = `${p.in}:${p.name}`;
    const match = newByName.get(key);
    if (!match) {
      // Rule 3a: parameter removed
      breaking.push({
        rule: "parameter-removed",
        path: pointer,
        detail: `${pointer}: parameter "${p.name}" (${p.in}) removed`,
      });
      continue;
    }
    if (!p.required && match.required) {
      // Rule 3b: parameter made required
      breaking.push({
        rule: "parameter-made-required",
        path: pointer,
        detail: `${pointer}: parameter "${p.name}" (${p.in}) made required`,
      });
    }
    if (p.required && !match.required) {
      additions.push({
        rule: "parameter-relaxed",
        path: pointer,
        detail: `${pointer}: parameter "${p.name}" (${p.in}) no longer required`,
      });
    }
  }

  for (const p of newList) {
    const key = `${p.in}:${p.name}`;
    if (!oldByName.has(key)) {
      additions.push({
        rule: "parameter-added",
        path: pointer,
        detail: `${pointer}: parameter "${p.name}" (${p.in}) added${p.required ? " (required)" : ""}`,
      });
    }
  }
}

/**
 * Flatten an OpenAPI `security` array (a list of "OR" requirement objects,
 * each mapping a scheme name to an "AND" list of required scopes) down to
 * the set of scope strings required by ANY of the requirements. This is a
 * simplification of the full OR/AND semantics, but it is the right
 * simplification for an additivity gate: we care whether a *new* scope
 * string can now block a request that used to succeed, not the exact
 * boolean structure of how it's required.
 *
 * @returns {string[]}
 */
function flattenSecurityScopes(security) {
  if (!Array.isArray(security)) return [];
  const scopes = [];
  for (const requirement of security) {
    if (!requirement || typeof requirement !== "object") continue;
    for (const scheme of Object.keys(requirement)) {
      const list = requirement[scheme];
      if (Array.isArray(list)) scopes.push(...list);
    }
  }
  return scopes;
}

/**
 * Rule 8: a scope newly required on an operation is BREAKING (a client that
 * worked yesterday, without that grant, now fails); a scope no longer
 * required is additive (strictly less is asked of the client).
 */
function compareSecurity(oldSecurity, newSecurity, pointer, breaking, additions) {
  const oldScopes = new Set(flattenSecurityScopes(oldSecurity));
  const newScopes = new Set(flattenSecurityScopes(newSecurity));

  for (const scope of oldScopes) {
    if (!newScopes.has(scope)) {
      additions.push({
        rule: "scope-removed",
        path: pointer,
        detail: `${pointer}: security scope "${scope}" no longer required (additive)`,
      });
    }
  }
  for (const scope of newScopes) {
    if (!oldScopes.has(scope)) {
      breaking.push({
        rule: "scope-added",
        path: pointer,
        detail: `${pointer}: security scope "${scope}" newly required — a client that worked yesterday now needs a new grant`,
      });
    }
  }
}

function compareOperation(oldOp, newOp, pointer, breaking, additions, oldDoc, newDoc) {
  compareParameters(oldOp.parameters, newOp.parameters, pointer, breaking, additions);
  compareSecurity(oldOp.security, newOp.security, pointer, breaking, additions);

  // Request body schema (rule 6 lives inside compareSchemas; also covers
  // request-body field removal / type change symmetrically with responses).
  const oldReqSchema = getContentSchema(oldOp.requestBody);
  const newReqSchema = getContentSchema(newOp.requestBody);
  if (oldReqSchema || newReqSchema) {
    compareSchemas(oldReqSchema, newReqSchema, `${pointer}.requestBody`, breaking, additions, oldDoc, newDoc);
  }

  // Responses
  const oldResponses = oldOp.responses && typeof oldOp.responses === "object" ? oldOp.responses : {};
  const newResponses = newOp.responses && typeof newOp.responses === "object" ? newOp.responses : {};
  for (const status of Object.keys(oldResponses)) {
    const oldRespSchema = getContentSchema(oldResponses[status]);
    const newResp = newResponses[status];
    if (!newResp) {
      // A response status disappearing entirely is not one of the seven
      // named rules, but is a safe additional BREAKING classification.
      breaking.push({
        rule: "response-removed",
        path: `${pointer}.responses.${status}`,
        detail: `${pointer}: response "${status}" removed`,
      });
      continue;
    }
    const newRespSchema = getContentSchema(newResp);
    if (oldRespSchema || newRespSchema) {
      compareSchemas(oldRespSchema, newRespSchema, `${pointer}.responses.${status}`, breaking, additions, oldDoc, newDoc);
    }
  }
  for (const status of Object.keys(newResponses)) {
    if (!(status in oldResponses)) {
      additions.push({
        rule: "response-added",
        path: `${pointer}.responses.${status}`,
        detail: `${pointer}: response "${status}" added`,
      });
    }
  }
}

/**
 * Classify the difference between an old (baseline snapshot) and new
 * (freshly generated) OpenAPI document.
 *
 * @param {{ paths?: Record<string, Record<string, unknown>> }} oldDoc
 * @param {{ paths?: Record<string, Record<string, unknown>> }} newDoc
 * @returns {{ breaking: Finding[], additions: Finding[] }}
 */
export function classify(oldDoc, newDoc) {
  /** @type {Finding[]} */
  const breaking = [];
  /** @type {Finding[]} */
  const additions = [];

  const oldPaths = oldDoc && oldDoc.paths && typeof oldDoc.paths === "object" ? oldDoc.paths : {};
  const newPaths = newDoc && newDoc.paths && typeof newDoc.paths === "object" ? newDoc.paths : {};

  for (const path of Object.keys(oldPaths)) {
    const newPathItem = newPaths[path];
    if (!newPathItem) {
      // Rule 1: path removed
      breaking.push({ rule: "path-removed", path, detail: `${path}: path removed` });
      continue;
    }

    const oldPathItem = oldPaths[path];
    for (const method of Object.keys(oldPathItem)) {
      const newOp = newPathItem[method];
      if (!newOp) {
        // Rule 2: method removed
        breaking.push({
          rule: "method-removed",
          path,
          method,
          detail: `${path} [${method.toUpperCase()}]: method removed`,
        });
        continue;
      }
      compareOperation(oldPathItem[method], newOp, `${path} [${method.toUpperCase()}]`, breaking, additions, oldDoc, newDoc);
    }

    for (const method of Object.keys(newPathItem)) {
      if (!(method in oldPathItem)) {
        additions.push({
          rule: "method-added",
          path,
          method,
          detail: `${path} [${method.toUpperCase()}]: method added`,
        });
      }
    }
  }

  for (const path of Object.keys(newPaths)) {
    if (!(path in oldPaths)) {
      additions.push({ rule: "path-added", path, detail: `${path}: path added` });
    }
  }

  return { breaking, additions };
}
