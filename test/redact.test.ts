import { describe, expect, it } from "vitest";
import { encode } from "@toon-format/toon";
import { REDACTED, redact } from "../src/lib/redact.js";

// Synthetic versions of the response shapes that carry credentials.
const FAKE_JWT = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2ln";

describe("redact", () => {
  it("redacts a storage account keys list", () => {
    const out = redact({
      keys: [
        { keyName: "key1", value: "c3ludGhldGljLWtleS1vbmU=", permissions: "FULL" },
        { keyName: "key2", value: "c3ludGhldGljLWtleS10d28=", permissions: "FULL" },
      ],
    });
    expect(out.keys).toEqual([
      { keyName: "key1", value: REDACTED, permissions: "FULL" },
      { keyName: "key2", value: REDACTED, permissions: "FULL" },
    ]);
  });

  it("redacts Cosmos DB keys by name", () => {
    expect(
      redact({ primaryMasterKey: "abc", secondaryMasterKey: "def", primaryReadonlyMasterKey: "ghi", name: "cosmos1" }),
    ).toEqual({ primaryMasterKey: REDACTED, secondaryMasterKey: REDACTED, primaryReadonlyMasterKey: REDACTED, name: "cosmos1" });
  });

  it("redacts ACR credentials, including the name/value pairs under passwords", () => {
    expect(
      redact({ username: "registry1", passwords: [{ name: "password", value: "p1" }, { name: "password2", value: "p2" }] }),
    ).toEqual({
      username: "registry1",
      passwords: [{ name: "password", value: REDACTED }, { name: "password2", value: REDACTED }],
    });
  });

  it("redacts name/value pairs only inside passwords or keys arrays", () => {
    expect(redact({ tags: [{ name: "env", value: "prod" }] })).toEqual({ tags: [{ name: "env", value: "prod" }] });
    expect(redact({ keys: [{ name: "k", value: "secret-bytes" }] })).toEqual({ keys: [{ name: "k", value: REDACTED }] });
  });

  it.each([
    "DefaultEndpointsProtocol=https;AccountName=stdemo;AccountKey=Zm9v;EndpointSuffix=example.com",
    "Endpoint=sb://demo.example.com/;SharedAccessKeyName=root;SharedAccessKey=Zm9v",
    "SharedAccessSignature sr=demo&sig=Zm9v&se=1",
    "https://stdemo.blob.example.com/c/b?sv=2022-11-02&se=2030-01-01&sp=r&sig=Zm9v%3D",
    "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    `Authorization: ${FAKE_JWT}`,
    FAKE_JWT,
  ])("redacts the secret-shaped value %#", (value) => {
    expect(redact({ detail: value, list: [value], nested: { deeper: value } })).toEqual({
      detail: REDACTED,
      list: [REDACTED],
      nested: { deeper: REDACTED },
    });
  });

  it.each(["password", "adminPassword", "clientSecret", "accessToken", "connectionString", "sas", "credential", "storageKey", "primaryKeys"])(
    "redacts a string under the key %s",
    (key) => {
      expect(redact({ [key]: "v" })).toEqual({ [key]: REDACTED });
    },
  );

  it("leaves ordinary data, bare `key`, and non-string values alone", () => {
    const input = {
      name: "vm1",
      key: "env",
      keyVaultUri: "https://kv.example.com/",
      tokenEnv: { arm: "AZ_AXI_ARM_TOKEN" },
      passwordRequired: true,
      maxTokens: 5,
      url: "https://management.azure.com/subscriptions?api-version=2022-12-01",
      nothing: null,
      rows: [{ resource: "a" }, { resource: "b" }],
    };
    expect(redact(input)).toEqual(input);
  });

  it("does not mutate its input", () => {
    const input = { keys: [{ keyName: "k", value: "v" }], password: "p" };
    const copy = structuredClone(input);
    redact(input);
    expect(input).toEqual(copy);
  });

  it("keeps secrets out of the rendered TOON", () => {
    const rendered = encode(redact({ keys: [{ keyName: "key1", value: "c2VjcmV0" }], conn: "AccountKey=Zm9v", jwt: FAKE_JWT }));
    for (const leak of ["c2VjcmV0", "Zm9v", "eyJ"]) expect(rendered).not.toContain(leak);
    expect(rendered).toContain(REDACTED);
  });
});
