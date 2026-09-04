/**
 * Core scope catalog and the single set-inclusion predicate.
 *
 * A **scope** is what a third-party client was granted on behalf of a user.
 * It is a *different authorization axis* from a **capability**
 * (`auth/capabilities.ts`), which is role-derived and tenant-scoped and
 * answers "may this member do this in this tenant". Both must pass; neither
 * implies the other, and the two vocabularies are deliberately kept apart:
 *
 * - scope strings are `<resource>:<verb>` — colon (`posts:write`)
 * - capability strings are `<resource>.<verb>` — dot (`post.create`)
 *
 * The separators differ so that a value from one axis can never silently
 * satisfy a check on the other: `posts.write` is not a scope and
 * {@link hasScope} will not accept it in place of `posts:write`.
 *
 * This module is **declaration only**. Nothing here reads a request, decides
 * an HTTP status, or is wired into the dispatcher; the gate that does
 * (`requireScope`) is built on top of {@link hasScope} and lives in
 * `auth/require.ts`.
 */

/**
 * The scopes core itself defines, with the consent copy shown to the user.
 *
 * The copy lives beside the id on purpose. It is the sentence a person reads
 * before granting access, so it is part of the contract rather than something
 * a consent page invents later. Second person, present tense, describing what
 * the client will be able to do — not what the endpoint is called.
 *
 * Extensions declare their own scopes (with their own copy) through
 * `TrellisExtension.scopes`; core never invents vocabulary for a vertical.
 */
export const CORE_SCOPES = {
  "profile:read": "Read your name, handle and avatar",
  "entities:read": "Read the profiles you can see",
  "entities:write": "Create and update profiles you own",
  "posts:read": "Read posts you can see",
  "posts:write": "Post on your behalf",
  "tenant:read": "Read which space you are in",
  "events:subscribe": "Receive notifications about your data",
} as const;

/** A scope id defined by core. Extension scopes are plain strings. */
export type CoreScope = keyof typeof CORE_SCOPES;

/**
 * What a principal was granted.
 *
 * `"*"` means **an unscoped first-party session** — a cookie or JWT session
 * belonging to the human themselves, which predates scopes entirely and is
 * not narrowed by them. It is deliberately not spelled as "the set of all
 * core scopes": a first-party session must keep passing when a new scope is
 * added to {@link CORE_SCOPES} or by an extension.
 *
 * An **empty set** is the opposite and is a real, reachable state: a token
 * that authenticated but was granted nothing. It passes only a requirement
 * that asks for nothing.
 */
export type ScopeSet = ReadonlySet<string> | "*";

/**
 * The one place set-inclusion is decided.
 *
 * - `"*"` (first-party) satisfies every requirement.
 * - An empty `needed` is satisfied by anything, including the empty set —
 *   "authenticated, no particular scope".
 * - Otherwise every needed scope must be present exactly. Membership is exact
 *   string equality: there is no prefix rule, no wildcard within a scope, and
 *   no separator normalisation, so `posts.write` (the capability separator)
 *   does not satisfy `posts:write`.
 *
 * @param granted what the principal holds (`AuthContext.scopes`)
 * @param needed what the route declared (`Route.scopes`)
 */
export function hasScope(granted: ScopeSet, needed: readonly string[]): boolean {
  if (needed.length === 0) return true;
  if (granted === "*") return true;
  return needed.every((scope) => granted.has(scope));
}
