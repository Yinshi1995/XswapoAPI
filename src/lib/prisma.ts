import { PrismaClient } from "@prisma/client"

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

function buildDatasourceUrl(): string {
  const base = process.env.DATABASE_URL ?? ""
  const sep = base.includes("?") ? "&" : "?"
  return `${base}${sep}connection_limit=5&pool_timeout=10`
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: buildDatasourceUrl(),
    log: process.env.NODE_ENV === "production" ? ["error"] : ["query", "error", "warn"],
  })

globalForPrisma.prisma = prisma
