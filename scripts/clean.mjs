import { rm } from "node:fs/promises"

for (const path of ["dist", "frontend/dist"]) await rm(path, { recursive: true, force: true })
