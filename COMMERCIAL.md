# Commercial Licensing

Trellis is **dual-licensed**.

## The open-source license (AGPLv3)

The Trellis core — everything under `apps/api` (published as `@de-otio/trellis`)
and the repository as a whole — is licensed under the **GNU Affero General
Public License, version 3 or later (AGPL-3.0-or-later)**. See [`LICENSE`](LICENSE).

The defining feature of the AGPL: **if you run a modified version of Trellis to
provide a service over a network, you must make the complete corresponding
source code of your modified version available to the users of that service**,
under the AGPL. This obligation applies even if you never distribute the
software in the traditional sense — network use counts.

For most users — self-hosting, internal tools, research, or any deployment
where you are willing to share your modifications under the AGPL — the
open-source license is all you need, at no cost.

## The commercial license

If you want to build on Trellis **without** the AGPL's source-disclosure
obligations — for example, to embed it in a proprietary product or to offer a
hosted service whose modifications you do not wish to publish — a separate
**commercial license** is available. The commercial license grants the same
software under terms that do not require you to release your source code.

The copyright holder reserves the right to offer Trellis under terms other than
the AGPL. This is what makes commercial licensing possible, and why all
external contributions are accepted under the Contributor License Agreement
(see [`CLA.md`](CLA.md)).

To discuss a commercial license, contact:

> **Richard Myers (trading as de-otio)**
> <licensing@de-otio.org>

## The extension API is permissive (MIT)

The extension SDK — `@de-otio/trellis-extension-api`
([`packages/extension-api`](packages/extension-api)) — is licensed under the
**MIT License**, not the AGPL. You may build and distribute extensions against
this interface, including proprietary ones, without triggering any AGPL
obligation. Only the Trellis core itself is copyleft.
