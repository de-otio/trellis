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
obligations — for example, to build a closed-source extension or vertical
application, to embed it in a proprietary product, or to offer a hosted service
whose code you do not wish to publish — a separate **commercial license** is
available. The commercial license grants the same software under terms that do
not require you to release your source code.

The copyright holder reserves the right to offer Trellis under terms other than
the AGPL. This is what makes commercial licensing possible, and why all
external contributions are accepted under the Contributor License Agreement
(see [`CLA.md`](CLA.md)).

To discuss a commercial license, contact:

> **Richard Myers (trading as de-otio)**
> <licensing@de-otio.org>

## The extension API package is MIT — but running a closed extension is not automatically AGPL-free

The extension SDK — `@de-otio/trellis-extension-api`
([`packages/extension-api`](packages/extension-api)) — is licensed under the
**MIT License**. It contains the *interface* an extension is written against: the
`TrellisExtension` contract, the route and hook types, and the `ExtensionContext`
an extension receives at registration. You may import, use, and redistribute that
package and its type definitions freely, including in closed-source code.

That MIT grant covers the **interface**, not the running system. A Trellis
extension is registered at startup and runs **in the same process as the AGPL
core**, calling into it and exchanging data structures with it. The project's
position is that the running whole is therefore a **combined work** based on the
AGPL core: deploying it as a network service brings it within the scope of the
AGPL, the same as if you had modified the core directly.

In practice:

- **Open-source extensions** — if your extension and the rest of your deployment
  are themselves offered under the AGPL, you are fully compliant at no cost.
  Build freely.
- **Closed / proprietary extensions** — if you want to run a closed-source
  extension or vertical application as a hosted service **without** the AGPL's
  source-disclosure obligation, you need a **commercial license** (see above),
  just as you would to run a modified proprietary core.

Writing an extension against the MIT-licensed types does not, by itself, place
your extension outside the AGPL once it is combined with and run against the
copyleft core.
