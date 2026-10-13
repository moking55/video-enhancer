import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getClaims = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getClaims } }),
}));

import {
  AuthError,
  authErrorResponse,
  requireOperator,
  requireUser,
  withOperator,
  withUser,
} from "@/lib/auth";
import { apiError, json } from "@/lib/http";

const claims = (email?: string, sub = "user-1") => ({
  data: { claims: { sub, email } },
  error: null,
});

function resetEnv() {
  delete process.env.ALLOWED_EMAILS;
  delete process.env.OPERATOR_EMAILS;
}

describe("requireUser", () => {
  beforeEach(() => {
    process.env.ALLOWED_EMAILS = "owner@example.com";
    delete process.env.OPERATOR_EMAILS;
    getClaims.mockReset();
  });
  afterEach(resetEnv);

  it("throws 401 UNAUTHENTICATED when there are no claims", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    await expect(requireUser()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("throws 401 when getClaims reports an error", async () => {
    getClaims.mockResolvedValue({ data: null, error: new Error("bad jwt") });
    await expect(requireUser()).rejects.toMatchObject({ status: 401 });
  });

  it("throws 403 FORBIDDEN for an email not in the allowlist", async () => {
    getClaims.mockResolvedValue(claims("someone@example.com"));
    await expect(requireUser()).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("throws 403 when the claims have no email", async () => {
    getClaims.mockResolvedValue(claims(undefined));
    await expect(requireUser()).rejects.toMatchObject({ status: 403 });
  });

  it("parses the allowlist: spaces, case and empty items", async () => {
    process.env.ALLOWED_EMAILS = " ,  Owner@Example.com ,, Friend@Example.com,";
    getClaims.mockResolvedValue(claims(" OWNER@example.COM "));
    const owner = await requireUser();
    expect(owner.userId).toBe("user-1");
    expect(owner.supabase).toBeDefined();
    expect(owner.isOperator).toBe(false);

    getClaims.mockResolvedValue(claims("friend@example.com", "user-2"));
    expect((await requireUser()).userId).toBe("user-2");

    getClaims.mockResolvedValue(claims("other@example.com"));
    await expect(requireUser()).rejects.toMatchObject({ status: 403 });
  });

  it("does not match by substring or partial list entry", async () => {
    getClaims.mockResolvedValue(claims("owner@example.co"));
    await expect(requireUser()).rejects.toMatchObject({ status: 403 });
  });

  it("sets isOperator from OPERATOR_EMAILS (case-insensitive)", async () => {
    process.env.ALLOWED_EMAILS = "owner@example.com,friend@example.com";
    process.env.OPERATOR_EMAILS = " Owner@Example.com ";
    getClaims.mockResolvedValue(claims("owner@example.com"));
    expect((await requireUser()).isOperator).toBe(true);
    getClaims.mockResolvedValue(claims("friend@example.com"));
    expect((await requireUser()).isOperator).toBe(false);
  });

  it("treats an operator missing from ALLOWED_EMAILS as allowed", async () => {
    process.env.OPERATOR_EMAILS = "boss@example.com";
    getClaims.mockResolvedValue(claims("boss@example.com"));
    expect(await requireUser()).toMatchObject({ isOperator: true });
  });

  it("throws 500 SERVER_MISCONFIGURED when ALLOWED_EMAILS is unset (never allow all)", async () => {
    delete process.env.ALLOWED_EMAILS;
    getClaims.mockResolvedValue(claims("owner@example.com"));
    await expect(requireUser()).rejects.toMatchObject({
      code: "SERVER_MISCONFIGURED",
      status: 500,
    });
    expect(getClaims).not.toHaveBeenCalled();
  });

  it("throws 500 when ALLOWED_EMAILS is blank or only commas", async () => {
    for (const v of ["   ", " , ,"]) {
      process.env.ALLOWED_EMAILS = v;
      await expect(requireUser()).rejects.toBeInstanceOf(AuthError);
    }
  });

  it("stays 500 even when only OPERATOR_EMAILS is set", async () => {
    delete process.env.ALLOWED_EMAILS;
    process.env.OPERATOR_EMAILS = "owner@example.com";
    getClaims.mockResolvedValue(claims("owner@example.com"));
    await expect(requireUser()).rejects.toMatchObject({ status: 500 });
  });
});

describe("requireOperator", () => {
  beforeEach(() => {
    process.env.ALLOWED_EMAILS = "owner@example.com,friend@example.com";
    process.env.OPERATOR_EMAILS = "owner@example.com";
    getClaims.mockReset();
  });
  afterEach(resetEnv);

  it("returns the user for an operator", async () => {
    getClaims.mockResolvedValue(claims("owner@example.com"));
    expect(await requireOperator()).toMatchObject({ isOperator: true });
  });

  it("throws 403 FORBIDDEN for a normal allowed user", async () => {
    getClaims.mockResolvedValue(claims("friend@example.com"));
    await expect(requireOperator()).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("throws 403 for everyone when OPERATOR_EMAILS is unset", async () => {
    delete process.env.OPERATOR_EMAILS;
    getClaims.mockResolvedValue(claims("owner@example.com"));
    await expect(requireOperator()).rejects.toMatchObject({ status: 403 });
  });
});

describe("withUser / withOperator", () => {
  beforeEach(() => {
    process.env.ALLOWED_EMAILS = "owner@example.com,friend@example.com";
    process.env.OPERATOR_EMAILS = "owner@example.com";
    getClaims.mockReset();
  });
  afterEach(resetEnv);

  it("maps AuthError to the JSON envelope without running the handler", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    const handler = vi.fn();
    const res = await withUser(handler)(new Request("http://x/"), undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(handler).not.toHaveBeenCalled();
  });

  it("withUser runs the handler for an allowed non-operator", async () => {
    getClaims.mockResolvedValue(claims("friend@example.com"));
    const res = await withUser(async ({ userId, isOperator }) =>
      json({ userId, isOperator }),
    )(new Request("http://x/"), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-1", isOperator: false });
  });

  it("withUser returns 403 for an email outside the allowlist", async () => {
    getClaims.mockResolvedValue(claims("stranger@example.com"));
    const handler = vi.fn();
    const res = await withUser(handler)(new Request("http://x/"), undefined);
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("withOperator returns 403 FORBIDDEN for a normal user", async () => {
    getClaims.mockResolvedValue(claims("friend@example.com"));
    const handler = vi.fn();
    const res = await withOperator(handler)(new Request("http://x/"), undefined);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("withOperator runs the handler for an operator", async () => {
    getClaims.mockResolvedValue(claims("owner@example.com"));
    const res = await withOperator(async () => json({ ok: true }))(
      new Request("http://x/"),
      undefined,
    );
    expect(res.status).toBe(200);
  });

  it("returns 500 SERVER_MISCONFIGURED when ALLOWED_EMAILS is unset", async () => {
    delete process.env.ALLOWED_EMAILS;
    const res = await withUser(vi.fn())(new Request("http://x/"), undefined);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("SERVER_MISCONFIGURED");
  });

  it("returns 500 INTERNAL for unexpected errors", async () => {
    getClaims.mockResolvedValue(claims("owner@example.com"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await withUser(async () => {
      throw new Error("boom");
    })(new Request("http://x/"), undefined);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
    spy.mockRestore();
  });

  it("hides misconfiguration details", async () => {
    const res = authErrorResponse(
      new AuthError("SERVER_MISCONFIGURED", "secret detail"),
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret detail");
  });
});

describe("http helpers", () => {
  it("apiError produces the envelope and no-store header", async () => {
    const res = apiError(409, "CONFLICT", "nope", { field: "x" });
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      error: { code: "CONFLICT", message: "nope", details: { field: "x" } },
    });
  });

  it("apiError omits details when not given", async () => {
    const body = await apiError(400, "BAD", "bad").json();
    expect(body).toEqual({ error: { code: "BAD", message: "bad" } });
  });

  it("json defaults to 200 and sets no-store", async () => {
    const res = json({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ ok: true });
    expect(json({}, 201).status).toBe(201);
  });
});
