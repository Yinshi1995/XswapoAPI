import { readFileSync } from "fs"
import { resolve } from "path"

const html = readFileSync(resolve(import.meta.dir, "index.html"), "utf-8")

export function serveDocsPage(): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}
