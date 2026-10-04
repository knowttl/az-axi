import { describe, expect, it } from "vitest";
import { encode } from "@toon-format/toon";
import { REDACTED, redact } from "../src/lib/redact.js";

// Synthetic versions of the response shapes that carry credentials.
const FAKE_JWT = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2ln";

describe("redact", () => {
  it.each([
    ["https://private-user:private-password@hooks.example.com/alerts?code=private-query#private-fragment", "https://hooks.example.com/alerts"],
    ["HTTPS://private-user@hooks.example.com:8443/alerts", "HTTPS://hooks.example.com:8443/alerts"],
    ["https://private%40user:private%3Apassword@[::1]:8443/alerts?code=private-query", "https://[::1]:8443/alerts"],
    ["sb://private-user:private-password@bus.example.com/queue?code=private-query", "sb://bus.example.com/queue"],
    ["https://hooks.example.com/alerts?code=private-query#private-fragment", "https://hooks.example.com/alerts"],
  ])("strips URI credentials, query and fragment recursively from %s", (uri, safeUri) => {
    const input = { serviceUri: uri, receivers: [{ endpoint: uri }], uris: [uri] };
    expect(redact(input)).toEqual({ serviceUri: safeUri, receivers: [{ endpoint: safeUri }], uris: [safeUri] });
    expect(input.serviceUri).toBe(uri);
    expect(redact(uri)).toBe(safeUri);
  });

  it.each([
    "CPU: overloaded? Restart the worker",
    "Note: incident#123",
    "Note: incident#456",
    "https://example.com/status? Check incident#123",
    "https://[invalid/alerts?code=public#fragment",
    "mailto:oncall@example.com?subject=public#fragment",
    "//example.com/alerts?code=public#fragment",
    "custom:///alerts?code=public#fragment",
  ])("preserves non-network-URI text in descriptions, logs and previews: %s", (text) => {
    const input = { description: text, logs: [{ message: text }], preview: {
      body: { description: text }, diff: [{ before: text, after: text }],
    } };
    expect(redact(input)).toEqual(input);
    expect(redact(text)).toBe(text);
  });

  it("keeps distinct prose values distinct in write preview diffs", () => {
    const input = { diff: [{ before: "Note: incident#123", after: "Note: incident#456" }] };
    expect(redact(input)).toEqual(input);
  });

  it.each([
    { type: "secureString", value: "private-value" },
    { type: "secureObject", value: { field: "private-value" } },
  ])("redacts supplied $type values using inline template declarations", ({ type, value }) => {
    const properties = {
      parameters: { deploymentInput: { value }, region: { value: "westus" } },
      template: { parameters: { deploymentInput: { type }, region: { type: "String" } } },
    };
    const nested = { resources: [{ properties }] };
    expect(redact(nested)).toEqual({ resources: [{ properties: {
      ...properties, parameters: { deploymentInput: { value: REDACTED }, region: { value: "westus" } },
    } }] });
    expect(properties.parameters.deploymentInput.value).toEqual(value);
  });

  it("keeps nested deployment declarations local to their supplied values", () => {
    const nested = { parameters: { input: { value: "nested-private-value" } }, template: { parameters: { input: { type: "secureString" } } } };
    const input = {
      parameters: { input: { value: "outer-public-value" } },
      template: { parameters: { input: { type: "String" } }, resources: [{ properties: nested }] },
    };
    expect(redact(input)).toEqual({
      ...input,
      template: { ...input.template, resources: [{ properties: {
        ...nested, parameters: { input: { value: REDACTED } },
      } }] },
    });
  });

  it.each([
    { name: "adminPassword", type: "String" },
    { name: "clientSecret", type: "Object" },
    { name: "deploymentInput", type: "secureString" },
    { name: "deploymentInput", type: "SecureObject" },
  ])("redacts values, defaults and allowed values for $name of type $type", ({ name, type }) => {
    const parameter = { type, value: { nested: "private-value" }, defaultValue: "private-default", allowedValues: ["private-allowed"] };
    expect(redact({ parameters: { [name]: parameter } })).toEqual({ parameters: {
      [name]: { type, value: REDACTED, defaultValue: REDACTED, allowedValues: REDACTED },
    } });
    expect(parameter.defaultValue).toBe("private-default");
  });

  it("retains ordinary parameter values, defaults and allowed values", () => {
    const input = { parameters: { region: { type: "String", value: "westus", defaultValue: "westus", allowedValues: ["westus", "eastus"] } } };
    expect(redact(input)).toEqual(input);
  });

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

  it.each(["password", "adminPassword", "clientSecret", "accessToken", "connectionString", "sas", "credential", "storageKey", "primaryKeys",
    "authorization", "AUTHORIZATION", "x-api-key", "api-key", "apikey", "ocp-apim-subscription-key", "x-functions-key",
    "custom-key", "custom-token", "custom-secret", "X_API_KEY", "Connection_String", "ADMIN_PASSWORD"])(
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
      url: "https://management.azure.com/subscriptions",
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
