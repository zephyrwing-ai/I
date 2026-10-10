import assert from "node:assert/strict";
import test from "node:test";
import { haveSameProviderOrigin } from "../../../shell/shared/provider-origin.js";

test("credential origin matching canonicalizes hosts and default ports but not scheme or non-default ports", () => {
  const saved = "https://api.example.com/v1";
  for (const draft of ["https://API.EXAMPLE.COM:443/v2/", " https://api.example.com/models?limit=10#result "]) {
    assert.equal(haveSameProviderOrigin(saved, draft), true);
  }
  for (const draft of ["http://api.example.com/v1", "https://api.example.com:8443/v1", "https://other.example.com/v1"]) {
    assert.equal(haveSameProviderOrigin(saved, draft), false);
  }
});

test("invalid or non-HTTP addresses never allow saved credential reuse", () => {
  for (const address of ["", "api.example.com/v1", "not a URL", "file:///tmp/provider", "ftp://api.example.com/v1"]) {
    assert.equal(haveSameProviderOrigin("https://api.example.com/v1", address), false);
    assert.equal(haveSameProviderOrigin(address, address), false);
  }
});
