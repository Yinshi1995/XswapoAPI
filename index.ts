import { createYoga, createSchema } from "graphql-yoga"
import { typeDefs } from "./src/schema"
import { resolvers } from "./src/resolvers"
import { prisma } from "./src/lib/prisma"
import { handleRestRequest } from "./src/rest/routes"
import { serveDocsPage } from "./src/docs/serve"
import type { GraphQLContext } from "./src/context"

const yoga = createYoga<{ request: Request }, GraphQLContext>({
  schema: createSchema({ typeDefs, resolvers }),
  context: ({ request }) => {
    const apiKey = request.headers.get("x-api-key") ?? request.headers.get("api-key")
    return { prisma, apiKey }
  },
  graphqlEndpoint: "/graphql",
  landingPage: true,
})

const port = Number(process.env.PORT) || 4000

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)

    // ── API Documentation ──
    if (url.pathname === "/" || url.pathname === "/docs") {
      return serveDocsPage()
    }

    // ── REST API v1 ──
    if (url.pathname.startsWith("/api/v1/")) {
      const res = await handleRestRequest(req, url, prisma)
      if (res) return res
      return new Response(JSON.stringify({ error: "Not found", status: 404 }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    }

    // ── GraphQL ──
    return yoga.fetch(req)
  },
})

console.log(`⚡ XSwapo API running at http://localhost:${server.port}`)
console.log(`   REST:    http://localhost:${server.port}/api/v1/coins`)
console.log(`   GraphQL: http://localhost:${server.port}/graphql`)
console.log(`   Docs:    http://localhost:${server.port}/docs`)