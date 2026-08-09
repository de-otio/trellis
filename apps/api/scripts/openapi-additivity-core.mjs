/**
 * OpenAPI additivity classifier — PURE module, no I/O, no process.exit.
 *
 * Compares two OpenAPI 3.1-ish documents (as produced by
 * `src/lib/openapi/generator.ts`, or any structurally-similar synthetic
 * fixture) and classifies every difference as either BREAKING or an
 * additive OK-but-snapshot-stale change.
 *
 * KNOWN LIMITATION (plan §2.3 / §4-T2): the current generator emits every
 * path/method/parameter with an empty `{}` schema and no `enum`/`required`
 * detail on response bodies. That means, against REAL generator output,
 * only three of the seven rules below can ever fire in practice:
 *   - path removed
 *   - method removed
 *   - parameter removed / made required
 * The other four (response field removed, field type changed,
 * required-request-field added, enum value removed) are dormant on real
 * output today — they are exercised here only against SYNTHETIC fixtures
 * in the unit tests, anticipating a future generator that emits real Zod
 * -> JSON-schema detail. Do not attempt to make them fire on
 * `openapi.snapshot.json` as it stands; that would require generator
 * changes out of this task's scope.
 *
 * All seven rules:
 *   1. path removed                              -> BREAKING
 *   2. method removed                             -> BREAKING
 *   3. parameter removed OR made required          -> BREAKING
 *   4. response field removed                      -> BREAKING
 *   5. field type changed                           -> BREAKING
 *   6. required request-body field added            -> BREAKING
 *   7. enum value removed                           -> BREAKING
 * Pure additions (new path, new method, new optional param, new optional
 * response field, new enum value, relaxing a required field to optional)
 * are reported as `additions` — informational, non-blocking.
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
 * Recursively compare two JSON-schema-like objects and push findings.
 * Handles: object properties + required[], array items, enum[], type.
 */
function compareSchemas(oldSchema, newSchema, pointer, breaking, additions) {
  const oldS = safeSchema(oldSchema);
  const newS = safeSchema(newSchema);

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
      compareSchemas(oldProps[key], newProps[key], `${pointer}.${key}`, breaking, additions);
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
    compareSchemas(oldS.items, newS.items, `${pointer}[]`, breaking, additions);
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

function compareOperation(oldOp, newOp, pointer, breaking, additions) {
  compareParameters(oldOp.parameters, newOp.parameters, pointer, breaking, additions);

  // Request body schema (rule 6 lives inside compareSchemas; also covers
  // request-body field removal / type change symmetrically with responses).
  const oldReqSchema = getContentSchema(oldOp.requestBody);
  const newReqSchema = getContentSchema(newOp.requestBody);
  if (oldReqSchema || newReqSchema) {
    compareSchemas(oldReqSchema, newReqSchema, `${pointer}.requestBody`, breaking, additions);
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
      compareSchemas(oldRespSchema, newRespSchema, `${pointer}.responses.${status}`, breaking, additions);
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
      compareOperation(oldPathItem[method], newOp, `${path} [${method.toUpperCase()}]`, breaking, additions);
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
