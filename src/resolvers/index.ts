import { GraphQLScalarType, Kind } from "graphql"
import { queryResolvers } from "./queries"
import { mutationResolvers } from "./mutations"

const DecimalScalar = new GraphQLScalarType({
  name: "Decimal",
  description: "Arbitrary-precision decimal value",
  serialize: (value: any) => value?.toString() ?? null,
  parseValue: (value: any) => value?.toString(),
  parseLiteral: (ast) => (ast.kind === Kind.STRING || ast.kind === Kind.FLOAT || ast.kind === Kind.INT ? ast.value : null),
})

const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "ISO 8601 date-time string",
  serialize: (value: any) => (value instanceof Date ? value.toISOString() : value),
  parseValue: (value: any) => new Date(value),
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? new Date(ast.value) : null),
})

// Merge all resolvers into a single map
export const resolvers = {
  ...queryResolvers,
  ...mutationResolvers,
  Decimal: DecimalScalar,
  DateTime: DateTimeScalar,
}
