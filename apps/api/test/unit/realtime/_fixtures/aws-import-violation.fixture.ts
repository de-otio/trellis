// NEGATIVE FIXTURE for the no-aws-import test. This file deliberately imports
// an AWS SDK to PROVE the scanner fires. It is NOT a real realtime module — it
// lives under test/_fixtures and is excluded from the production build. The
// no-aws-import test scans BOTH src/lib/realtime/** (must be clean) AND this
// fixture (must trip the rule). If this fixture ever stops tripping the rule,
// the scanner is broken.
//
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export type _ShouldBeFlagged = DynamoDBClient;
