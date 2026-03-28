import { createYoga, createSchema } from "graphql-yoga"
import { typeDefs } from "./src/schema"
import { resolvers } from "./src/resolvers"
import { prisma } from "./src/lib/prisma"
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
  fetch: yoga.fetch,
})

console.log(`🚀 XSwapo GraphQL API running at http://localhost:${server.port}/graphql`)