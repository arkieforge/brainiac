import { describe, expect, it } from "vite-plus/test";

import { pageHost, placement, savedDomain } from "./domains.ts";

describe("domains", () => {
  it("saves a public host name from what the person typed or the page they were on", () => {
    expect(savedDomain("tum.de")).toBe("tum.de");
    expect(savedDomain(" https://Campus.TUM.de/login?next=/ ")).toBe("campus.tum.de");
    expect(savedDomain("campus.tum.de.")).toBe("campus.tum.de");
    // Internationalized names are kept as the browser reaches them.
    expect(savedDomain("münchen.de")).toBe("xn--mnchen-3ya.de");
    for (const bad of ["localhost", "http://tum.de", "10.0.0.1", "https://[::1]/", "", "tum..de", "-tum.de"])
      expect(savedDomain(bad), bad).toBeUndefined();
  });

  it("reads a page's host as the browser would, and only over https", () => {
    expect(pageHost("https://campus.tum.de/apply")).toBe("campus.tum.de");
    // Credentials before the host only ever dress up another host.
    expect(pageHost("https://campus.tum.de@evil.example/apply")).toBeUndefined();
    expect(pageHost("https://campus.tum.de.:443/")).toBe("campus.tum.de");
    expect(pageHost("http://campus.tum.de/")).toBeUndefined();
    expect(pageHost("javascript:alert(1)")).toBeUndefined();
    expect(pageHost("not a url")).toBeUndefined();
  });

  it("fills only on the saved domain or a subdomain of it", () => {
    expect(placement("tum.de", "tum.de")).toBe("on");
    expect(placement("campus.tum.de", "tum.de")).toBe("on");
    expect(placement("tum.de", "campus.tum.de")).not.toBe("on");
    expect(placement("stum.de", "tum.de")).not.toBe("on");
    expect(placement("kth.se", "tum.de")).toBe("elsewhere");
    expect(placement("example.com", "campus.tum.de")).toBe("elsewhere");
  });

  it("names a page that imitates the domain as a lookalike", () => {
    for (const host of [
      "tum.de.login-check.example", // the domain inside another
      "tum-portal.com",
      "campus-tum.de",
      "turn.de", // rn for m
      "tvm.de", // one letter off
      "tmu.de", // two letters swapped
      "xn--tm-xka.de", // a homograph
      "campus.tum.dee",
    ])
      expect(placement(host, "tum.de"), host).toBe("lookalike");
    expect(placement("paypa1.com", "paypal.com")).toBe("lookalike");
    expect(placement("campus.tum.example", "campus.tum.de")).toBe("lookalike");
  });
});
