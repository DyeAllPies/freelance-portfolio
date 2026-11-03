import { describe, expect, it } from "vitest";
import { formatBRL, nextStatus } from "./orders";

describe("nextStatus", () => {
  it("settles a pending order", () => {
    expect(nextStatus("pending", "paid")).toBe("paid");
    expect(nextStatus("pending", "failed")).toBe("failed");
    expect(nextStatus("pending", "expired")).toBe("expired");
  });

  it("refunds only a paid order", () => {
    expect(nextStatus("paid", "refunded")).toBe("refunded");
    expect(nextStatus("pending", "refunded")).toBeNull();
  });

  it("never undoes a payment when events arrive late or out of order", () => {
    expect(nextStatus("paid", "pending")).toBeNull();
    expect(nextStatus("paid", "failed")).toBeNull();
    expect(nextStatus("paid", "expired")).toBeNull();
    expect(nextStatus("paid", "paid")).toBeNull();
  });

  it("treats failed, expired and refunded as final", () => {
    for (const s of ["failed", "expired", "refunded"] as const) {
      for (const to of ["pending", "paid", "failed", "expired", "refunded"] as const) {
        expect(nextStatus(s, to)).toBeNull();
      }
    }
  });
});

describe("formatBRL", () => {
  it("formats cents as reais", () => {
    // Intl puts a non-breaking space after R$.
    expect(formatBRL(4990).replace(/\s/g, " ")).toBe("R$ 49,90");
  });
});
