import { vi } from "vitest";

// next/server's connection() throws outside a Next request scope. Route
// handlers wrapped by withUser call it, so make it a no-op in unit tests.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
