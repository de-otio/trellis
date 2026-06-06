import { getSecret } from "@aws-lambda-powertools/parameters/secrets";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

interface DbSecret {
  username: string;
  password: string;
  host: string;
  port: string | number;
  dbname: string;
}

let prisma: PrismaClient | null = null;

/**
 * Build (and cache) a PrismaClient for standalone Lambda handlers.
 *
 * RDS enforces `force_ssl`, so the connection MUST negotiate TLS — otherwise
 * Postgres rejects it with `28000 / no pg_hba.conf entry … no encryption`
 * (surfaced by Prisma as P1010). The request-path client gets this via
 * `DatabaseConnectionManager` (`ssl: { rejectUnauthorized: false }`); Lambda
 * handlers must do the same. Prisma 7 supplies the connection through a pg
 * driver adapter (the old `datasources` constructor option is gone), so the
 * `ssl` option goes on the adapter's pool config.
 *
 * Cached at module scope so warm invocations reuse the client.
 */
export async function getLambdaPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  const { username, password, host, port, dbname } = (await getSecret(
    process.env.DB_SECRET_ARN!,
    { transform: "json" },
  )) as unknown as DbSecret;
  const adapter = new PrismaPg({
    connectionString: `postgresql://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbname}?connection_limit=1`,
    ssl: { rejectUnauthorized: false },
  });
  prisma = new PrismaClient({ adapter });
  return prisma;
}
