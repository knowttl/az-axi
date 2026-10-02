import { describe, expect, it, vi, beforeEach } from "vitest";
import { AxiError } from "axi-sdk-js";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../src/lib/client.js";
import { isObjectId, resolvePrincipalId, resolvePrincipalNames } from "../src/lib/principals.js";
import type { ResolvedProfile } from "../src/lib/config.js";

const sendMock = vi.mocked(sendRequest);
const SYN = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;

const profile = (): ResolvedProfile => ({
  name: "test",
  source: "implicit",
  auth: "token",
  writeSubscriptions: [],
});

beforeEach(() => {
  sendMock.mockReset();
});

describe("isObjectId", () => {
  it("accepts GUIDs and rejects UPNs", () => {
    expect(isObjectId(SYN(40))).toBe(true);
    expect(isObjectId(SYN(40).toUpperCase())).toBe(true);
    expect(isObjectId("analyst@contoso.com")).toBe(false);
  });
});

describe("resolvePrincipalId", () => {
  it("passes GUIDs through without network", async () => {
    await expect(resolvePrincipalId(profile(), SYN(40))).resolves.toBe(SYN(40));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("resolves a UPN through Graph", async () => {
    sendMock.mockResolvedValue({ status: 200, headers: {}, body: { id: SYN(40) }, clientRequestId: "r" });
    await expect(resolvePrincipalId(profile(), "analyst@contoso.com")).resolves.toBe(SYN(40));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test" }),
      expect.objectContaining({ resource: "graph", method: "GET" }),
    );
  });

  it("asks for the object ID when Graph cannot resolve", async () => {
    sendMock.mockRejectedValue(new AxiError("denied", "FORBIDDEN", ["no"]));
    await expect(resolvePrincipalId(profile(), "analyst@contoso.com")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("resolvePrincipalNames", () => {
  it("maps IDs to display names in one batch", async () => {
    sendMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        value: [
          { id: SYN(40), displayName: "Analyst" },
          { id: SYN(41), userPrincipalName: "owner@contoso.com" },
        ],
      },
      clientRequestId: "r",
    });
    const { names, resolved } = await resolvePrincipalNames(profile(), [SYN(40), SYN(41), SYN(40)]);
    expect(resolved).toBe(true);
    expect(names.get(SYN(40))).toBe("Analyst");
    expect(names.get(SYN(41))).toBe("owner@contoso.com");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1].body).toEqual({ ids: [SYN(40), SYN(41)] });
  });

  it("never throws on Graph failure", async () => {
    sendMock.mockRejectedValue(new AxiError("denied", "FORBIDDEN", ["no"]));
    const { names, resolved } = await resolvePrincipalNames(profile(), [SYN(40)]);
    expect(resolved).toBe(false);
    expect(names.size).toBe(0);
  });

  it("returns an empty map without network for no IDs", async () => {
    const { names, resolved } = await resolvePrincipalNames(profile(), []);
    expect(resolved).toBe(true);
    expect(names.size).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
